import contextlib
import io
import itertools
import os
import tempfile
import unittest
from dataclasses import replace
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

from hotornot import cli, db, geo, grid
from hotornot.steps import normalize, static_mask

KM_LAT = 1 / 111.195
FLARE = (30.6, 31.2)
CFG = {"regions": [{"id": "nile_delta"}, {"id": "empty"}]}
SPEC = static_mask.Params(merge_km=0.375, radius_km=1.0, source_days=0, min_source_days=1,
                          bucket_deg=0.004, min_days=8, window_days=90)
SPEC_ARGS = ["--merge-km", "0.375", "--radius-km", "1", "--source-days", "0",
             "--min-source-days", "1", "--bucket-deg", "0.004", "--min-days", "8",
             "--window-days", "90"]


def north(km, origin=FLARE):
    return origin[0] + km * KM_LAT, origin[1]


def days(first, n, step=1):
    start = date.fromisoformat(first)
    return [(start + timedelta(days=i * step)).isoformat() for i in range(n)]


class Rules(unittest.TestCase):
    def masker(self, sources=(), detections=(), **params):
        return static_mask.Masker(sources, detections, replace(SPEC, **params))

    def test_distance_rule(self):
        m = self.masker([(*FLARE, 2, 40)])
        self.assertEqual(m.reason(*north(0.95), "2026-09-01"), "near_sp_static")
        self.assertEqual(m.reason(*FLARE, "2026-09-01"), "near_sp_static")
        self.assertIsNone(m.reason(*north(1.05), "2026-09-01"))

    def test_radius_is_a_parameter(self):
        m = self.masker([(*FLARE, 2, 40)], radius_km=0.5)
        self.assertIsNone(m.reason(*north(0.6), "2026-09-01"))
        self.assertEqual(m.reason(*north(0.45), "2026-09-01"), "near_sp_static")

    def test_far_from_any_source(self):
        m = self.masker([(*FLARE, 2, 40), (31.5, 30.0, 3, 9)],
                        [(*north(5.0), "2026-09-01")])
        self.assertIsNone(m.reason(*north(5.0), "2026-09-01"))

    def test_persistence_counts_distinct_days_in_the_trailing_window(self):
        spot = north(20.0)
        detections = [(*spot, d) for d in days("2026-08-01", 7, step=10)]
        detections += [(*spot, "2026-08-01")] * 3
        m = self.masker(detections=detections)
        self.assertEqual(m.days_seen(*spot, "2026-10-01"), 7)
        self.assertIsNone(m.reason(*spot, "2026-10-01"))

        m = self.masker(detections=detections + [(*spot, "2026-10-01")])
        self.assertEqual(m.reason(*spot, "2026-10-01"), "persistent")
        self.assertEqual(m.days_seen(*spot, "2026-09-30"), 7)
        self.assertEqual(m.days_seen(*spot, "2026-07-31"), 0)
        # 2026-08-01 drops out of the 90 days ending 2026-10-30.
        self.assertEqual(m.days_seen(*spot, "2026-10-30"), 7)

    def test_persistence_parameters(self):
        spot = north(20.0)
        detections = [(*spot, d) for d in days("2026-08-01", 5)]
        self.assertIsNone(self.masker(detections=detections).reason(*spot, "2026-08-05"))
        self.assertEqual(self.masker(detections=detections, min_days=5)
                         .reason(*spot, "2026-08-05"), "persistent")
        self.assertIsNone(self.masker(detections=detections, min_days=5, window_days=4)
                          .reason(*spot, "2026-08-05"))

    def test_persistence_is_per_bucket(self):
        spot = (30.6021, 31.2021)
        detections = [(*spot, d) for d in days("2026-08-01", 10)]
        m = self.masker(detections=detections)
        self.assertEqual(m.reason(30.6039, 31.2001, "2026-08-10"), "persistent")
        self.assertIsNone(m.reason(30.6041, 31.2021, "2026-08-10"))

    def test_sources_win_over_persistence(self):
        detections = [(*FLARE, d) for d in days("2026-08-01", 10)]
        m = self.masker([(*FLARE, 2, 40)], detections)
        self.assertEqual(m.reason(*FLARE, "2026-08-10"), "near_sp_static")


class Merge(unittest.TestCase):
    def test_rows_within_merge_distance_become_one_location(self):
        rows = [(*FLARE, 2, d) for d in days("2024-01-01", 5)]
        rows += [(*north(0.3), 2, "2024-01-01"), (*north(0.2), 3, "2024-02-01")]
        rows += [(*north(3.0), 3, "2024-03-01"), (*north(3.1), 3, "2024-03-02")]
        locations = sorted(static_mask.merge_locations(rows, 0.375))
        self.assertEqual(len(locations), 2)
        (lat, lon, fire_type, n_days), far = locations
        self.assertEqual((fire_type, n_days), (2, 6))
        self.assertAlmostEqual(lat, FLARE[0] + 0.5 / 7 * KM_LAT, places=9)
        self.assertAlmostEqual(lon, FLARE[1])
        self.assertEqual(far[2:], (3, 2))
        self.assertLess(geo.haversine_km(*far[:2], *north(3.05)), 0.001)

    def test_densest_spot_seeds_the_location(self):
        rows = [(*north(0.3), 2, d) for d in days("2024-01-01", 6)]
        rows += [(*FLARE, 2, "2024-02-01"), (*north(0.6), 2, "2024-02-02")]
        locations = static_mask.merge_locations(rows, 0.375)
        self.assertEqual(len(locations), 1)
        self.assertEqual(locations[0][3], 8)

    def test_no_rows(self):
        self.assertEqual(static_mask.merge_locations([], 0.375), [])

    def test_sources_come_from_recent_rows_seen_on_enough_days(self):
        rows = [(*FLARE, 2, d) for d in days("2022-01-01", 4, step=100)]
        rows += [(*north(3.0), 2, d) for d in days("2024-03-01", 3)]
        rows += [(*north(6.0), 3, d) for d in days("2024-06-01", 2)]
        rows += [(*north(9.0), 2, "2025-02-01")]

        def found(until=None, **params):
            sources = static_mask.static_sources(rows, replace(SPEC, **params), until)
            return sorted((round(lat, 3), n_days) for lat, _, _, n_days in sources)

        flare, recent, short, late = (round(north(km)[0], 3) for km in (0, 3, 6, 9))
        self.assertEqual(found(source_days=0), [(flare, 4), (recent, 3), (short, 2), (late, 1)])
        self.assertEqual(found(source_days=0, until="2024-12-31"),
                         [(flare, 4), (recent, 3), (short, 2)])
        # The last static row up to 2024-12-31 is on 2024-06-02; 365 days back is 2023-06-04.
        self.assertEqual(found(source_days=365, until="2024-12-31"), [(recent, 3), (short, 2)])
        self.assertEqual(found(source_days=365, min_source_days=3, until="2024-12-31"),
                         [(recent, 3)])
        self.assertEqual(found(source_days=365), [(recent, 3), (short, 2), (late, 1)])
        self.assertEqual(static_mask.static_sources([], static_mask.Params()), [])


class Step(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = mock.patch.dict(os.environ, {"HOTORNOT_DB": str(Path(tmp.name) / "t.sqlite")})
        env.start()
        self.addCleanup(env.stop)
        self.con = db.connect()
        self.addCleanup(self.con.close)
        with self.con:
            db.recreate(self.con, normalize.DDL)
        self.ids = itertools.count()

    def add(self, lat, lon, acq_date, fire_type=0, processing="SP", satellite="S-NPP",
            in_box=1, region_id="nile_delta"):
        hotspot_id = f"h{next(self.ids):015d}"
        cell = grid.cell_of(lat, lon)[2]
        sensor = "MODIS" if satellite in ("Terra", "Aqua") else "VIIRS_375"
        with self.con:
            self.con.execute(
                f"INSERT INTO hotspots ({', '.join(normalize.COLUMNS)}) "
                f"VALUES ({', '.join('?' * len(normalize.COLUMNS))})",
                (hotspot_id, region_id, in_box, satellite, sensor, f"{acq_date}T11:30Z",
                 acq_date, int(acq_date[:4] + acq_date[5:7]), lat, lon, "D", 1.5, 0.4, 0.4,
                 "n", fire_type if processing == "SP" else None, processing, cell,
                 grid.tile_of(cell), 1))
        return hotspot_id

    def fixture(self):
        """An old flare (SP type 2 through 2024), a flare new in 2025 and 2026, farm fires."""
        old, new, farm = FLARE, north(10.0), north(30.0)
        for d in days("2023-01-01", 60, step=12):
            self.add(*old, d, fire_type=2)
        for d in days("2025-01-01", 70, step=5):
            self.add(*new, d, fire_type=2)
        for i, d in enumerate(days("2025-01-03", 40, step=9)):
            self.add(farm[0] + 0.01 * i, farm[1], d, fire_type=0)
        self.add(*north(0.4), "2025-06-01", fire_type=0)
        self.add(*north(0.3, new), "2025-06-02", fire_type=3, in_box=0)
        self.add(*north(0.2), "2025-06-03", fire_type=2, satellite="Aqua")

        expected = {}
        expected[self.add(*north(0.5), "2026-08-02", processing="NRT")] = "near_sp_static"
        expected[self.add(*old, "2026-08-03", processing="NRT", in_box=0)] = "near_sp_static"
        for d in days("2026-08-01", 12, step=7):
            hotspot_id = self.add(*north(2.0, new), d, processing="NRT", satellite="NOAA-20")
            if d >= "2026-09-19":
                expected[hotspot_id] = "persistent"
        self.add(*farm, "2026-09-01", processing="NRT")
        self.add(*north(0.5), "2026-09-01", fire_type=0)
        return expected

    def test_leakage_test_and_mask(self):
        expected = self.fixture()
        sources, masked, report = static_mask.build(self.con, CFG, SPEC, log=lambda *_: None)
        self.assertEqual(dict(masked), expected)
        self.assertEqual(sorted(s[3] for s in sources), [2, 2])
        self.assertEqual(sorted(s[4] for s in sources), [61, 71])

        delta, empty = report["regions"]
        t = delta["leakage_test"]
        self.assertEqual((t["first_date"], t["last_date"]), ("2025-01-01", "2025-12-20"))
        self.assertEqual(t["sources"], 1)
        all_ = t["by_sensor"]["all"]
        self.assertEqual((all_["type0"], all_["static"]), (41, 71))
        # The new flare is in no SP year before 2025: persistence catches all but its first
        # seven days. The farm fire 0.4 km from the old flare is masked.
        self.assertEqual(all_["caught_by_reason"], {"near_sp_static": 1, "persistent": 63})
        self.assertEqual(all_["leaked"], 7)
        self.assertEqual(all_["false_masked"], 1)
        self.assertAlmostEqual(all_["leakage"], 7 / 41)
        self.assertAlmostEqual(all_["false_masking"], 1 / 41)
        self.assertEqual(t["by_sensor"]["MODIS"]["static"], 1)
        self.assertFalse(t["passed"])
        self.assertEqual(delta["nrt"]["rows"], 15)
        self.assertEqual(delta["nrt"]["masked_by_reason"], {"near_sp_static": 2, "persistent": 5})
        self.assertEqual(delta["nrt"]["in_box_masked_by_reason"],
                         {"near_sp_static": 1, "persistent": 5})
        self.assertEqual(empty["nrt"]["rows"], 0)
        self.assertIsNone(empty["leakage_test"]["by_sensor"]["all"]["leakage"])
        self.assertFalse(report["passed"])

    def test_step_writes_tables_and_reruns(self):
        expected = self.fixture()
        with mock.patch.object(static_mask.config, "load_config", return_value=CFG):
            for _ in range(2):
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    status = cli.main(["static-mask", *SPEC_ARGS])
                self.assertEqual(status, 0)
                self.assertEqual(dict(self.con.execute("SELECT * FROM static_mask")), expected)
                self.assertEqual(self.con.execute(
                    "SELECT region_id, fire_type, n_days FROM static_sources ORDER BY n_days"
                ).fetchall(), [("nile_delta", 2, 61), ("nile_delta", 2, 71)])
        self.assertIn("Leakage test", out.getvalue())
        self.assertIn("FAIL", out.getvalue())
        report = db.get_artifact("static_mask:report", self.con)
        self.assertEqual(report["params"], vars(SPEC))
        self.assertEqual(len(report["regions"]), 2)

    def test_step_is_discovered(self):
        self.assertIs(cli.discover_steps()["static-mask"], static_mask)


if __name__ == "__main__":
    unittest.main()
