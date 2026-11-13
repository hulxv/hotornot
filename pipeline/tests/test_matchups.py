import argparse
import json
import math
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

from hotornot import cli, db, geo
from hotornot.ingest import ingest
from hotornot.steps import matchups, normalize

CFG = {"regions": [{"id": "box", "bbox": [30.0, 30.0, 32.0, 32.0], "history": "country_files",
                    "countries": ["Egypt"], "excluded_countries": []}]}
# Edges run along great circles between these corners; the north edge bows about 0.01° north.
FOOTPRINT = [[[[29.5, 29.5], [33.0, 29.5], [33.0, 31.5], [29.5, 31.5], [29.5, 29.5]]]]
KM_PER_DEG = geo.KM_PER_DEG


def offset(lat, lon, east_km, north_km):
    return (lat + north_km / KM_PER_DEG,
            lon + east_km / (KM_PER_DEG * math.cos(math.radians(lat))))


class Fixture(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.con = db.connect(Path(tmp.name) / "pipeline.sqlite")
        self.addCleanup(self.con.close)
        self.con.executescript(ingest.SCHEMA)
        with self.con:
            db.recreate(self.con, normalize.DDL)
            self.con.execute(normalize.INDEXES_AFTER_LOAD["hotspots_hotspot_id"])
        db.put_artifact("normalize:report", {"seconds": 60}, self.con)
        self.granules = 0
        self.logged = []

    def granule(self, time_start, footprint=FOOTPRINT, minutes=5):
        self.granules += 1
        end = datetime.fromisoformat(time_start) + timedelta(minutes=minutes)
        time_end = f"{end:%Y-%m-%dT%H:%M:%S}.000Z"
        granule_id = f"MYD14.g{self.granules}"
        with self.con:
            self.con.execute("INSERT INTO cmr_granules VALUES ('MYD14', 'box', ?, ?, ?, 'DAY', ?)",
                             (granule_id, time_start, time_end, json.dumps(footprint)))
        return granule_id

    def hotspot(self, satellite, acq_utc, lat, lon, in_box=1, fire_type=0, processing="SP",
                frp=5.0, scan=1.0, track=1.0, daynight="D"):
        acq_date, hhmm = acq_utc[:10], acq_utc[11:13] + acq_utc[14:16]
        hid = normalize.hotspot_id(satellite, acq_date, hhmm, lat, lon)
        sensor = "MODIS" if satellite == "Aqua" else "VIIRS_375"
        with self.con:
            self.con.execute(
                f"INSERT INTO hotspots VALUES ({', '.join('?' * 20)})",
                (hid, "box", in_box, satellite, sensor, acq_utc, acq_date,
                 int(acq_date[:4]) * 100 + int(acq_date[5:7]), lat, lon, daynight, frp, scan,
                 track, "n", fire_type, processing, 0, "n30e030", 1))
        return hid

    def snpp(self, acq_utc, lat, lon, **kw):
        return self.hotspot("S-NPP", acq_utc, lat, lon, scan=0.4, track=0.4, **kw)

    def aqua(self, acq_utc, lat, lon, **kw):
        return self.hotspot("Aqua", acq_utc, lat, lon, **kw)

    def run_step(self, years=(2015,), **kw):
        return matchups.matchups(self.con, CFG, list(years), log=self.logged.append, **kw)

    def rows(self):
        return {r[0]: r[1:] for r in self.con.execute("SELECT * FROM matchups")}

    def entry(self, report, year=2015):
        return report["region_years"][f"box:{year}"]


class ThreePoints(Fixture):
    def test_covered_matched_covered_unmatched_uncovered(self):
        g = self.granule("2015-06-01T10:45:00.000Z")
        self.aqua("2015-06-01T10:47Z", 31.0, 30.5)
        matched = self.snpp("2015-06-01T10:40Z", 31.0, 30.5)
        unmatched = self.snpp("2015-06-01T10:40Z", 31.2, 31.0)
        uncovered = self.snpp("2015-06-01T10:40Z", 31.8, 31.5)
        report = self.run_step()
        self.assertEqual(self.rows(), {matched: (g, -7.5, 1.0, 1), unmatched: (g, -7.5, 0.0, 0)})
        self.assertNotIn(uncovered, self.rows())
        e = self.entry(report)
        self.assertEqual((e["candidates"], e["covered"], e["positive"]), (3, 2, 1))
        region = report["regions"][0]
        self.assertAlmostEqual(region["covered_share"], 2 / 3)
        self.assertAlmostEqual(region["positive_share"], 0.5)
        self.assertEqual((region["aqua_in_box"], region["aqua_matched"]), (1, 1))


class Labels(Fixture):
    def setUp(self):
        super().setUp()
        self.g = self.granule("2015-06-01T10:45:00.000Z")

    def test_shares_split_among_points_in_one_pixel_including_buffer_points(self):
        self.aqua("2015-06-01T10:47Z", 30.0, 31.0)
        a = self.snpp("2015-06-01T10:40Z", *offset(30.0, 31.0, 0.2, 0.1))
        b = self.snpp("2015-06-01T10:40Z", *offset(30.0, 31.0, -0.2, 0.1))
        buffer = self.snpp("2015-06-01T10:40Z", *offset(30.0, 31.0, 0.0, -0.3), in_box=0)
        self.run_step()
        rows = self.rows()
        self.assertEqual(set(rows), {a, b})
        for hid in (a, b):
            self.assertAlmostEqual(rows[hid][2], 1 / 3)
            self.assertEqual(rows[hid][3], 1)
        self.assertNotIn(buffer, rows)

    def test_label_is_capped_at_one(self):
        self.aqua("2015-06-01T10:47Z", *offset(31.0, 31.0, 0.3, 0.0))
        self.aqua("2015-06-01T10:47Z", *offset(31.0, 31.0, -0.3, 0.0))
        p = self.snpp("2015-06-01T10:40Z", 31.0, 31.0)
        self.run_step()
        self.assertEqual(self.rows()[p][2:], (1.0, 2))

    def test_aqua_from_another_overpass_does_not_match(self):
        self.aqua("2015-06-01T10:56Z", 31.0, 31.0)
        p = self.snpp("2015-06-01T10:40Z", 31.0, 31.0)
        self.run_step()
        self.assertEqual(self.rows()[p][2:], (0.0, 0))

    def test_aqua_of_the_covering_overpass_matches_beyond_the_window(self):
        g = self.granule("2015-06-01T11:39:00.000Z")
        self.aqua("2015-06-01T11:43Z", 30.5, 30.5)
        p = self.snpp("2015-06-01T11:25Z", 30.5, 30.5)
        self.run_step()
        self.assertEqual(self.rows()[p], (g, -16.5, 1.0, 1))

    def test_aqua_reported_from_the_neighbouring_granule_matches(self):
        self.aqua("2015-06-01T10:52Z", 31.0, 31.0)
        p = self.snpp("2015-06-01T10:40Z", 31.0, 31.0)
        self.run_step()
        self.assertEqual(self.rows()[p][2:], (1.0, 1))

    def test_only_vegetation_aqua_hotspots_label(self):
        self.aqua("2015-06-01T10:47Z", 31.0, 31.0, fire_type=2)
        p = self.snpp("2015-06-01T10:40Z", 31.0, 31.0)
        self.run_step()
        self.assertEqual(self.rows()[p][2:], (0.0, 0))

    def test_tolerance_grows_the_pixel(self):
        self.aqua("2015-06-01T10:47Z", 31.0, 31.0, scan=1.0, track=1.0)
        p = self.snpp("2015-06-01T10:40Z", *offset(31.0, 31.0, 0.0, 0.9))
        report = self.run_step(tol=1.5)
        self.assertEqual(self.rows()[p][2:], (0.0, 0))
        sweep = report["regions"][0]["by_tol"]
        self.assertEqual({t: s["positive_share"] for t, s in sweep.items()},
                         {"1.0": 0.0, "1.5": 0.0, "2.0": 1.0})
        self.run_step(tol=2.0)
        self.assertEqual(self.rows()[p][2:], (1.0, 1))


class PixelOrientation(Fixture):
    # At 31° Aqua's ascending ground track heads 12.87° west of north (98.2° inclination, less
    # the Earth's turn), and its descending track 12.87° west of south.
    HEADING_DEG = -12.87

    def test_track_direction(self):
        for ascending, expected in ((True, self.HEADING_DEG), (False, 180 - self.HEADING_DEG)):
            east, north = matchups.track_direction(31.0, ascending)
            heading = math.degrees(math.atan2(east, north)) % 360
            self.assertAlmostEqual(heading, expected % 360, delta=0.05)

    def test_pixel_is_rotated_along_scan_and_track(self):
        self.granule("2015-06-01T10:45:00.000Z")
        self.granule("2015-06-01T11:10:00.000Z")
        h = math.radians(self.HEADING_DEG)
        track = (math.sin(h), math.cos(h))
        scan = (track[1], -track[0])
        east = 1.45 * scan[0] + 0.45 * track[0]
        north = 1.45 * scan[1] + 0.45 * track[1]
        # Inside the rotated 3 km by 1 km day pixel, but 0.76 km north of its centre, so outside
        # an unrotated one and outside the night pixel, which tilts the other way.
        self.assertGreater(north, 0.5)
        lat, lon = offset(31.0, 31.0, east, north)
        day = self.snpp("2015-06-01T10:40Z", lat, lon)
        night = self.snpp("2015-06-01T11:10Z", lat, lon)
        self.aqua("2015-06-01T10:47Z", 31.0, 31.0, scan=3.0, track=1.0, daynight="D")
        self.aqua("2015-06-01T11:12Z", 31.0, 31.0, scan=3.0, track=1.0, daynight="N")
        self.run_step(tol=1.0)
        rows = self.rows()
        self.assertEqual(rows[day][2:], (1.0, 1))
        self.assertEqual(rows[night][2:], (0.0, 0))


class Coverage(Fixture):
    def test_granule_span_within_the_window(self):
        first = self.granule("2015-06-01T10:54:00.000Z")
        second = self.granule("2015-06-01T11:16:00.000Z")
        early = self.snpp("2015-06-01T10:40Z", 31.0, 31.0)
        late = self.snpp("2015-06-01T11:36Z", 31.0, 31.0)
        too_late = self.snpp("2015-06-01T11:37Z", 31.1, 31.0)
        self.run_step()
        rows = self.rows()
        self.assertEqual(rows[early][:2], (first, -16.5))
        self.assertEqual(rows[late][:2], (second, 17.5))
        self.assertNotIn(too_late, rows)

    def test_closest_granule_wins(self):
        self.granule("2015-06-01T10:35:00.000Z")
        close = self.granule("2015-06-01T10:40:00.000Z")
        p = self.snpp("2015-06-01T10:42Z", 31.0, 31.0)
        self.run_step()
        self.assertEqual(self.rows()[p][:2], (close, -0.5))

    def test_overpass_across_the_new_year(self):
        g = self.granule("2016-01-01T00:00:00.000Z")
        self.aqua("2016-01-01T00:02Z", 31.0, 31.0)
        p = self.snpp("2015-12-31T23:55Z", 31.0, 31.0)
        self.run_step(years=(2015,))
        self.assertEqual(self.rows()[p], (g, -7.5, 1.0, 1))

    def test_only_sp_vegetation_in_box_candidates_in_the_year(self):
        self.granule("2015-06-01T10:45:00.000Z")
        self.granule("2016-06-01T10:45:00.000Z")
        keep = self.snpp("2015-06-01T10:40Z", 31.0, 31.0)
        self.snpp("2015-06-01T10:40Z", 31.0, 31.1, fire_type=2)
        self.snpp("2015-06-01T10:41Z", 31.0, 31.0, processing="NRT", fire_type=None)
        self.snpp("2015-06-01T10:40Z", 31.0, 31.2, in_box=0)
        self.snpp("2016-06-01T10:40Z", 31.0, 31.0)
        report = self.run_step(years=(2015,))
        self.assertEqual(set(self.rows()), {keep})
        self.assertEqual(self.entry(report)["candidates"], 1)


class Resume(Fixture):
    def setUp(self):
        super().setUp()
        self.granule("2015-06-01T10:45:00.000Z")
        self.aqua("2015-06-01T10:47Z", 31.0, 31.0)
        self.first = self.snpp("2015-06-01T10:40Z", 31.0, 31.0)
        self.run_step()

    def test_unchanged_region_year_is_skipped(self):
        before = self.rows()
        report = self.run_step()
        self.assertEqual(self.rows(), before)
        self.assertTrue(self.logged[-1].startswith("box:2015: unchanged, skipped"))
        self.assertEqual(report["regions"][0]["years_done"], [2015])

    def test_new_rows_or_parameters_redo_the_region_year(self):
        second = self.snpp("2015-06-01T10:40Z", *offset(31.0, 31.0, 0.1, 0.0))
        self.run_step()
        self.assertEqual(self.rows()[second][2], 0.5)
        self.assertEqual(self.rows()[self.first][2], 0.5)
        self.run_step(window=4)
        self.assertEqual(self.rows(), {})
        self.assertIn("box:2015: 2 candidates, 0 covered", self.logged[-1])

    def test_rows_of_vanished_hotspots_are_deleted(self):
        with self.con:
            self.con.execute("DELETE FROM hotspots WHERE hotspot_id = ?", (self.first,))
        report = self.run_step()
        self.assertEqual(self.rows(), {})
        self.assertEqual(report["orphans_deleted"], 1)
        with self.con:
            self.con.execute("INSERT INTO matchups VALUES ('ffffffffffffffff', 'g', 0, 0, 0)")
        report = self.run_step()
        self.assertEqual(report["orphans_deleted"], 1)

    def test_stops_while_hotspots_is_rebuilt(self):
        with self.con:
            self.con.execute("DROP INDEX hotspots_hotspot_id")
        with self.assertRaises(matchups.HotspotsNotReady):
            self.run_step()


class Report(Fixture):
    def test_frp_bins(self):
        self.assertEqual([matchups.frp_bin(x) for x in (0.1, 0.5, 0.99, 1, 255, 256, 900)],
                         [0, 1, 1, 2, 9, 10, 10])

    def test_trend_flags(self):
        params = {"window_min": 15.0, "tol": 1.5, "sweep": [1.5]}
        entry = dict(matchups._new_stats([1.5]), params=params)
        n = len(matchups.FRP_EDGES) + 1
        entry["frp"] = {"covered": [0, 40, 40, 40] + [0] * (n - 4),
                        "positive": [0, 4, 8, 20] + [0] * (n - 4),
                        "label_sum": [0, 2.0, 3.0, 2.5] + [0] * (n - 4)}
        status = {"box": {y: {"complete": True} for y in matchups.calibration_years()}}
        region = matchups.summarize({"box:2015": entry}, params, status, CFG["regions"],
                                    matchups.calibration_years())[0]
        self.assertTrue(region["positive_rises_with_frp"])
        self.assertFalse(region["rises_with_frp"])
        self.assertEqual(region["frp_drops"], [{"frp_lo": [1, 2], "mean_label": [0.075, 0.0625]}])

    def test_raw_file_status_for_api_windows(self):
        region = {"id": "box", "history": "api", "countries": []}
        with self.con:
            self.con.executemany(
                "INSERT INTO raw_files(file_key, kind, source, url, status, fetched_at) "
                "VALUES (?, 'api', 'modis', 'u', ?, ?)",
                [("api:MODIS_SP:box:2014-12-30:5", "done", "2026-11-13T10:00:00+00:00"),
                 ("api:VIIRS_SNPP_SP:box:2015-06-01:5", "pending", None),
                 ("api:VIIRS_SNPP_SP:box:2016-03-01:5", "done", "2026-11-13T12:00:00+00:00"),
                 ("api:VIIRS_SNPP_SP:other:2017-03-01:5", "done", None)])
        status = matchups.raw_file_status(self.con, region, [2014, 2015, 2016, 2017],
                                          "2026-11-13T11:00:00+00:00")
        self.assertEqual({y: (s["files"], s["pending"], s["after_normalize"], s["complete"])
                          for y, s in status.items()},
                         {2014: (1, 0, 0, True), 2015: (2, 1, 0, False),
                          2016: (1, 0, 1, False), 2017: (0, 0, 0, False)})


class Cli(unittest.TestCase):
    def test_discovered(self):
        self.assertIn("matchups", cli.discover_steps())

    def test_years(self):
        self.assertEqual(matchups._years("2012-2014,2019"), [2012, 2013, 2014, 2019])
        with self.assertRaises(argparse.ArgumentTypeError):
            matchups._years("2011-2013")


if __name__ == "__main__":
    unittest.main()
