import argparse
import contextlib
import io
import itertools
import json
import os
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

from hotornot import cli, config, db
from hotornot.ingest import ingest
from hotornot.steps import coverage

UNTIL = date(2026, 11, 13)
CFG = {
    "regions": [
        {"id": "box", "bbox": [10.0, 40.0, 12.0, 42.0]},
        # Inside the poleward bulge of a great-circle edge along 60°N, outside the straight one.
        {"id": "north", "bbox": [19.0, 60.5, 21.0, 61.0]},
        {"id": "pacific", "bbox": [178.0, -20.0, 179.5, -18.0]},
    ],
    "cmr": [
        {"short_name": "MYD14", "start": "2012-01-01", "end": "2019-12-31"},
        {"short_name": "VNP14IMG", "start": "2012-01-19", "end": "2026-11-02"},
        {"short_name": "VJ114IMG", "start": "2018-01-01", "end": None},
    ],
}
REGION_IDS = [r["id"] for r in CFG["regions"]]


def square(west, south, east, north):
    return [[[[west, south], [east, south], [east, north], [west, north], [west, south]]]]


OVER_BOX = square(9.5, 39.5, 12.5, 42.5)
BUFFER_ONLY = square(12.2, 40.0, 13.0, 41.0)
BULGING_NORTH = square(0.0, 50.0, 40.0, 60.0)
ACROSS_180 = [[[[170.0, -25.0], [-170.0, -25.0], [-170.0, -10.0], [170.0, -10.0],
                [170.0, -25.0]]]]


class Coverage(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = mock.patch.dict(os.environ, {"HOTORNOT_DB": str(Path(tmp.name) / "t.sqlite")})
        env.start()
        self.addCleanup(env.stop)
        self.con = db.connect()
        self.addCleanup(self.con.close)
        self.con.executescript(ingest.SCHEMA)
        self.ids = itertools.count()
        with self.con:
            self.con.executemany(
                "INSERT INTO cmr_slices VALUES (?, ?, ?, 10, 10, 1)",
                itertools.product(coverage.PRODUCTS, REGION_IDS, range(2012, 2027)))
        self.granule("MYD14", "box", "2019-12-31T12:00:00.000Z")
        self.granule("VNP14IMG", "box", "2026-11-02T12:00:00.000Z")
        self.granule("VJ114IMG", "box", "2026-11-07T12:00:00.000Z")

    def granule(self, short_name, region_id, time_start, footprint=OVER_BOX):
        text = None if footprint is None else json.dumps(footprint)
        with self.con:
            self.con.execute("INSERT INTO cmr_granules VALUES (?, ?, ?, ?, NULL, 'DAY', ?)",
                             (short_name, region_id, f"g{next(self.ids)}", time_start, text))

    def hotspot(self, region_id, satellite, acq_date, acq_time="1200", in_box=1):
        with self.con:
            self.con.execute(
                "INSERT INTO raw_hotspots (file_id, region_id, in_box, source, satellite, latitude,"
                " longitude, acq_date, acq_time, processing) VALUES (1, ?, ?, 'test', ?, 0, 0, ?, ?,"
                " 'NRT')", (region_id, in_box, satellite, acq_date, acq_time))

    def build(self):
        rows, report = coverage.build(self.con, CFG, UNTIL)
        return {(r, d, s): n for r, d, s, n in rows}, report

    def series(self, report, region_id, satellite):
        return next(s for s in report["series"]
                    if (s["region_id"], s["satellite"]) == (region_id, satellite))


class Counting(Coverage):
    def test_counts_on_the_utc_day_of_time_start(self):
        self.granule("VNP14IMG", "box", "2020-05-01T23:58:00.000Z")
        self.granule("VNP14IMG", "box", "2020-05-01T11:00:00.000Z")
        got, _ = self.build()
        self.assertEqual(got["box", "2020-05-01", "S-NPP"], 2)
        self.assertEqual(got["box", "2020-05-02", "S-NPP"], 0)

    def test_footprint_must_touch_the_exact_bbox(self):
        self.granule("MYD14", "box", "2015-03-03T10:00:00.000Z", BUFFER_ONLY)
        got, report = self.build()
        self.assertEqual(got["box", "2015-03-03", "Aqua"], 0)
        self.assertEqual(self.series(report, "box", "Aqua")["granules_missing_bbox"], 1)

    def test_footprint_edges_are_great_circles(self):
        self.granule("VJ114IMG", "north", "2021-07-01T10:00:00.000Z", BULGING_NORTH)
        got, _ = self.build()
        self.assertEqual(got["north", "2021-07-01", "NOAA-20"], 1)

    def test_footprint_across_the_antimeridian(self):
        self.granule("VNP14IMG", "pacific", "2019-02-02T03:00:00.000Z", ACROSS_180)
        got, _ = self.build()
        self.assertEqual(got["pacific", "2019-02-02", "S-NPP"], 1)

    def test_granule_without_footprint_counts(self):
        self.granule("MYD14", "box", "2013-06-06T10:00:00.000Z", None)
        got, report = self.build()
        self.assertEqual(got["box", "2013-06-06", "Aqua"], 1)
        self.assertEqual(self.series(report, "box", "Aqua")["granules_without_footprint"], 1)


class Periods(Coverage):
    def test_one_row_per_region_day_and_satellite(self):
        self.granule("VNP14IMG", "box", "2026-11-02T01:00:00.000Z")
        got, _ = self.build()
        for satellite, (first, last) in coverage.periods(UNTIL).items():
            for region_id in REGION_IDS:
                days = sorted(d for r, d, s in got if (r, s) == (region_id, satellite))
                self.assertEqual((days[0], days[-1]), (first.isoformat(), last.isoformat()))
                self.assertEqual(len(days), (last - first).days + 1)
        self.assertEqual(coverage.periods(UNTIL)["Aqua"], (date(2012, 1, 1), date(2019, 12, 31)))
        self.assertEqual(coverage.periods(UNTIL)["NOAA-20"], (date(2018, 4, 1), UNTIL))
        self.assertFalse([k for k in got if k[2] == "S-NPP" and k[1] > "2026-11-01"])
        self.assertIn(("box", "2012-01-20", "S-NPP"), got)
        self.assertNotIn(("box", "2012-01-19", "S-NPP"), got)


class Unknown(Coverage):
    def test_days_after_an_open_listing_are_unknown(self):
        self.granule("VJ114IMG", "north", "2026-11-05T10:00:00.000Z", BULGING_NORTH)
        got, report = self.build()
        self.assertEqual(got["box", "2026-11-06", "NOAA-20"], 0)
        self.assertEqual(got["box", "2026-11-07", "NOAA-20"], 1)
        self.assertIsNone(got["north", "2026-11-07", "NOAA-20"])
        for day in ("2026-11-08", "2026-11-13"):
            self.assertIsNone(got["box", day, "NOAA-20"])
        box = self.series(report, "box", "NOAA-20")
        self.assertEqual(box["unknown_ranges"], [["2026-11-08", "2026-11-13"]])
        self.assertEqual(box["unknown_reasons"]["after_listing"], 6)
        listing = next(x for x in report["listings"] if x["short_name"] == "VJ114IMG")
        self.assertEqual(listing["complete_through"], "2026-11-06")

    def test_closed_listings_are_complete_through_their_end(self):
        got, _ = self.build()
        self.assertEqual(got["north", "2026-11-01", "S-NPP"], 0)
        self.assertEqual(got["north", "2019-12-31", "Aqua"], 0)

    def test_missing_listing_is_unknown(self):
        with self.con:
            self.con.execute("DELETE FROM cmr_granules WHERE short_name = 'MYD14'")
        got, _ = self.build()
        self.assertIsNone(got["box", "2015-01-01", "Aqua"])

    def test_unfinished_slice_is_unknown(self):
        with self.con:
            self.con.execute("UPDATE cmr_slices SET stored = 9 WHERE short_name = 'VNP14IMG'"
                             " AND region_id = 'box' AND year = 2016")
            self.con.execute("DELETE FROM cmr_slices WHERE short_name = 'VNP14IMG'"
                             " AND region_id = 'north' AND year = 2016")
        self.granule("VNP14IMG", "box", "2016-04-04T10:00:00.000Z")
        got, report = self.build()
        self.assertEqual(got["box", "2016-04-04", "S-NPP"], 1)
        self.assertIsNone(got["box", "2016-04-05", "S-NPP"])
        self.assertIsNone(got["north", "2016-12-31", "S-NPP"])
        self.assertEqual(got["north", "2017-01-01", "S-NPP"], 0)
        self.assertEqual(self.series(report, "north", "S-NPP")["unknown_reasons"],
                         {"after_listing": 0, "slice_incomplete": 366, "firms_detections": 0})

    def test_firms_rows_in_the_bbox_overrule_an_empty_listing(self):
        for day in ("04", "06"):
            self.granule("VNP14IMG", "north", f"2024-08-{day}T10:00:00.000Z", BULGING_NORTH)
        self.hotspot("box", "S-NPP", "2024-08-04")
        self.hotspot("box", "S-NPP", "2024-08-05", acq_time="0005")
        self.hotspot("box", "S-NPP", "2024-08-06", in_box=0)
        got, report = self.build()
        self.assertIsNone(got["box", "2024-08-04", "S-NPP"])
        self.assertEqual(got["box", "2024-08-05", "S-NPP"], 0)
        self.assertEqual(got["box", "2024-08-06", "S-NPP"], 0)
        box = self.series(report, "box", "S-NPP")
        self.assertEqual((box["firms_days"], box["firms_days_without_granule"]), (1, 1))

    def test_firms_rows_anywhere_overrule_a_listing_empty_everywhere(self):
        self.hotspot("pacific", "NOAA-20", "2018-05-01", in_box=0)
        self.hotspot("pacific", "NOAA-20", "2018-05-02", in_box=0)
        self.granule("VJ114IMG", "north", "2018-05-02T10:00:00.000Z", BULGING_NORTH)
        got, report = self.build()
        for region_id in REGION_IDS:
            self.assertIsNone(got[region_id, "2018-05-01", "NOAA-20"])
        self.assertEqual(got["box", "2018-05-02", "NOAA-20"], 0)
        self.assertEqual(got["north", "2018-05-02", "NOAA-20"], 1)
        self.assertEqual(self.series(report, "box", "NOAA-20")["unknown_reasons"]
                         ["firms_detections"], 1)


class Report(Coverage):
    def test_ranges(self):
        self.assertEqual(coverage.ranges([]), [])
        self.assertEqual(coverage.ranges(["2024-02-28", "2024-02-29", "2024-03-01", "2024-03-03"]),
                         [["2024-02-28", "2024-03-01"], ["2024-03-03", "2024-03-03"]])

    def test_zero_ranges_and_announced_outages(self):
        for day in range(1, 32):
            if day not in (5, 6, 7):
                self.granule("VNP14IMG", "box", f"2026-05-{day:02d}T10:00:00.000Z")
        self.hotspot("box", "S-NPP", "2026-05-07")
        _, report = self.build()
        box = self.series(report, "box", "S-NPP")
        self.assertIn(["2026-05-05", "2026-05-06"], box["zero_ranges"])
        self.assertIn(["2026-05-07", "2026-05-07"], box["unknown_ranges"])
        outage = report["snpp_outages_2026"][0]
        self.assertEqual((outage["start"], outage["end"], outage["days"]),
                         ("2026-04-29", "2026-05-08", 10))
        self.assertEqual((outage["zero_days"]["box"], outage["unknown_days"]["box"]), (4, 1))


class Run(Coverage):
    def run_step(self):
        out = io.StringIO()
        with mock.patch.object(config, "load_config", return_value=CFG), \
                contextlib.redirect_stdout(out):
            self.assertEqual(coverage.run(argparse.Namespace(until=UNTIL)), 0)
        return out.getvalue()

    def test_run_writes_table_and_report_and_reruns(self):
        self.granule("VJ114IMG", "box", "2022-02-02T10:00:00.000Z")
        first = self.run_step()
        rows = self.con.execute("SELECT * FROM coverage_daily ORDER BY 1, 2, 3").fetchall()
        second = self.run_step()
        self.assertEqual(self.con.execute("SELECT * FROM coverage_daily ORDER BY 1, 2, 3")
                         .fetchall(), rows)
        self.assertEqual(first, second)
        self.assertIn("2026-11-08..2026-11-13", first)
        self.assertIn(("box", "2022-02-02", "NOAA-20", 1), rows)
        report = db.get_artifact("coverage:report", self.con)
        self.assertEqual(report["rows"], len(rows))
        notnull = {r[1]: r[3] for r in self.con.execute("PRAGMA table_info(coverage_daily)")}
        self.assertEqual(notnull["granules"], 0)

    def test_step_is_discovered(self):
        self.assertIs(cli.discover_steps()["coverage"], coverage)


if __name__ == "__main__":
    unittest.main()
