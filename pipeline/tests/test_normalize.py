import hashlib
import sqlite3
import tempfile
import unittest
from pathlib import Path

from hotornot import cli, db, grid
from hotornot.ingest import ingest
from hotornot.steps import normalize

RAW_COLUMNS = ("file_id", "region_id", "in_box", "source", "satellite", "latitude", "longitude",
               "acq_date", "acq_time", "bright_mir", "bright_tir", "scan", "track", "confidence",
               "version", "frp", "daynight", "type", "processing")
SOURCE = {"Terra": "modis", "Aqua": "modis", "S-NPP": "viirs-snpp", "NOAA-20": "viirs-jpss1"}


class Fixture(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.con = db.connect(Path(tmp.name) / "pipeline.sqlite")
        self.addCleanup(self.con.close)
        self.con.executescript(ingest.SCHEMA)
        self.con.execute("CREATE INDEX raw_hotspots_region_date "
                         "ON raw_hotspots(region_id, source, acq_date)")
        self.next_file = 1

    def add_file(self, kind="country", status="done", fetched_at="2026-11-13T10:00:00+00:00",
                 file_key=None, source="viirs-snpp"):
        file_id = self.next_file
        self.next_file += 1
        self.con.execute(
            "INSERT INTO raw_files(file_id, file_key, kind, source, url, status, fetched_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (file_id, file_key or f"file{file_id}", kind, source, "url", status, fetched_at))
        self.con.commit()
        return file_id

    def add_row(self, file_id, satellite="S-NPP", lat=30.6, lon=31.2, acq_date="2025-03-04",
                acq_time="1130", processing="SP", region_id="nile_delta", in_box=1, **extra):
        row = {"file_id": file_id, "region_id": region_id, "in_box": in_box,
               "source": SOURCE[satellite], "satellite": satellite, "latitude": lat,
               "longitude": lon, "acq_date": acq_date, "acq_time": acq_time,
               "bright_mir": 330.0, "bright_tir": 290.0, "scan": 0.4, "track": 0.37,
               "confidence": "n", "version": "2", "frp": 1.5, "daynight": "D",
               "type": 0 if processing == "SP" else None, "processing": processing}
        row.update(extra)
        self.con.execute(f"INSERT INTO raw_hotspots({', '.join(RAW_COLUMNS)}) "
                         f"VALUES ({', '.join('?' * len(RAW_COLUMNS))})",
                         [row[c] for c in RAW_COLUMNS])
        self.con.commit()
        return normalize.hotspot_id(satellite, acq_date, acq_time, lat, lon)

    def run_normalize(self, **kwargs):
        return normalize.normalize(self.con, log=lambda *_: None, **kwargs)

    def table(self):
        return self.con.execute("SELECT * FROM hotspots ORDER BY hotspot_id").fetchall()

    def row(self, hotspot_id):
        cur = self.con.execute("SELECT * FROM hotspots WHERE hotspot_id = ?", (hotspot_id,))
        names = [d[0] for d in cur.description]
        found = cur.fetchone()
        return dict(zip(names, found)) if found else None


class Mapping(Fixture):
    def test_hotspot_id_follows_contract(self):
        key = "S-NPP|2025-03-04|1130|30.60000|-60.20000"
        self.assertEqual(normalize.hotspot_id("S-NPP", "2025-03-04", "1130", 30.6, -60.2),
                         hashlib.sha1(key.encode()).hexdigest()[:16])

    def test_columns(self):
        f = self.add_file()
        hid = self.add_row(f, satellite="S-NPP", lat=30.6, lon=31.2, acq_date="2025-12-31",
                           acq_time="0042", daynight="N", frp=2.25, scan=0.52, track=0.41,
                           confidence="h", type=2)
        self.run_normalize()
        self.assertEqual(self.row(hid), {
            "hotspot_id": hid, "region_id": "nile_delta", "in_box": 1, "satellite": "S-NPP",
            "sensor": "VIIRS_375", "acq_utc": "2025-12-31T00:42Z", "acq_date": "2025-12-31",
            "ym": 202512, "lat": 30.6, "lon": 31.2, "daynight": "N", "frp_mw": 2.25,
            "scan_km": 0.52, "track_km": 0.41, "confidence": "h", "fire_type": 2,
            "processing": "SP", "cell_id": 17370624, "tile_id": "n30e031", "file_id": f})

    def test_modis_nrt_and_buffer_rows(self):
        f = self.add_file(kind="api", source="modis")
        hid = self.add_row(f, satellite="Terra", lat=-33.5, lon=-60.2, region_id="n_argentina",
                           in_box=0, processing="NRT", confidence="73", version="6.1NRT")
        self.run_normalize()
        row = self.row(hid)
        self.assertEqual((row["sensor"], row["processing"], row["fire_type"], row["in_box"]),
                         ("MODIS", "NRT", None, 0))
        self.assertEqual(row["confidence"], "73")
        self.assertEqual(row["tile_id"], "s34w061")

    def test_grid_matches_grid_module(self):
        f = self.add_file()
        points = [(29.8, 29.5), (31.8, 32.5), (30.05, 31.05), (30.999999, 31.0000001),
                  (-28.0, 154.0), (-35.0, -66.0), (42.0, -114.0)]
        for i, (lat, lon) in enumerate(points):
            self.add_row(f, lat=lat, lon=lon, acq_time=f"{i:04d}")
        self.run_normalize()
        for lat, lon, cell_id, tile_id in self.con.execute(
                "SELECT lat, lon, cell_id, tile_id FROM hotspots"):
            expected = grid.cell_of(lat, lon)[2]
            self.assertEqual((cell_id, tile_id), (expected, grid.tile_of(expected)))

    def test_viirs_confidence_words(self):
        f = self.add_file(kind="global7d", source="viirs-jpss1")
        ids = [self.add_row(f, satellite="NOAA-20", acq_time=f"00{i}0", confidence=c,
                            processing="NRT", acq_date="2026-11-10")
               for i, c in enumerate(["low", "nominal", "high"])]
        self.run_normalize()
        self.assertEqual([self.row(h)["confidence"] for h in ids], ["l", "n", "h"])

    def test_unfinished_files_are_ignored(self):
        done = self.add_file()
        kept = self.add_row(done)
        for status in ("pending", "error"):
            self.add_row(self.add_file(status=status), acq_time="2200")
        report = self.run_normalize()
        self.assertEqual([r[0] for r in self.table()], [kept])
        self.assertEqual(report["files_not_done"], 2)


class Duplicates(Fixture):
    def test_sp_beats_newer_nrt(self):
        sp = self.add_file(fetched_at="2026-01-01T00:00:00+00:00")
        nrt = self.add_file(kind="api", fetched_at="2026-11-13T00:00:00+00:00")
        hid = self.add_row(nrt, processing="NRT")
        self.assertEqual(self.add_row(sp), hid)
        report = self.run_normalize()
        self.assertEqual(len(self.table()), 1)
        self.assertEqual((self.row(hid)["file_id"], self.row(hid)["processing"]), (sp, "SP"))
        self.assertEqual(report["duplicates_dropped"], 1)

    def test_bordering_country_files_collapse_to_latest_fetch(self):
        argentina = self.add_file(fetched_at="2026-11-13T10:00:00+00:00")
        paraguay = self.add_file(fetched_at="2026-11-13T11:00:00+00:00")
        uruguay = self.add_file(fetched_at="2026-11-13T09:00:00+00:00")
        for f in (argentina, paraguay, uruguay):
            hid = self.add_row(f, region_id="n_argentina", lat=-25.3, lon=-57.6, frp=float(f))
        report = self.run_normalize()
        self.assertEqual(len(self.table()), 1)
        self.assertEqual((self.row(hid)["file_id"], self.row(hid)["frp_mw"]),
                         (paraguay, float(paraguay)))
        self.assertEqual(report["duplicates_dropped"], 2)

    def test_sp_day_drops_nrt_rows_with_other_coordinates(self):
        sp = self.add_file()
        nrt = self.add_file(kind="global7d")
        self.add_row(sp, lat=30.6, lon=31.2)
        moved = self.add_row(nrt, lat=30.6004, lon=31.2003, processing="NRT")
        other_satellite = self.add_row(nrt, satellite="NOAA-20", processing="NRT")
        other_day = self.add_row(nrt, acq_date="2025-03-05", processing="NRT")
        other_region = self.add_row(nrt, region_id="california", lat=36.0, lon=-120.0,
                                    processing="NRT")
        report = self.run_normalize()
        ids = {r[0] for r in self.table()}
        self.assertNotIn(moved, ids)
        self.assertLessEqual({other_satellite, other_day, other_region}, ids)
        self.assertEqual(report["nrt_replaced_by_sp"], 1)

    def test_sp_day_rule_is_per_satellite(self):
        sp = self.add_file(source="modis")
        nrt = self.add_file(kind="api", source="modis")
        self.add_row(sp, satellite="Terra")
        aqua = self.add_row(nrt, satellite="Aqua", processing="NRT")
        terra = self.add_row(nrt, satellite="Terra", lat=30.7, processing="NRT")
        self.run_normalize()
        ids = {r[0] for r in self.table()}
        self.assertIn(aqua, ids)
        self.assertNotIn(terra, ids)

    def test_empty_sp_window_still_replaces_nrt(self):
        self.add_file(kind="api", source="modis", file_key="api:MODIS_SP:california:2026-08-28:5")
        self.add_file(kind="api", source="viirs-snpp",
                      file_key="api:VIIRS_SNPP_NRT:california:2026-09-01:5")
        nrt = self.add_file(kind="api", source="modis")
        args = dict(region_id="california", lat=36.0, lon=-120.0, processing="NRT")
        inside = self.add_row(nrt, satellite="Aqua", acq_date="2026-09-01", **args)
        after = self.add_row(nrt, satellite="Aqua", acq_date="2026-09-02", **args)
        other_region = self.add_row(nrt, satellite="Aqua", acq_date="2026-08-30",
                                    region_id="nile_delta", processing="NRT")
        self.run_normalize()
        ids = {r[0] for r in self.table()}
        self.assertNotIn(inside, ids)
        self.assertLessEqual({after, other_region}, ids)


class Reruns(Fixture):
    def populate(self):
        files = [self.add_file(fetched_at=f"2026-11-13T0{i}:00:00+00:00") for i in range(3)]
        for i in range(30):
            self.add_row(files[i % 3], lat=30 + i / 50,
                         acq_date=f"2025-{i % 12 + 1:02d}-0{i % 9 + 1}",
                         satellite=("S-NPP", "NOAA-20", "Aqua")[i % 3])
        return files

    def test_rerun_gives_the_same_table(self):
        self.populate()
        first = self.run_normalize()
        before = self.table()
        second = self.run_normalize(batch_rows=7)
        self.assertEqual(self.table(), before)
        self.assertEqual(len(before), 30)
        self.assertEqual((first["written"]["transactions"], second["written"]["transactions"]),
                         (1, 5))
        for key in ("raw_rows", "rows", "duplicates_dropped", "in_box"):
            self.assertEqual(first[key], second[key])

    def test_rerun_applies_new_and_withdrawn_files(self):
        files = self.populate()
        self.run_normalize()
        newer = self.add_file()
        added = self.add_row(newer, lat=35.0, acq_date="2026-01-15")
        replaced = self.add_row(newer, lat=30.0, acq_date="2025-01-01", frp=9.0)
        self.con.execute("UPDATE raw_files SET status = 'error' WHERE file_id = ?", (files[1],))
        self.con.commit()
        self.run_normalize()
        self.assertEqual(len(self.table()), 21)
        self.assertEqual(self.row(added)["file_id"], newer)
        self.assertEqual((self.row(replaced)["file_id"], self.row(replaced)["frp_mw"]),
                         (newer, 9.0))
        self.assertEqual(self.con.execute(
            "SELECT COUNT(*) FROM hotspots WHERE file_id = ?", (files[1],)).fetchone()[0], 0)

    def test_old_table_is_replaced(self):
        self.con.execute("CREATE TABLE hotspots (hotspot_id TEXT PRIMARY KEY, extra INT)")
        self.con.execute("INSERT INTO hotspots VALUES ('x', 1)")
        self.con.commit()
        self.populate()
        self.run_normalize()
        columns = tuple(r[1] for r in self.con.execute("PRAGMA table_info(hotspots)"))
        self.assertEqual(columns, normalize.COLUMNS)
        self.assertEqual(len(self.table()), 30)


class Report(Fixture):
    def test_report_and_indexes(self):
        sp = self.add_file()
        nrt = self.add_file(kind="api")
        self.add_row(sp, acq_date="2024-06-01")
        self.add_row(sp, acq_date="2025-06-01")
        self.add_row(sp, acq_date="2025-06-02", in_box=0)
        self.add_row(nrt, acq_date="2025-06-03", processing="NRT")
        self.add_row(nrt, acq_date="2025-06-01", lat=30.61, processing="NRT")
        self.add_row(sp, satellite="Aqua", acq_date="2025-06-01")
        report = self.run_normalize()
        self.assertEqual(db.get_artifact("normalize:report", self.con), report)
        self.assertEqual(report["in_box"], [
            {"region_id": "nile_delta", "satellite": "Aqua", "year": 2025, "rows": 1,
             "nrt_rows": 0},
            {"region_id": "nile_delta", "satellite": "S-NPP", "year": 2024, "rows": 1,
             "nrt_rows": 0},
            {"region_id": "nile_delta", "satellite": "S-NPP", "year": 2025, "rows": 2,
             "nrt_rows": 1},
        ])
        self.assertEqual((report["raw_rows"], report["rows"], report["nrt_replaced_by_sp"]),
                         (6, 5, 1))
        self.assertEqual(report["nrt_share"], 0.25)
        indexes = {r[1]: r[2] for r in self.con.execute("PRAGMA index_list(hotspots)")}
        self.assertEqual(indexes, {"hotspots_hotspot_id": 1, "hotspots_region_satellite_date": 0,
                                   "hotspots_cell": 0, "hotspots_tile": 0})
        with self.assertRaises(sqlite3.IntegrityError):
            self.con.execute("INSERT INTO hotspots SELECT * FROM hotspots LIMIT 1")
        self.assertEqual(self.con.execute(
            "SELECT COUNT(*) - COUNT(DISTINCT hotspot_id) FROM hotspots").fetchone()[0], 0)

    def test_step_is_discovered(self):
        self.assertIs(cli.discover_steps()["normalize"], normalize)


if __name__ == "__main__":
    unittest.main()
