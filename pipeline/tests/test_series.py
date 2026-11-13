import contextlib
import hashlib
import io
import itertools
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from hotornot import cli, db
from hotornot.steps import coverage, normalize, series, static_mask

CFG = {
    "regions": [{"id": "delta", "history": "country_files"},
                {"id": "calif", "history": "api"}],
    "firms_api": {"NOAA-20": {"start": "2023-01-01"}},
    "firms_country": {"viirs-jpss1": [2018, 2025]},
}


class Roles(unittest.TestCase):
    def role(self, satellite, day, fire_type=0, masked=False, fill=()):
        return series.role_of(satellite, day, fire_type, masked, set(fill))

    def test_modis_switches_to_overlap_in_2012(self):
        self.assertEqual(self.role("Terra", "2000-11-01"), "modis")
        self.assertEqual(self.role("Aqua", "2011-12-31"), "modis")
        self.assertEqual(self.role("Aqua", "2012-01-01"), "modis_overlap")
        self.assertEqual(self.role("Terra", "2026-11-13", fire_type=None), "modis_overlap")

    def test_vegetation_test_comes_first(self):
        for satellite, day in (("Aqua", "2005-01-01"), ("Terra", "2015-01-01"),
                               ("S-NPP", "2015-01-01"), ("NOAA-20", "2026-11-05")):
            for t in (1, 2, 3):
                self.assertEqual(self.role(satellite, day, fire_type=t), "non_vegetation")
            self.assertEqual(self.role(satellite, day, fire_type=None, masked=True),
                             "static_masked")
        # static_mask holds NRT rows only; an SP row with the same id is still vegetation.
        self.assertEqual(self.role("S-NPP", "2015-01-01", fire_type=0, masked=True), "snpp")

    def test_viirs_roles(self):
        fill = {"2021-09-20", "2026-11-01"}
        self.assertEqual(self.role("S-NPP", "2012-01-20"), "snpp")
        self.assertEqual(self.role("S-NPP", "2026-11-01", fire_type=None), "snpp")
        self.assertEqual(self.role("NOAA-20", "2018-03-31"), "n20_overlap")
        self.assertEqual(self.role("NOAA-20", "2021-09-20", fill=fill), "n20_gapfill")
        self.assertEqual(self.role("NOAA-20", "2021-09-21", fill=fill), "n20_overlap")
        self.assertEqual(self.role("NOAA-20", "2026-11-01", fill=fill), "n20_gapfill")
        self.assertEqual(self.role("NOAA-20", "2026-11-02", fire_type=None), "n20")

    def test_snpp_after_the_switch_is_an_error(self):
        with self.assertRaises(ValueError):
            self.role("S-NPP", "2026-11-02", fire_type=None)

    def test_in_series_roles(self):
        self.assertEqual(series.IN_SERIES, {"modis", "snpp", "n20_gapfill", "n20"})
        self.assertEqual(set(series.WEIGHTED), {"snpp", "n20_gapfill", "n20_overlap", "n20"})


class Pool(unittest.TestCase):
    def test_levels(self):
        num = {3: 66, 6: 20, 7: 20, 8: 20}
        den = {3: 30, 6: 5, 7: 10, 8: 25}
        out = series.pool(num, den, num)
        self.assertEqual(out[3], (2.2, "region_month"))
        self.assertEqual(out[2], (2.2, "pooled_3month"))
        self.assertEqual(out[4], (2.2, "pooled_3month"))
        self.assertEqual(out[7], (1.5, "pooled_3month"))
        for m in (1, 5, 6, 8, 9, 12):
            self.assertEqual(out[m], (1.8, "region_year"))

    def test_pooling_wraps_the_year(self):
        num = {12: 30, 1: 10, 2: 20, 6: 10}
        out = series.pool(num, {12: 10, 1: 10, 2: 10, 6: 20}, num)
        self.assertEqual(out[1], (2.0, "pooled_3month"))
        self.assertEqual(out[12], (1.4, "region_year"))

    def test_threshold_is_inclusive_and_needs_a_denominator(self):
        out = series.pool({5: 50, 6: 60}, {5: 25, 6: 0}, {5: 50, 6: 60})
        self.assertEqual(out[5], (2.0, "region_month"))
        self.assertEqual(out[6], (110 / 25, "pooled_3month"))
        out = series.pool({5: 49}, {5: 7}, {5: 49})
        self.assertEqual(out[5], (7.0, "region_year"))
        self.assertEqual(series.pool({5: 50}, {5: 25}, {5: 50}, min_count=51)[5][1],
                         "region_year")

    def test_nothing_to_divide_by(self):
        with self.assertRaises(ValueError):
            series.pool({1: 100}, {}, {1: 100})


class Helpers(unittest.TestCase):
    def test_observed(self):
        cov = series.Coverage({("r", "S-NPP"): {"d1": 3, "d2": 0, "d3": None, "d4": None}},
                              {("r", "S-NPP"): {"d2", "d3", "d5"}})
        self.assertTrue(cov.observed("r", "S-NPP", "d1"))
        self.assertFalse(cov.observed("r", "S-NPP", "d2"))
        self.assertTrue(cov.observed("r", "S-NPP", "d3"))
        self.assertFalse(cov.observed("r", "S-NPP", "d4"))
        self.assertTrue(cov.observed("r", "S-NPP", "d5"))
        self.assertFalse(cov.observed("r", "S-NPP", "d6"))
        self.assertFalse(cov.observed("r", "NOAA-20", "d1"))

    def test_gapfill_days(self):
        granules = {(r, "S-NPP"): {"2018-03-31": 0, "2018-04-01": 0, "2022-07-30": 0,
                                   "2023-01-01": 0, "2023-01-02": 4, "2023-01-03": None,
                                   "2026-11-01": 0}
                    for r in ("delta", "calif")}
        delta, calif = CFG["regions"]
        self.assertEqual(series.gapfill_days(granules, delta, CFG),
                         {"2018-04-01", "2022-07-30", "2023-01-01", "2026-11-01"})
        self.assertEqual(series.gapfill_days(granules, calif, CFG), {"2023-01-01", "2026-11-01"})

    def test_id_ranges_tile_every_id(self):
        def bucket_of(hid):
            hits = []
            for b in range(256):
                where, params = series.id_range(b)
                lo = params[0] if where.startswith("hotspot_id >=") else ""
                hi = params[-1] if where.endswith("< ?") else None
                if lo <= hid and (hi is None or hid < hi):
                    hits.append(b)
            return hits

        for hid, b in (("", 0), ("0000000000000000", 0), ("00ff", 0), ("01", 1),
                       ("09ffffffffffffff", 9), ("0a00000000000000", 10), ("7f", 127),
                       ("feffffffffffffff", 254), ("ff00000000000000", 255), ("zz", 255),
                       ("0g", 15), ("A0", 159)):
            self.assertEqual(bucket_of(hid), [b], hid)

    def test_month_starts(self):
        self.assertEqual(list(series.month_starts("2025-11-20", "2026-01-02")),
                         [(2025, 11, "2025-11-01", "2025-12-01"),
                          (2025, 12, "2025-12-01", "2026-01-01"),
                          (2026, 1, "2026-01-01", "2026-02-01")])


class Step(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = mock.patch.dict(os.environ, {"HOTORNOT_DB": str(Path(tmp.name) / "t.sqlite")})
        env.start()
        self.addCleanup(env.stop)
        patch = mock.patch.object(series.config, "load_config", return_value=CFG)
        patch.start()
        self.addCleanup(patch.stop)
        self.con = db.connect()
        self.addCleanup(self.con.close)
        with self.con:
            db.recreate(self.con, normalize.DDL)
            db.recreate(self.con, coverage.DDL)
            db.recreate(self.con, static_mask.DDL)
        self.ids = itertools.count()
        self.fixture()
        with self.con:
            for ddl in normalize.INDEXES_AFTER_LOAD.values():
                self.con.execute(ddl)

    def add(self, region, satellite, day, n=1, fire_type=0, processing="SP", in_box=1,
            masked=False):
        ids = []
        for _ in range(n):
            hid = hashlib.sha1(str(next(self.ids)).encode()).hexdigest()[:16]
            sensor = "MODIS" if satellite in ("Terra", "Aqua") else "VIIRS_375"
            with self.con:
                self.con.execute(
                    f"INSERT INTO hotspots VALUES ({', '.join('?' * len(normalize.COLUMNS))})",
                    (hid, region, in_box, satellite, sensor, f"{day}T11:30Z", day,
                     int(day[:4] + day[5:7]), 30.6, 31.2, "D", 1.5, 0.4, 0.4, "n",
                     None if processing == "NRT" else fire_type, processing, 17370624,
                     "n30e031", 1))
                if masked:
                    self.con.execute("INSERT INTO static_mask VALUES (?, 'near_sp_static')",
                                     (hid,))
            ids.append(hid)
        return ids

    def cover(self, region, satellite, granules, *days):
        with self.con:
            self.con.executemany("INSERT OR REPLACE INTO coverage_daily VALUES (?, ?, ?, ?)",
                                 [(region, d, satellite, granules) for d in days])

    def fixture(self):
        add, cover = self.add, self.cover
        self.expected = {}

        def expect(role, ids):
            self.expected.update(dict.fromkeys(ids, role))
            return ids

        # S-NPP calibration, delta: March 66 MODIS / 30 S-NPP on observed days; June to
        # August 60 / 40; year 126 / 70.
        expect("modis_overlap", add("delta", "Aqua", "2015-03-10", 60))
        expect("snpp", add("delta", "S-NPP", "2015-03-10", 30))
        expect("modis_overlap", add("delta", "Aqua", "2015-03-10", 5, in_box=0))
        expect("non_vegetation", add("delta", "S-NPP", "2015-03-10", 4, fire_type=2))
        cover("delta", "S-NPP", 3, "2014-03-07")
        expect("modis_overlap", add("delta", "Terra", "2014-03-07", 6))
        expect("modis_overlap", add("delta", "Aqua", "2013-03-05", 40))
        cover("delta", "S-NPP", 0, "2013-03-06")
        expect("modis_overlap", add("delta", "Aqua", "2013-03-06", 10))
        for day, modis, snpp in (("2016-06-05", 20, 5), ("2016-07-05", 20, 10),
                                 ("2016-08-05", 20, 25)):
            expect("modis_overlap", add("delta", "Terra", day, modis))
            expect("snpp", add("delta", "S-NPP", day, snpp))

        # NOAA-20 transfer, delta: September 60 S-NPP / 40 NOAA-20 on days both observed;
        # year 65 / 50.
        cover("delta", "S-NPP", 4, *(f"2021-09-{d:02d}" for d in range(1, 31)))
        cover("delta", "S-NPP", 0, "2021-09-20", "2021-09-25")
        cover("delta", "S-NPP", None, "2021-09-28")
        cover("delta", "NOAA-20", 3, "2021-09-20")
        cover("delta", "NOAA-20", 0, "2021-09-22", "2021-09-25")
        expect("snpp", add("delta", "S-NPP", "2021-09-10", 60))
        expect("n20_overlap", add("delta", "NOAA-20", "2021-09-10", 40))
        self.gapfill = expect("n20_gapfill", add("delta", "NOAA-20", "2021-09-20", 8))
        expect("snpp", add("delta", "S-NPP", "2021-09-22", 10))
        expect("n20_overlap", add("delta", "NOAA-20", "2021-09-28", 3))
        expect("snpp", add("delta", "S-NPP", "2022-02-10", 5))
        expect("n20_overlap", add("delta", "NOAA-20", "2022-02-10", 10))
        self.early_n20 = expect("n20_overlap", add("delta", "NOAA-20", "2018-03-15"))
        expect("non_vegetation", add("delta", "NOAA-20", "2025-01-01", fire_type=1))

        # The series periods.
        expect("modis", add("delta", "Terra", "2001-01-15", 2))
        expect("modis", add("delta", "Aqua", "2005-06-01", 3))
        expect("modis", add("delta", "Terra", "2011-12-31"))
        expect("modis_overlap", add("delta", "Aqua", "2012-01-01"))
        expect("non_vegetation", add("delta", "Aqua", "2015-05-01", fire_type=2))
        expect("static_masked", add("delta", "Terra", "2026-10-01", processing="NRT",
                                    masked=True))
        expect("modis_overlap", add("delta", "Terra", "2026-10-02", processing="NRT"))
        expect("snpp", add("delta", "S-NPP", "2026-07-31"))
        expect("snpp", add("delta", "S-NPP", "2026-09-05", processing="NRT", in_box=0))
        expect("static_masked", add("delta", "S-NPP", "2026-09-06", processing="NRT",
                                    masked=True))
        expect("snpp", add("delta", "S-NPP", "2026-10-15", 2, processing="NRT"))
        expect("static_masked", add("delta", "S-NPP", "2026-10-16", processing="NRT",
                                    masked=True))
        expect("snpp", add("delta", "S-NPP", "2026-11-01", processing="NRT"))
        expect("n20_overlap", add("delta", "NOAA-20", "2026-11-01", processing="NRT"))
        self.n20 = expect("n20", add("delta", "NOAA-20", "2026-11-02", 2, processing="NRT"))
        expect("n20", add("delta", "NOAA-20", "2026-11-03", processing="NRT", in_box=0))
        expect("n20", add("delta", "NOAA-20", "2026-11-13", processing="NRT"))

        # calif has NOAA-20 data only from 2023: the 2020 S-NPP outage is not filled.
        expect("modis_overlap", add("calif", "Aqua", "2015-05-05", 50))
        expect("snpp", add("calif", "S-NPP", "2015-05-05", 25))
        expect("snpp", add("calif", "S-NPP", "2023-05-05", 50))
        expect("n20_overlap", add("calif", "NOAA-20", "2023-05-05", 25))
        cover("calif", "S-NPP", 2, *(f"2020-08-{d:02d}" for d in range(1, 32)))
        cover("calif", "S-NPP", 0, "2020-08-01", "2024-08-01")
        self.calif_fill = expect("n20_gapfill", add("calif", "NOAA-20", "2024-08-01", 4))
        expect("n20_overlap", add("calif", "NOAA-20", "2024-08-02", 2))
        expect("snpp", add("calif", "S-NPP", "2024-08-20"))

    def run_step(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            status = cli.main(["series"])
        self.assertEqual(status, 0, out.getvalue())
        return out.getvalue()

    def test_roles_factors_weights_months(self):
        with self.con:
            self.con.execute(series.WEIGHTS_DDL)
            self.con.execute("INSERT INTO weights VALUES (?, 'model_v1', 0.5)", (self.n20[0],))
            self.con.execute("INSERT INTO weights VALUES ('ffffffffffffffff', 'ratio_v1', 1)")
            db.recreate(self.con, series.SERIES_DDL)
            self.con.execute("INSERT INTO series VALUES ('0000000000000000', 1, 'snpp')")

        for _ in range(2):
            output = self.run_step()
            self.check_tables()
        self.assertIn("ratio_v1 factors", output)
        self.assertIn("harmonized", output)

    def check_tables(self):
        con = self.con
        self.assertEqual(dict(con.execute("SELECT hotspot_id, role FROM series")), self.expected)
        self.assertEqual(con.execute(
            "SELECT COUNT(*) FROM series WHERE in_series != (role IN"
            " ('modis', 'snpp', 'n20_gapfill', 'n20'))").fetchone()[0], 0)

        factors = {(r, m, s): (round(f, 9), level) for r, m, s, f, level in
                   con.execute("SELECT * FROM ratio_factors")}
        self.assertEqual(len(factors), 48)
        expected_snpp = {1: 1.8, 2: 2.2, 3: 2.2, 4: 2.2, 5: 1.8, 6: 1.8, 7: 1.5, 8: 1.8,
                         9: 1.8, 10: 1.8, 11: 1.8, 12: 1.8}
        snpp_levels = {2: "pooled_3month", 3: "region_month", 4: "pooled_3month",
                       7: "pooled_3month"}
        for m, value in expected_snpp.items():
            self.assertEqual(factors["delta", m, "S-NPP"],
                             (value, snpp_levels.get(m, "region_year")), m)
        n20_ratio = {8: (1.5, "pooled_3month"), 9: (1.5, "region_month"),
                     10: (1.5, "pooled_3month")}
        for m in range(1, 13):
            ratio, level = n20_ratio.get(m, (1.3, "region_year"))
            self.assertEqual(factors["delta", m, "NOAA-20"],
                             (round(expected_snpp[m] * ratio, 9), level), m)
        for m in range(1, 13):
            self.assertEqual(factors["calif", m, "S-NPP"][0], 2.0)
            self.assertEqual(factors["calif", m, "NOAA-20"][0], 4.0)
        self.assertEqual(factors["calif", 5, "S-NPP"][1], "region_month")
        self.assertEqual(factors["calif", 4, "NOAA-20"][1], "pooled_3month")

        weights = dict(con.execute("SELECT hotspot_id, weight FROM weights"
                                   " WHERE method = 'ratio_v1'"))
        vegetation_viirs = {h for h, role in self.expected.items() if role in series.WEIGHTED}
        self.assertEqual(set(weights), vegetation_viirs)
        mismatched = con.execute("""
            SELECT COUNT(*) FROM weights w JOIN hotspots h USING (hotspot_id)
            JOIN ratio_factors f ON f.region_id = h.region_id AND f.satellite = h.satellite
             AND f.month = CAST(substr(h.acq_date, 6, 2) AS INTEGER)
            WHERE w.method = 'ratio_v1' AND w.weight != f.factor""").fetchone()[0]
        self.assertEqual(mismatched, 0)
        self.assertAlmostEqual(weights[self.gapfill[0]], 2.7)
        self.assertAlmostEqual(weights[self.early_n20[0]], 2.86)
        self.assertAlmostEqual(weights[self.n20[0]], 2.34)
        self.assertAlmostEqual(weights[self.calif_fill[0]], 4.0)
        self.assertEqual(con.execute("SELECT weight FROM weights WHERE method = 'model_v1'")
                         .fetchall(), [(0.5,)])

        months = {(r, ym): row for r, ym, *row in con.execute("SELECT * FROM months")}
        self.assertEqual(sum(1 for r, _ in months if r == "delta"), 26 * 12 + 1)
        self.assertEqual(min(months), ("calif", 200011))
        self.assertEqual(max(ym for r, ym in months if r == "calif"), 202408)
        for key, row in {
            ("delta", 200011): [1, None, 0, 0, 30],
            ("delta", 200206): [1, None, 0, 0, 30],
            ("delta", 200207): [0, None, 0, 0, 31],
            ("delta", 201112): [0, None, 0, 0, 31],
            ("delta", 201201): [0, "SNPP", 31, 0, 31],
            ("delta", 202109): [0, "SNPP+N20", 2, 0, 30],
            ("delta", 202607): [0, "SNPP", 30, 0, 31],
            ("delta", 202609): [0, "SNPP", 28, 0, 30],
            ("delta", 202610): [0, "SNPP", 29, 1, 31],
            ("delta", 202611): [0, "SNPP+N20", 9, 1, 13],
            ("calif", 202008): [0, "SNPP", 1, 0, 31],
            ("calif", 202408): [0, "SNPP+N20", 18, 0, 20],
        }.items():
            self.assertEqual(months[key], row, key)

        self.assertEqual(db.get_artifact("series:dates", con), {
            "delta": {"sp_until": "2026-07-31", "nrt_until": "2026-11-13"},
            "calif": {"sp_until": "2024-08-20", "nrt_until": "2024-08-20"},
        })

        report = db.get_artifact("series:report", con)
        self.assertEqual(report["rows"], len(self.expected))
        self.assertEqual(report["weights"], len(vegetation_viirs))
        self.assertEqual(report["gapfill_days"], {"delta": 2, "calif": 1})
        annual = {row["year"]: row for row in report["annual"]["delta"]}
        self.assertEqual(annual[2001], {"year": 2001, "modis": 2, "viirs_raw": 0,
                                        "harmonized": 2.0, "n20_gapfill": 0, "error": 0.0})
        self.assertEqual(annual[2015]["modis"], 60)
        self.assertAlmostEqual(annual[2015]["harmonized"], 66.0)
        self.assertAlmostEqual(annual[2016]["harmonized"], 69.0)
        self.assertEqual((annual[2021]["viirs_raw"], annual[2021]["n20_gapfill"]), (78, 8))
        self.assertAlmostEqual(annual[2021]["harmonized"], 70 * 1.8 + 8 * 2.7)
        self.assertEqual(annual[2026]["viirs_raw"], 7)
        self.assertTrue(report["checks"]["modis_era_equal"])
        self.assertAlmostEqual(report["checks"]["calibration_totals"]["delta"], (135 - 177) / 177)
        self.assertEqual(report["roles"]["delta"]["NOAA-20"],
                         {"n20_overlap": 55, "n20_gapfill": 8, "n20": 4, "non_vegetation": 1})

    def test_waits_for_normalize(self):
        with self.con:
            self.con.execute("DROP INDEX hotspots_hotspot_id")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(cli.main(["series"]), 1)
        self.assertIn("rerun series after normalize", out.getvalue())

    def test_step_is_discovered(self):
        self.assertIs(cli.discover_steps()["series"], series)


if __name__ == "__main__":
    unittest.main()
