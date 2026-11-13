import contextlib
import gzip
import hashlib
import io
import itertools
import json
import os
import sqlite3
import tempfile
import unittest
from collections import defaultdict
from pathlib import Path
from unittest import mock

from hotornot import cli, config, db, grid
from hotornot.steps import normalize, publish, series

REGIONS = [
    {"id": "nile_delta", "name": "Nile Delta, Egypt", "bbox": [30.9, 30.8, 31.1, 31.0],
     "history": "country_files", "countries": ["Egypt"], "excluded_countries": []},
    {"id": "n_argentina", "name": "Northern Argentina and Paraguayan Chaco",
     "bbox": [-58.2, -22.2, -57.8, -21.9], "history": "country_files",
     "countries": ["Argentina"], "excluded_countries": ["Brazil"]},
]
CFG = {"buffer_deg": 0.5, "regions": REGIONS}
# "Brazil" covers the n_argentina cells centered east of -58.0 and north of -22.1.
BRAZIL = {"type": "Polygon", "coordinates": [[[-58.0, -22.1], [-57.0, -22.1], [-57.0, -21.0],
                                              [-58.0, -21.0], [-58.0, -22.1]]]}

CONTRACT_TABLES = {
    "meta": (["key", "value"], ["key"], False),
    "regions": (["region_id", "name", "bbox", "sp_until", "nrt_until", "tiles"], ["region_id"], False),
    "region_cells": (["region_id", "cell_id", "covered"], ["region_id", "cell_id"], True),
    "cells": (["region_id", "cell_id", "ym", "harmonized", "modis_raw", "viirs_raw", "points"],
              ["region_id", "cell_id", "ym"], True),
    "months": (["region_id", "ym", "terra_only", "viirs_source", "viirs_missing_days",
                "provisional", "days_covered"], ["region_id", "ym"], False),
    "cell_days": (["region_id", "cell_id", "year", "day", "harmonized"],
                  ["region_id", "cell_id", "year", "day"], True),
}
CONTRACT_TILE_HEADER = ("hotspot_id,satellite,sensor,acq_utc,acq_date,lat,lon,daynight,frp_mw,"
                        "confidence,fire_type,processing,in_series,weight,weight_method,cell_id")


def quiet(*_):
    pass


def read_tile(path):
    with gzip.open(path, "rt", newline="") as f:
        text = f.read()
    lines = text.split("\n")
    assert lines.pop() == ""
    return lines[0], [dict(zip(lines[0].split(","), line.split(","))) for line in lines[1:]]


class Fixture(unittest.TestCase):
    """A small pipeline database with every role, buffer rows, an excluded country and two
    tiles per region."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        env = mock.patch.dict(os.environ, {"HOTORNOT_DB": str(self.tmp / "db" / "t.sqlite")})
        env.start()
        self.addCleanup(env.stop)
        patch = mock.patch.object(config, "load_config", return_value=CFG)
        patch.start()
        self.addCleanup(patch.stop)
        self.con = db.connect()
        self.addCleanup(self.con.close)
        self.out = self.tmp / "db" / "publish"
        self.ids = itertools.count()
        self.rows = []
        with self.con:
            db.recreate(self.con, normalize.DDL)
            db.recreate(self.con, series.SERIES_DDL)
            self.con.execute(series.WEIGHTS_DDL)
            db.recreate(self.con, series.SMALL_DDL)
            self.con.execute("CREATE TABLE country_boundaries (name TEXT NOT NULL, iso_a3 TEXT, "
                             "geometry TEXT NOT NULL)")
            self.con.execute("INSERT INTO country_boundaries VALUES ('Brazil', 'BRA', ?)",
                             (json.dumps(BRAZIL),))
            self.fixture()
            for ddl in normalize.INDEXES_AFTER_LOAD.values():
                self.con.execute(ddl)
            self.small_tables()
        db.put_artifact("normalize:report", {"rows": len(self.rows)}, self.con)
        normalized_at = self.con.execute(
            "SELECT created_at FROM artifacts WHERE name = 'normalize:report'").fetchone()[0]
        db.put_artifact("series:report", {"inputs": {"normalize": normalized_at}}, self.con)
        db.put_artifact("series:dates", {
            "nile_delta": {"sp_until": "2026-07-31", "nrt_until": "2026-11-13"},
            "n_argentina": {"sp_until": "2026-07-31", "nrt_until": "2026-11-10"}}, self.con)

    def add(self, region, satellite, utc, lat, lon, role, weight=None, model=None, in_box=1,
            fire_type=0, processing="SP", frp=1.5):
        hid = hashlib.sha1(str(next(self.ids)).encode()).hexdigest()[:16]
        sensor = "MODIS" if satellite in ("Terra", "Aqua") else "VIIRS_375"
        _, _, cell = grid.cell_of(lat, lon)
        if processing == "NRT":
            fire_type = None
        row = (hid, region, in_box, satellite, sensor, utc, utc[:10], int(utc[:4] + utc[5:7]), lat,
               lon, "D", frp, 0.4, 0.4, "n" if sensor != "MODIS" else "80", fire_type, processing,
               cell, grid.tile_of(cell), 1)
        self.con.execute(f"INSERT INTO hotspots VALUES ({', '.join('?' * len(row))})", row)
        self.con.execute("INSERT INTO series VALUES (?, ?, ?)",
                         (hid, int(role in series.IN_SERIES), role))
        for method, w in (("ratio_v1", weight), ("model_v1", model)):
            if w is not None:
                self.con.execute("INSERT INTO weights VALUES (?, ?, ?)", (hid, method, w))
        self.rows.append({"hotspot_id": hid, "region": region, "satellite": satellite,
                          "utc": utc, "cell": cell, "tile": grid.tile_of(cell), "role": role,
                          "weight": weight, "model": model, "in_box": in_box,
                          "fire_type": fire_type})
        return hid

    def fixture(self):
        add = self.add
        a, b, c = (30.85, 30.95), (30.85, 31.05), (30.95, 31.05)
        add("nile_delta", "Terra", "2001-03-05T10:30Z", *a, "modis")
        add("nile_delta", "Aqua", "2005-11-02T11:00Z", *a, "modis")
        add("nile_delta", "Terra", "2011-11-20T09:00Z", *b, "non_vegetation", fire_type=2)
        add("nile_delta", "Aqua", "2015-11-03T11:10Z", *b, "modis_overlap")
        self.late = add("nile_delta", "S-NPP", "2015-11-03T11:20Z", *b, "snpp", 0.1, 0.11)
        self.early = add("nile_delta", "S-NPP", "2015-11-03T10:40Z", *b, "snpp", 0.1, 0.09)
        add("nile_delta", "NOAA-20", "2015-11-03T12:10Z", *b, "n20_overlap", 0.12, 0.13)
        add("nile_delta", "S-NPP", "2015-11-03T11:20Z", 30.85, 31.3, "snpp", 0.1, 0.1, in_box=0)
        add("nile_delta", "S-NPP", "2026-10-05T11:00Z", *c, "static_masked", processing="NRT")
        add("nile_delta", "NOAA-20", "2026-11-03T11:00Z", *a, "n20", 0.2, 0.25, processing="NRT")
        add("nile_delta", "NOAA-20", "2026-11-13T11:00Z", *c, "n20", 0.2, 0.25, processing="NRT")
        add("n_argentina", "Aqua", "2010-08-01T14:00Z", -22.15, -58.15, "modis")
        add("n_argentina", "S-NPP", "2020-08-01T05:00Z", -21.95, -57.9, "snpp", 0.3, 0.32)
        add("n_argentina", "NOAA-20", "2022-08-01T05:00Z", -21.95, -58.05, "n20_gapfill", 0.31, 0.3)
        add("n_argentina", "S-NPP", "2026-11-10T05:00Z", -22.15, -58.15, "snpp", 0.3, 0.32,
            processing="NRT")
        add("n_argentina", "Terra", "2020-08-01T14:00Z", -21.95, -57.9, "modis_overlap")

    def small_tables(self):
        months = []
        for r in REGIONS:
            for y, m, *_ in series.month_starts("2000-11-01", "2026-11-01"):
                days = {"nile_delta": 13, "n_argentina": 10}[r["id"]] if (y, m) == (2026, 11) else 30
                months.append((r["id"], y * 100 + m, int(y * 100 + m < 200207),
                               None if y < 2012 else "SNPP", 0, int(y == 2026 and m >= 8), days))
            for month in range(1, 13):
                for satellite, factor in (("S-NPP", 0.1), ("NOAA-20", 0.12)):
                    self.con.execute("INSERT INTO ratio_factors VALUES (?, ?, ?, ?, ?)",
                                     (r["id"], month, satellite, round(factor + month / 1000, 3),
                                      "region_month"))
        self.con.executemany("INSERT INTO months VALUES (?, ?, ?, ?, ?, ?, ?)", months)

    def publish(self, **kwargs):
        kwargs.setdefault("out_dir", self.out)
        return publish.publish(self.con, CFG, log=quiet, **kwargs)

    def serving(self, version="v1"):
        con = sqlite3.connect(self.out / version / "serving.sqlite")
        self.addCleanup(con.close)
        return con

    def expected_cells(self, method="ratio_v1"):
        out = defaultdict(lambda: [0.0, 0, 0, 0])
        for r in self.rows:
            if not r["in_box"]:
                continue
            key = (r["region"], r["cell"], int(r["utc"][:4] + r["utc"][5:7]))
            c = out[key]
            if r["role"] in series.IN_SERIES:
                c[0] += 1.0 if r["role"] == "modis" else r["weight" if method == "ratio_v1" else "model"]
                c[2] += r["role"] != "modis"
            c[1] += r["role"] in ("modis", "modis_overlap")
            c[3] += 1
        return out


class Schema(Fixture):
    def test_tables_and_columns_match_contracts(self):
        self.publish()
        con = self.serving()
        names = [r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")]
        self.assertEqual(names, sorted(CONTRACT_TABLES))
        for table, (columns, pk, without_rowid) in CONTRACT_TABLES.items():
            info = con.execute(f"PRAGMA table_info({table})").fetchall()
            self.assertEqual([c[1] for c in info], columns, table)
            self.assertEqual([c[1] for c in sorted((c for c in info if c[5]), key=lambda c: c[5])],
                             pk, table)
            sql = con.execute("SELECT sql FROM sqlite_master WHERE name = ?", (table,)).fetchone()[0]
            self.assertEqual("WITHOUT ROWID" in sql.upper(), without_rowid, table)
        self.assertEqual(con.execute("PRAGMA journal_mode").fetchone()[0], "delete")
        self.assertEqual(sorted(p.name for p in (self.out / "v1").iterdir()), ["points", "serving.sqlite"])
        self.assertEqual(publish.TILE_HEADER, CONTRACT_TILE_HEADER)

    def test_latest_json_versions_and_pruning(self):
        self.publish()
        latest = json.loads((self.out / "latest.json").read_text())
        self.assertEqual(set(latest), {"version", "published_at"})
        self.assertEqual(latest["version"], "v1")
        self.assertRegex(latest["published_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.publish(keep=0)
        self.publish(keep=2)
        self.assertEqual(json.loads((self.out / "latest.json").read_text())["version"], "v3")
        self.assertEqual(publish.versions_in(self.out), ["v2", "v3"])
        self.assertEqual([p.name for p in self.out.iterdir() if p.name.startswith(".")], [])
        meta = dict(self.serving("v3").execute("SELECT key, value FROM meta"))
        self.assertEqual(json.loads(meta["metadata"])["data_version"], "v3")

    def test_next_version_counts_every_directory_and_latest(self):
        a, b = self.tmp / "a", self.tmp / "b"
        (a / "v2").mkdir(parents=True)
        (a / "v10x").mkdir()
        b.mkdir()
        (b / "latest.json").write_text('{"version": "v7", "published_at": "x"}')
        self.assertEqual(publish.next_version([a, b, self.tmp / "missing"]), "v8")
        self.assertEqual(publish.next_version([self.tmp / "missing"]), "v1")


class Contents(Fixture):
    def setUp(self):
        super().setUp()
        self.report = self.publish()
        self.db = self.serving()

    def test_cells_are_the_sums_of_in_box_rows(self):
        got = {(r, c, ym): [h, m, v, p] for r, c, ym, h, m, v, p in self.db.execute("SELECT * FROM cells")}
        expected = self.expected_cells()
        self.assertEqual(set(got), set(expected))
        for key, (h, m, v, p) in expected.items():
            self.assertAlmostEqual(got[key][0], h, places=12, msg=key)
            self.assertEqual(got[key][1:], [m, v, p], key)
        # A cell-month with only rows outside the series still has a row, with harmonized 0.
        self.assertEqual(got["nile_delta", grid.cell_of(30.85, 31.05)[2], 201111], [0.0, 0, 0, 1])

    def test_tiles_follow_contracts(self):
        regions = {rid: json.loads(t) for rid, t in self.db.execute("SELECT region_id, tiles FROM regions")}
        for rid in ("nile_delta", "n_argentina"):
            expected = sorted({r["tile"] for r in self.rows if r["region"] == rid and r["in_box"]})
            self.assertEqual(regions[rid], expected)
            self.assertEqual(len(expected), 2 if rid == "nile_delta" else 3)
            files = sorted(p.name for p in (self.out / "v1" / "points" / rid).iterdir())
            self.assertEqual(files, [f"{t}.csv.gz" for t in expected])
        points = dict(self.db.execute("SELECT region_id, SUM(points) FROM cells GROUP BY 1"))
        tile_rows = defaultdict(int)
        by_id = {}
        for rid, tiles in regions.items():
            for tile in tiles:
                header, rows = read_tile(self.out / "v1" / "points" / rid / f"{tile}.csv.gz")
                self.assertEqual(header, CONTRACT_TILE_HEADER)
                keys = [(int(r["cell_id"]), r["acq_utc"]) for r in rows]
                self.assertEqual(keys, sorted(keys))
                tile_rows[rid] += len(rows)
                by_id.update({r["hotspot_id"]: r for r in rows})
        self.assertEqual(dict(tile_rows), points)
        self.assertEqual(len(by_id), sum(r["in_box"] for r in self.rows))
        for r in self.rows:
            if not r["in_box"]:
                self.assertNotIn(r["hotspot_id"], by_id)
                continue
            t = by_id[r["hotspot_id"]]
            self.assertEqual(t["in_series"], "true" if r["role"] in series.IN_SERIES else "false")
            self.assertEqual(t["weight_method"], "ratio_v1")
            if r["role"] in ("modis", "modis_overlap"):
                self.assertEqual(t["weight"], "1")
            elif r["role"] in ("non_vegetation", "static_masked"):
                self.assertEqual(t["weight"], "")
            else:
                self.assertEqual(float(t["weight"]), r["weight"])
            self.assertEqual(t["fire_type"], "" if r["fire_type"] is None else str(r["fire_type"]))
            self.assertEqual(int(t["cell_id"]), r["cell"])
            self.assertEqual(t["acq_utc"], r["utc"])
        self.assertLess(list(by_id).index(self.early), list(by_id).index(self.late))

    def test_region_cells_and_coverage(self):
        for region in REGIONS:
            rows = self.db.execute("SELECT cell_id, covered FROM region_cells WHERE region_id = ? "
                                   "ORDER BY cell_id", (region["id"],)).fetchall()
            self.assertEqual([c for c, _ in rows], grid.cells_in_bbox(region["bbox"]))
            expected = {c: 0 if region["id"] == "n_argentina" and grid.center(c)[0] > -58.0
                        and grid.center(c)[1] > -22.1 else 1 for c, _ in rows}
            self.assertEqual(dict(rows), expected)
        self.assertEqual(self.report["regions"]["nile_delta"]["region_cells"], 16)
        self.assertEqual(self.report["regions"]["n_argentina"]["region_cells"], 48)
        self.assertEqual(self.report["regions"]["n_argentina"]["uncovered_cells"], 16)

    def test_cell_days_hold_the_current_calendar_month(self):
        got = {k[:4]: k[4] for k in self.db.execute("SELECT * FROM cell_days")}
        expected = defaultdict(float)
        for r in self.rows:
            if r["in_box"] and r["role"] in series.IN_SERIES and r["utc"][5:7] == "11":
                w = 1.0 if r["role"] == "modis" else r["weight"]
                expected[r["region"], r["cell"], int(r["utc"][:4]), int(r["utc"][8:10])] += w
        self.assertEqual(set(got), set(expected))
        for key, w in expected.items():
            self.assertAlmostEqual(got[key], w, places=12)

    def test_meta(self):
        meta = {k: json.loads(v) for k, v in self.db.execute("SELECT key, value FROM meta")}
        self.assertEqual(set(meta), {"metadata", "current_month", "attribution", "k_table"})
        self.assertEqual(meta["current_month"], {"year": 2026, "month": 11, "days_covered": 13})
        raw_attribution = self.db.execute("SELECT value FROM meta WHERE key = 'attribution'").fetchone()[0]
        self.assertTrue(raw_attribution.startswith('"We acknowledge'))
        md = meta["metadata"]
        self.assertEqual(list(md), ["data_version", "units", "grid_deg", "regions", "method", "attribution"])
        self.assertEqual(md["data_version"], "v1")
        self.assertEqual(md["units"], "modis_equivalent_hotspots")
        self.assertEqual(md["grid_deg"], 0.05)
        self.assertEqual(md["attribution"], meta["attribution"])
        self.assertEqual(md["method"], {"weight_method": "ratio_v1", "model_version": None,
                                        "calibration_years": "2012-2019", "baseline": "2003-2025",
                                        "viirs_switch": "2026-11-02"})
        self.assertEqual(md["regions"][1], {
            "id": "n_argentina", "name": "Northern Argentina and Paraguayan Chaco",
            "bbox": [-58.2, -22.2, -57.8, -21.9],
            "coverage": {"start": "2000-11-01", "sp_until": "2026-07-31", "nrt_until": "2026-11-10"}})
        self.assertEqual(len(meta["k_table"]), 48)
        self.assertEqual(meta["k_table"][0], {"region_id": "nile_delta", "month": 1,
                                              "satellite": "S-NPP", "value": 0.101,
                                              "level": "region_month"})
        self.assertEqual(meta["k_table"][12]["satellite"], "NOAA-20")
        regions = self.db.execute("SELECT region_id, name, bbox, sp_until, nrt_until FROM regions "
                                  "ORDER BY region_id").fetchall()
        self.assertEqual(regions[1], ("nile_delta", "Nile Delta, Egypt", "[30.9,30.8,31.1,31.0]",
                                      "2026-07-31", "2026-11-13"))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM months").fetchone()[0], 2 * 313)

    def test_tiles_are_byte_identical_on_a_rerun(self):
        self.publish(keep=0)
        for path in (self.out / "v1" / "points").rglob("*.csv.gz"):
            self.assertEqual(path.read_bytes(), (self.out / "v2" / path.relative_to(self.out / "v1")).read_bytes())

    def test_verify_passes_then_catches_a_wrong_cell(self):
        problems, table = publish.verify(self.con, CFG, self.out / "v1", "v1", log=quiet)
        self.assertEqual(problems, [])
        self.assertEqual({(r["region_id"], r["year"]) for r in table},
                         {(r["region"], int(r["utc"][:4])) for r in self.rows if r["in_box"]})
        self.assertLess(max(abs(r["diff"]) for r in table), 1e-12)
        with sqlite3.connect(self.out / "v1" / "serving.sqlite") as con:
            con.execute("UPDATE cells SET harmonized = harmonized + 0.001 WHERE ym = 201511")
        con.close()
        problems, _ = publish.verify(self.con, CFG, self.out / "v1", "v1", log=quiet)
        self.assertTrue(any("nile_delta 2015: cells.harmonized" in p for p in problems), problems)
        self.assertTrue(any("tile weights sum" in p for p in problems), problems)
        self.assertFalse(any(p.startswith("n_argentina") for p in problems), problems)

    def test_verify_catches_wrong_counts_and_unsorted_tiles(self):
        with sqlite3.connect(self.out / "v1" / "serving.sqlite") as con:
            con.execute("UPDATE cells SET modis_raw = modis_raw + 1 WHERE ym = 201008")
        con.close()
        tile = self.out / "v1" / "points" / "nile_delta" / "n30e031.csv.gz"
        header, *lines = gzip.decompress(tile.read_bytes()).decode().rstrip("\n").split("\n")
        tile.write_bytes(gzip.compress("\n".join([header, *reversed(lines), ""]).encode()))
        problems, _ = publish.verify(self.con, CFG, self.out / "v1", "v1", log=quiet)
        self.assertTrue(any(p.startswith("n_argentina 2010: pipeline rows/modis/viirs 1/1/0, "
                                         "cells points/modis_raw/viirs_raw 1/2/0") for p in problems),
                        problems)
        self.assertTrue(any(p.endswith("not sorted by cell_id, acq_utc") for p in problems), problems)


class Methods(Fixture):
    def test_validation_decision_picks_model_v1(self):
        db.put_artifact("validation:decision", {"method": "model_v1"}, self.con)
        db.put_artifact("model:model_v1", {"version": "2026-11-14", "coefficients": []}, self.con)
        db.put_artifact("validation:summary", {"decision": {"method": "model_v1"}}, self.con)
        db.put_artifact("validation:nile_delta", {"months": [], "n20": []}, self.con)
        db.put_artifact("model:detection_curve", {"frp_mw": [1, 2], "curves": []}, self.con)
        with self.con:
            self.con.execute("CREATE TABLE k_factors (region_id TEXT, month INTEGER, satellite TEXT, "
                             "k REAL, level TEXT)")
            self.con.execute("INSERT INTO k_factors VALUES ('nile_delta', 1, 'S-NPP', 2.5, 'region_year')")
        self.publish()
        con = self.serving()
        meta = {k: json.loads(v) for k, v in con.execute("SELECT key, value FROM meta")}
        self.assertEqual(set(meta), {"metadata", "current_month", "attribution", "k_table",
                                     "validation_summary", "validation:nile_delta", "detection_curve"})
        self.assertEqual(meta["metadata"]["method"]["weight_method"], "model_v1")
        self.assertEqual(meta["metadata"]["method"]["model_version"], "2026-11-14")
        self.assertEqual(meta["k_table"], [{"region_id": "nile_delta", "month": 1, "satellite": "S-NPP",
                                            "value": 2.5, "level": "region_year"}])
        got = {(r, c, ym): h for r, c, ym, h in con.execute("SELECT region_id, cell_id, ym, harmonized FROM cells")}
        for key, (h, *_) in self.expected_cells("model_v1").items():
            self.assertAlmostEqual(got[key], h, places=12)
        _, rows = read_tile(next((self.out / "v1" / "points" / "nile_delta").glob("*.gz")))
        self.assertEqual({r["weight_method"] for r in rows}, {"model_v1"})
        problems, _ = publish.verify(self.con, CFG, self.out / "v1", "v1", log=quiet)
        self.assertEqual(problems, [])

    def test_explicit_method_wins_and_fallback_is_ratio(self):
        self.assertEqual(publish.default_method(self.con), "ratio_v1")
        db.put_artifact("validation:decision", "model_v1", self.con)
        self.assertEqual(publish.default_method(self.con), "model_v1")
        self.publish(method="ratio_v1")
        meta = dict(self.serving().execute("SELECT key, value FROM meta"))
        self.assertEqual(json.loads(meta["metadata"])["method"]["weight_method"], "ratio_v1")

    def test_model_v1_needs_the_model(self):
        with self.assertRaisesRegex(publish.PublishError, "model:model_v1 does not exist"):
            self.publish(method="model_v1")


class Refusals(Fixture):
    def assert_refused(self, pattern):
        with self.assertRaisesRegex(publish.PublishError, pattern):
            self.publish()
        self.assertFalse((self.out / "latest.json").exists())
        self.assertEqual(publish.versions_in(self.out), [])

    def test_series_older_than_normalize(self):
        db.put_artifact("series:report", {"inputs": {"normalize": "2000-01-01T00:00:00+00:00"}}, self.con)
        self.assert_refused("normalize ran after series")

    def test_hotspot_without_series_row(self):
        with self.con:
            self.con.execute("DELETE FROM series WHERE hotspot_id = ?", (self.early,))
        self.assert_refused("1 in-box hotspots have no series row")

    def test_in_series_row_without_weight(self):
        with self.con:
            self.con.execute("DELETE FROM weights WHERE hotspot_id = ?", (self.early,))
        self.assert_refused("1 in-series VIIRS rows have no ratio_v1 weight")

    def test_size_limit(self):
        with mock.patch.object(publish, "MAX_SERVING_BYTES", 1000):
            self.assert_refused("the limit is")

    def test_hotspots_mid_rebuild(self):
        with self.con:
            self.con.execute("DROP INDEX hotspots_hotspot_id")
        with self.assertRaises(publish.HotspotsNotReady):
            self.publish()

    def test_failed_verify_keeps_latest(self):
        self.publish()
        with mock.patch.object(publish, "check_tiles", return_value=["broken"]):
            with self.assertRaisesRegex(publish.PublishError, "v2 was not made latest"):
                self.publish(verify_first=True)
        self.assertEqual(json.loads((self.out / "latest.json").read_text())["version"], "v1")


class CopyTo(Fixture):
    def test_copy_to_hard_links_then_replaces_latest(self):
        target = self.tmp / "web" / "public" / "data"
        self.publish(copy_to=[target])
        src, dst = self.out / "v1" / "serving.sqlite", target / "v1" / "serving.sqlite"
        self.assertEqual(src.stat().st_ino, dst.stat().st_ino)
        self.assertEqual((self.out / "latest.json").read_text(), (target / "latest.json").read_text())
        self.assertNotEqual((self.out / "latest.json").stat().st_ino, (target / "latest.json").stat().st_ino)
        with mock.patch.object(publish.os, "link", side_effect=OSError(18, "cross-device link")):
            self.publish(copy_to=[target])
        src, dst = self.out / "v2" / "serving.sqlite", target / "v2" / "serving.sqlite"
        self.assertNotEqual(src.stat().st_ino, dst.stat().st_ino)
        self.assertEqual(src.read_bytes(), dst.read_bytes())
        self.assertEqual(json.loads((target / "latest.json").read_text())["version"], "v2")
        self.assertEqual(sorted(p.relative_to(target / "v2").as_posix() for p in (target / "v2").rglob("*.gz")),
                         sorted(p.relative_to(self.out / "v2").as_posix() for p in (self.out / "v2").rglob("*.gz")))

    def test_next_version_considers_the_copy_target(self):
        target = self.tmp / "target"
        (target / "v4").mkdir(parents=True)
        self.publish(copy_to=[target], keep=0)
        self.assertEqual(publish.versions_in(self.out), ["v5"])
        self.assertEqual(publish.versions_in(target), ["v4", "v5"])

class Cli(Fixture):
    def test_step_is_discovered_and_runs(self):
        self.assertIn("publish", cli.discover_steps())
        out = io.StringIO()
        target = self.tmp / "copy"
        with contextlib.redirect_stdout(out):
            status = cli.main(["publish", "--copy-to", str(target), "--verify"])
        self.assertEqual(status, 0, out.getvalue())
        self.assertIn("largest |difference|", out.getvalue())
        self.assertIn("serving.sqlite", out.getvalue())
        self.assertTrue((self.out / "v1" / "serving.sqlite").exists())
        self.assertTrue((target / "latest.json").exists())
        report = db.get_artifact("publish:report", self.con)
        self.assertEqual(report["version"], "v1")
        self.assertEqual(report["verify"]["problems"], [])


if __name__ == "__main__":
    unittest.main()
