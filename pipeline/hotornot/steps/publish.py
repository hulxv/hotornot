"""Publish the pipeline database as the files the web app reads (CONTRACTS "Published data"):

    publish/latest.json
    publish/vN/serving.sqlite
    publish/vN/points/<region_id>/<tile_id>.csv.gz

`publish/` sits next to $HOTORNOT_DB, so every checkout adds to one version history. A version
is built in `.vN.partial` and renamed when complete, and latest.json is replaced last, here and
in every --copy-to or --upload target, so a reader never sees half a version.

Series roles and weights are loaded once into id-sorted arrays (about 230 MB for 13M hotspots)
instead of being joined per row, which reads `series` and `weights` at random. Hotspots are
read region by region and month by month, the order normalize stored them in, one short read
per query. Tile rows are staged per tile as gzip members and sorted when the region is done.
"""
import gzip
import json
import math
import os
import re
import shutil
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from array import array
from bisect import bisect_left
from collections import Counter, defaultdict
from datetime import UTC, date, datetime
from pathlib import Path

from hotornot import config, db, geo, grid
from hotornot.steps.matchups import HotspotsNotReady, hotspots_version
from hotornot.steps.series import IN_SERIES, MODIS_ROLES, ROLE_INDEX, ROLES, SATELLITES, month_starts

NAME = "publish"
HELP = "Build serving.sqlite and point tiles as a new data version; optionally copy or upload it."

METHODS = ("ratio_v1", "model_v1")
FALLBACK_METHOD = "ratio_v1"
UNITS = "modis_equivalent_hotspots"
MAX_SERVING_BYTES = 150_000_000
TOLERANCE = 1e-6
VERSION_NAME = re.compile(r"v([1-9]\d*)")

TILE_COLUMNS = ("hotspot_id", "satellite", "sensor", "acq_utc", "acq_date", "lat", "lon",
                "daynight", "frp_mw", "confidence", "fire_type", "processing", "in_series",
                "weight", "weight_method", "cell_id")
TILE_HEADER = ",".join(TILE_COLUMNS)
# A staged tile line starts with its sort key: cell_id as 8 digits, acq_utc (always
# YYYY-MM-DDTHH:MMZ) and hotspot_id (16 hex digits).
SORT_KEY_LEN = 8 + 17 + 16
STAGE_FLUSH_LINES = 300_000
TILE_WRITE_LINES = 50_000

ATTRIBUTION = (
    "We acknowledge the use of data and imagery from NASA's Fire Information for Resource "
    "Management System (FIRMS) (https://www.earthdata.nasa.gov/data/tools/firms), part of "
    "NASA's Earth Science Data and Information System (ESDIS). Sources: MODIS Collection 6.1 "
    "active fires (Terra, Aqua); VIIRS 375 m active fires (S-NPP VNP14IMG, NOAA-20 VJ114IMG); "
    "Natural Earth boundaries.")

SERVING_DDL = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE regions (region_id TEXT PRIMARY KEY, name TEXT NOT NULL, bbox TEXT NOT NULL,
  sp_until TEXT NOT NULL, nrt_until TEXT NOT NULL, tiles TEXT NOT NULL);
CREATE TABLE region_cells (region_id TEXT NOT NULL, cell_id INTEGER NOT NULL,
  covered INTEGER NOT NULL, PRIMARY KEY (region_id, cell_id)) WITHOUT ROWID;
CREATE TABLE cells (region_id TEXT NOT NULL, cell_id INTEGER NOT NULL, ym INTEGER NOT NULL,
  harmonized REAL NOT NULL, modis_raw INTEGER NOT NULL, viirs_raw INTEGER NOT NULL,
  points INTEGER NOT NULL, PRIMARY KEY (region_id, cell_id, ym)) WITHOUT ROWID;
CREATE TABLE months (region_id TEXT NOT NULL, ym INTEGER NOT NULL, terra_only INTEGER NOT NULL,
  viirs_source TEXT, viirs_missing_days INTEGER NOT NULL, provisional INTEGER NOT NULL,
  days_covered INTEGER NOT NULL, PRIMARY KEY (region_id, ym));
CREATE TABLE cell_days (region_id TEXT NOT NULL, cell_id INTEGER NOT NULL, year INTEGER NOT NULL,
  day INTEGER NOT NULL, harmonized REAL NOT NULL,
  PRIMARY KEY (region_id, cell_id, year, day)) WITHOUT ROWID;
"""

HOTSPOT_SQL = """
SELECT hotspot_id, satellite, sensor, acq_utc, acq_date, lat, lon, daynight, frp_mw, confidence,
       fire_type, processing, cell_id, tile_id
FROM hotspots
WHERE region_id = ? AND satellite = ? AND acq_date >= ? AND acq_date < ? AND in_box = 1"""

MODIS_KIND, VIIRS_KIND, UNWEIGHTED_KIND = 0, 1, 2
# Per role code: (in_series text, adds to harmonized, modis_raw step, viirs_raw step, kind).
CODE_INFO = tuple(
    ("true" if role in IN_SERIES else "false",
     role in IN_SERIES,
     int(role in MODIS_ROLES),
     int(role in IN_SERIES and role not in MODIS_ROLES),
     MODIS_KIND if role in MODIS_ROLES
     else UNWEIGHTED_KIND if role in ("non_vegetation", "static_masked") else VIIRS_KIND)
    for role in ROLES)

BLOB_API_URL = "https://vercel.com/api/blob"
BLOB_API_VERSION = "11"
IMMUTABLE_MAX_AGE = 31_536_000
LATEST_MAX_AGE = 60
CONTENT_TYPES = {".json": "application/json", ".sqlite": "application/vnd.sqlite3",
                 ".gz": "application/gzip"}


class PublishError(RuntimeError):
    pass


def default_out_dir():
    return db.db_path().parent / "publish"


def _json(obj):
    return json.dumps(obj, allow_nan=False, separators=(",", ":"))


def _now():
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_latest(directory):
    try:
        latest = json.loads((Path(directory) / "latest.json").read_text())
    except (OSError, ValueError):
        return None
    if isinstance(latest, dict) and VERSION_NAME.fullmatch(str(latest.get("version"))):
        return latest
    return None


def write_latest(directory, version, published_at):
    """latest.json holds exactly `version` and `published_at`; the web reader rejects more."""
    tmp = Path(directory) / ".latest.json.tmp"
    tmp.write_text(json.dumps({"version": version, "published_at": published_at}) + "\n")
    os.replace(tmp, Path(directory) / "latest.json")


def versions_in(directory):
    directory = Path(directory)
    if not directory.is_dir():
        return []
    found = [p.name for p in directory.iterdir() if p.is_dir() and VERSION_NAME.fullmatch(p.name)]
    return sorted(found, key=lambda v: int(v[1:]))


def next_version(directories):
    """One more than any version present or named by a latest.json in `directories`."""
    highest = 0
    for d in directories:
        names = versions_in(d)
        latest = read_latest(d)
        if latest:
            names.append(latest["version"])
        highest = max([highest, *(int(v[1:]) for v in names)])
    return f"v{highest + 1}"


def default_method(con):
    decision = db.get_artifact("validation:decision", con)
    if isinstance(decision, dict):
        decision = decision.get("method")
    if decision is None:
        return FALLBACK_METHOD
    if decision not in METHODS:
        raise PublishError(f"validation:decision names {decision!r}, not one of {METHODS}")
    return decision


def input_versions(con, method):
    """What the publish reads, by build time; it must not change while a version is built."""
    names = ["normalize:report", "series:report", "series:dates"]
    if method == "model_v1":
        names.append("model:model_v1")
    found = dict(con.execute(
        f"SELECT name, created_at FROM artifacts WHERE name IN ({', '.join('?' * len(names))})",
        names).fetchall())
    return {"hotspots": hotspots_version(con), **{n: found.get(n) for n in names}}


def check_inputs(con, method):
    versions = input_versions(con, method)
    if versions["series:report"] is None or versions["series:dates"] is None:
        raise PublishError("series has not run; run it before publish")
    ran_on = (db.get_artifact("series:report", con).get("inputs") or {}).get("normalize")
    if ran_on != versions["normalize:report"]:
        raise PublishError("normalize ran after series; rerun series (and the steps it needs), "
                           "then publish")
    if method == "model_v1" and versions["model:model_v1"] is None:
        raise PublishError("model_v1 was asked for, but model:model_v1 does not exist; run model")
    return versions


def load_roles(con, method, log=print):
    """Id-sorted arrays over every `series` row: hotspot ids as integers, role codes, and the
    `method` weight (NaN where there is none). Read in 256 id ranges, each its own short read."""
    ids, codes, weights = array("Q"), bytearray(), array("d")
    nan = array("d", [math.nan])
    orphans = 0
    started = time.monotonic()
    for b in range(256):
        lo, hi = f"{b:02x}", f"{b + 1:02x}" if b < 255 else None
        where = "hotspot_id >= ?" + (" AND hotspot_id < ?" if hi else "")
        params = [lo, hi] if hi else [lo]
        rows = con.execute(f"SELECT hotspot_id, in_series, role FROM series WHERE {where} "
                           "ORDER BY hotspot_id", params).fetchall()
        start = len(ids)
        for hid, in_series, role in rows:
            if len(hid) != 16:
                raise PublishError(f"series has a hotspot_id that is not 16 hex digits: {hid!r}")
            code = ROLE_INDEX[role]
            if bool(in_series) != (role in IN_SERIES):
                raise PublishError(f"series row {hid} has role {role} but in_series {in_series}")
            ids.append(int(hid, 16))
            codes.append(code)
        weights.extend(nan * len(rows))
        j, end = start, len(ids)
        for hid, w in con.execute(f"SELECT hotspot_id, weight FROM weights WHERE method = ? "
                                  f"AND {where} ORDER BY hotspot_id", [method, *params]).fetchall():
            key = int(hid, 16)
            while j < end and ids[j] < key:
                j += 1
            if j < end and ids[j] == key:
                weights[j] = w
            else:
                orphans += 1
    n_weights = sum(1 for w in weights if w == w)
    log(f"loaded {len(ids):,} series rows and {n_weights:,} {method} weights in "
        f"{time.monotonic() - started:.0f} s")
    if n_weights == 0:
        raise PublishError(f"weights has no {method} rows")
    return ids, codes, weights, {"series_rows": len(ids), "weights": n_weights,
                                 "weights_without_series": orphans}


def current_month(con, regions, dates, log=print):
    """`meta.current_month`: the month of the freshest region's nrt_until."""
    freshest = max(regions, key=lambda r: dates[r["id"]]["nrt_until"])
    nrt = date.fromisoformat(dates[freshest["id"]]["nrt_until"])
    row = con.execute("SELECT days_covered FROM months WHERE region_id = ? AND ym = ?",
                      (freshest["id"], nrt.year * 100 + nrt.month)).fetchone()
    days = row[0] if row else nrt.day
    if days != nrt.day:
        log(f"WARNING: {freshest['id']} covers {days} days of {nrt:%Y-%m}, but nrt_until is {nrt}")
    for r in regions:
        until = dates[r["id"]]["nrt_until"]
        if until[:7] != nrt.isoformat()[:7]:
            log(f"WARNING: {r['id']} ends in {until[:7]}, before the current month {nrt:%Y-%m}")
    return {"year": nrt.year, "month": nrt.month, "days_covered": days}


def region_cells(con, region):
    """(cell_id, covered) for every cell centered in the exact bbox; cells centered in an
    `excluded_countries` polygon are not covered."""
    excluded = []
    for country in region.get("excluded_countries") or []:
        rows = con.execute("SELECT geometry FROM country_boundaries WHERE name = ?",
                           (country,)).fetchall()
        if not rows:
            raise PublishError(f"{region['id']}: excluded country {country!r} is not in "
                               "country_boundaries")
        for (geometry,) in rows:
            rings = geo.rings_of(json.loads(geometry))
            excluded.append((geo.bbox_of(rings), rings))
    out = []
    for cell in grid.cells_in_bbox(region["bbox"]):
        lon, lat = grid.center(cell)
        covered = 1
        for (west, south, east, north), rings in excluded:
            if west <= lon <= east and south <= lat <= north and geo.point_in_polygon(lon, lat, rings):
                covered = 0
                break
        out.append((cell, covered))
    return out


def date_span(con, region_id):
    """First and last acq_date of the region's rows (box and buffer), or None."""
    firsts, lasts = [], []
    for satellite in SATELLITES:
        # One aggregate per query, so each is a single seek in hotspots_region_satellite_date.
        args = (region_id, satellite)
        lo = con.execute("SELECT MIN(acq_date) FROM hotspots WHERE region_id = ? AND satellite = ?",
                         args).fetchone()[0]
        if lo is not None:
            firsts.append(lo)
            lasts.append(con.execute("SELECT MAX(acq_date) FROM hotspots WHERE region_id = ? "
                                     "AND satellite = ?", args).fetchone()[0])
    return (min(firsts), max(lasts)) if firsts else None


def _flush_stage(stage_dir, staged):
    for tile, lines in staged.items():
        if lines:
            with gzip.open(stage_dir / f"{tile}.gz", "ab", compresslevel=1) as f:
                f.write(("\n".join(lines) + "\n").encode())
            lines.clear()


def _write_tiles(stage_dir, tile_dir, tiles):
    """Sort each staged tile by cell_id, acq_utc and hotspot_id and write it as a gzipped CSV
    with mtime 0, so equal input gives equal bytes. Returns {tile: (rows, bytes)}."""
    out = {}
    for tile in sorted(tiles):
        staged = stage_dir / f"{tile}.gz"
        with gzip.open(staged, "rb") as f:
            lines = f.read().decode().split("\n")
        lines.pop()
        lines.sort()
        path = tile_dir / f"{tile}.csv.gz"
        with open(path, "wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw,
                                                    compresslevel=6, mtime=0) as gz:
            gz.write((TILE_HEADER + "\n").encode())
            for k in range(0, len(lines), TILE_WRITE_LINES):
                gz.write("".join(line[SORT_KEY_LEN:] + "\n"
                                 for line in lines[k:k + TILE_WRITE_LINES]).encode())
        out[tile] = (len(lines), path.stat().st_size)
        staged.unlink()
    return out


def publish_region(con, serving, region, roles, method, current, version_dir, log=print):
    """Write one region's region_cells, cells, cell_days and point tiles; return its stats."""
    rid = region["id"]
    started = time.monotonic()
    ids, codes, weights = roles
    n_ids = len(ids)
    cell_rows = region_cells(con, region)
    serving.executemany("INSERT INTO region_cells VALUES (?, ?, ?)",
                        [(rid, cell, covered) for cell, covered in cell_rows])
    stage_dir = version_dir / "stage" / rid
    tile_dir = version_dir / "points" / rid
    stage_dir.mkdir(parents=True)
    tile_dir.mkdir(parents=True)
    staged = defaultdict(list)
    n_staged = 0
    years = defaultdict(lambda: [0.0, 0, 0, 0])
    no_series = unweighted = null_fields = n_cells = n_days = 0
    cur_month = current["month"]
    span = date_span(con, rid)
    for y, m, lo, hi in (month_starts(*span) if span else ()):
        ym = y * 100 + m
        month_cells = {}
        days = {} if m == cur_month else None
        for satellite in SATELLITES:
            rows = con.execute(HOTSPOT_SQL, (rid, satellite, lo, hi)).fetchall()
            for hid, sat, sensor, utc, day, lat, lon, dn, frp, conf, ft, proc, cell, tile in rows:
                key = int(hid, 16)
                i = bisect_left(ids, key)
                if i == n_ids or ids[i] != key:
                    no_series += 1
                    continue
                series_text, harmonized, modis_step, viirs_step, kind = CODE_INFO[codes[i]]
                if kind == MODIS_KIND:
                    w, wt = 1.0, "1"
                elif kind == VIIRS_KIND:
                    w = weights[i]
                    if w == w:
                        wt = repr(w)
                    else:
                        w, wt = None, ""
                        unweighted += harmonized
                else:
                    w, wt = None, ""
                c = month_cells.get(cell)
                if c is None:
                    c = month_cells[cell] = [0.0, 0, 0, 0]
                if harmonized and w is not None:
                    c[0] += w
                    if days is not None:
                        dk = (cell, int(day[8:10]))
                        days[dk] = days.get(dk, 0.0) + w
                c[1] += modis_step
                c[2] += viirs_step
                c[3] += 1
                if len(utc) != 17:
                    raise PublishError(f"hotspot {hid} has acq_utc {utc!r}, not YYYY-MM-DDTHH:MMZ")
                if dn is None or frp is None or conf is None:
                    null_fields += 1
                    dn, conf, frp_text = dn or "", conf or "", "" if frp is None else repr(frp)
                else:
                    frp_text = repr(frp)
                staged[tile].append(
                    f"{cell:08d}{utc}{hid}{hid},{sat},{sensor},{utc},{day},{lat!r},{lon!r},{dn},"
                    f"{frp_text},{conf},{'' if ft is None else ft},{proc},{series_text},{wt},"
                    f"{method},{cell}")
            n_staged += len(rows)
        if month_cells:
            serving.executemany("INSERT INTO cells VALUES (?, ?, ?, ?, ?, ?, ?)",
                                [(rid, cell, ym, *v) for cell, v in month_cells.items()])
            n_cells += len(month_cells)
            ys = years[y]
            for v in month_cells.values():
                ys[0] += v[0]
                ys[1] += v[1]
                ys[2] += v[2]
                ys[3] += v[3]
        if days:
            serving.executemany("INSERT INTO cell_days VALUES (?, ?, ?, ?, ?)",
                                [(rid, cell, y, d, h) for (cell, d), h in days.items()])
            n_days += len(days)
        if n_staged >= STAGE_FLUSH_LINES:
            _flush_stage(stage_dir, staged)
            n_staged = 0
    if no_series:
        raise PublishError(f"{rid}: {no_series:,} in-box hotspots have no series row; rerun series")
    if unweighted:
        raise PublishError(f"{rid}: {unweighted:,} in-series VIIRS rows have no {method} weight")
    _flush_stage(stage_dir, staged)
    tiles = _write_tiles(stage_dir, tile_dir, staged)
    stage_dir.rmdir()
    if null_fields:
        log(f"WARNING: {rid}: {null_fields:,} rows have no daynight, frp_mw or confidence; "
            "those tile fields are empty")
    rows = sum(n for n, _ in tiles.values())
    stats = {
        "rows": rows,
        "tiles": len(tiles),
        "tile_bytes": sum(b for _, b in tiles.values()),
        "largest_tile_rows": max((n for n, _ in tiles.values()), default=0),
        "cells": n_cells,
        "cell_days": n_days,
        "region_cells": len(cell_rows),
        "uncovered_cells": sum(1 for _, covered in cell_rows if not covered),
        "null_fields": null_fields,
        "annual": [{"year": y, "harmonized": round(v[0], 6), "modis_raw": v[1],
                    "viirs_raw": v[2], "points": v[3]} for y, v in sorted(years.items())],
        "seconds": round(time.monotonic() - started, 1),
    }
    log(f"{rid}: {rows:,} rows in {len(tiles)} tiles ({stats['tile_bytes'] / 1e6:.1f} MB), "
        f"{n_cells:,} cell-months, {n_days:,} cell-days, {len(cell_rows):,} cells "
        f"({stats['uncovered_cells']:,} not covered) in {stats['seconds']:.0f} s")
    return sorted(tiles), stats


def model_version(con, method):
    if method != "model_v1":
        return None
    text, created_at = con.execute(
        "SELECT json, created_at FROM artifacts WHERE name = 'model:model_v1'").fetchone()
    obj = json.loads(text)
    version = obj.get("version") if isinstance(obj, dict) else None
    return str(version) if version else created_at[:10]


def k_table(con, regions, method):
    table, column = ("ratio_factors", "factor") if method == "ratio_v1" else ("k_factors", "k")
    try:
        rows = con.execute(f"SELECT region_id, month, satellite, {column}, level FROM {table}").fetchall()
    except sqlite3.OperationalError as e:
        raise PublishError(f"cannot read {table} for {method}: {e}") from None
    order = {r["id"]: i for i, r in enumerate(regions)}
    sats = {"S-NPP": 0, "NOAA-20": 1}
    rows = sorted((r for r in rows if r[0] in order), key=lambda r: (order[r[0]], sats.get(r[2], 9), r[1]))
    return [{"region_id": rid, "month": m, "satellite": s, "value": v, "level": level}
            for rid, m, s, v, level in rows]


def metadata(regions, dates, version, method, model):
    return {
        "data_version": version,
        "units": UNITS,
        "grid_deg": config.GRID_DEG,
        "regions": [{"id": r["id"], "name": r["name"], "bbox": r["bbox"],
                     "coverage": {"start": config.RECORD_START.isoformat(),
                                  "sp_until": dates[r["id"]]["sp_until"],
                                  "nrt_until": dates[r["id"]]["nrt_until"]}} for r in regions],
        "method": {"weight_method": method, "model_version": model,
                   "calibration_years": f"{config.CALIBRATION[0].year}-{config.CALIBRATION[1].year}",
                   "baseline": f"{config.BASELINE[0].year}-{config.BASELINE[1].year}",
                   "viirs_switch": config.VIIRS_SWITCH.isoformat()},
        "attribution": ATTRIBUTION,
    }


def meta_rows(con, regions, dates, version, method, current):
    meta = {
        "metadata": metadata(regions, dates, version, method, model_version(con, method)),
        "current_month": current,
        "attribution": ATTRIBUTION,
        "k_table": k_table(con, regions, method),
    }
    copied = [("validation:summary", "validation_summary"), ("model:detection_curve", "detection_curve")]
    copied += [(f"validation:{r['id']}", f"validation:{r['id']}") for r in regions]
    for artifact, key in copied:
        value = db.get_artifact(artifact, con)
        if value is not None:
            meta[key] = value
    return sorted((key, _json(value)) for key, value in meta.items())


def build(con, cfg, version_dir, version, method, log=print):
    """Write a complete version into `version_dir` (replaced if present); return its report."""
    started = time.monotonic()
    inputs = check_inputs(con, method)
    regions = cfg["regions"]
    dates = db.get_artifact("series:dates", con)
    missing = [r["id"] for r in regions if r["id"] not in dates]
    if missing:
        raise PublishError(f"series:dates has no dates for {', '.join(missing)}")
    current = current_month(con, regions, dates, log)
    if version_dir.exists():
        shutil.rmtree(version_dir)
    version_dir.mkdir(parents=True)
    *roles, role_stats = load_roles(con, method, log)
    build_path = version_dir / "serving.build.sqlite"
    serving = sqlite3.connect(build_path)
    report = {"version": version, "method": method, "current_month": current, "inputs": inputs,
              "roles": role_stats, "regions": {}}
    try:
        serving.execute("PRAGMA journal_mode = OFF")
        serving.execute("PRAGMA synchronous = OFF")
        serving.execute("PRAGMA cache_size = -65536")
        serving.executescript(SERVING_DDL)
        region_rows = []
        for region in regions:
            rid = region["id"]
            tiles, stats = publish_region(con, serving, region, roles, method, current,
                                          version_dir, log)
            report["regions"][rid] = stats
            region_rows.append((rid, region["name"], _json(region["bbox"]), dates[rid]["sp_until"],
                                dates[rid]["nrt_until"], _json(tiles)))
            month_rows = con.execute(
                "SELECT region_id, ym, terra_only, viirs_source, viirs_missing_days, provisional, "
                "days_covered FROM months WHERE region_id = ? ORDER BY ym", (rid,)).fetchall()
            if not month_rows:
                raise PublishError(f"months has no rows for {rid}; rerun series")
            serving.executemany("INSERT INTO months VALUES (?, ?, ?, ?, ?, ?, ?)", month_rows)
            serving.commit()
        (version_dir / "stage").rmdir()
        serving.executemany("INSERT INTO regions VALUES (?, ?, ?, ?, ?, ?)", region_rows)
        serving.executemany("INSERT INTO meta VALUES (?, ?)",
                            meta_rows(con, regions, dates, version, method, current))
        serving.commit()
        serving.execute("VACUUM INTO ?", (str(version_dir / "serving.sqlite"),))
    finally:
        serving.close()
    build_path.unlink()
    size = (version_dir / "serving.sqlite").stat().st_size
    if size >= MAX_SERVING_BYTES:
        raise PublishError(f"serving.sqlite is {size / 1e6:.1f} MB; the limit is "
                           f"{MAX_SERVING_BYTES / 1e6:.0f} MB")
    if input_versions(con, method) != inputs:
        raise PublishError("the pipeline tables changed while publishing; rerun publish")
    report["seconds"] = round(time.monotonic() - started, 1)
    return report


def size_report(version_dir):
    path = version_dir / "serving.sqlite"
    serving = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
    try:
        counts = {t: serving.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                  for (t,) in serving.execute("SELECT name FROM sqlite_master WHERE type = 'table' "
                                              "ORDER BY name").fetchall()}
        try:
            pages = dict(serving.execute("SELECT name, SUM(pgsize) FROM dbstat GROUP BY name"))
        except sqlite3.OperationalError:
            pages = {}
        tiles = {rid: json.loads(t) for rid, t in serving.execute("SELECT region_id, tiles FROM regions")}
    finally:
        serving.close()
    tile_bytes = {rid: sum((version_dir / "points" / rid / f"{t}.csv.gz").stat().st_size for t in ts)
                  for rid, ts in tiles.items()}
    return {"serving_bytes": path.stat().st_size,
            "tables": {t: {"rows": n, "bytes": pages.get(t)} for t, n in counts.items()},
            "tiles": {rid: len(ts) for rid, ts in tiles.items()},
            "tile_bytes": tile_bytes}


def print_size_report(version, sizes, log=print):
    log(f"\n{version}: serving.sqlite {sizes['serving_bytes'] / 1e6:.1f} MB "
        f"(limit {MAX_SERVING_BYTES / 1e6:.0f} MB)")
    for table, t in sizes["tables"].items():
        size = "" if t["bytes"] is None else f"{t['bytes'] / 1e6:9.1f} MB"
        log(f"  {table:<14} {t['rows']:>12,} rows {size}")
    total = sum(sizes["tile_bytes"].values())
    log(f"points: {sum(sizes['tiles'].values())} tiles, {total / 1e6:.1f} MB")
    for rid, n in sizes["tiles"].items():
        log(f"  {rid:<14} {n:>4} tiles {sizes['tile_bytes'][rid] / 1e6:9.1f} MB")


def check_tiles(version_dir, tiles, cells, method):
    """Read every tile back: CONTRACTS header and fields, sort order, files equal to
    `regions.tiles`, and per region-year row counts and in-series weight sums equal to `cells`."""
    problems = []
    for rid, listed in tiles.items():
        tile_dir = version_dir / "points" / rid
        files = sorted(p.name[:-len(".csv.gz")] for p in tile_dir.glob("*.csv.gz")) if tile_dir.is_dir() else []
        if files != sorted(listed):
            problems.append(f"{rid}: tile files {files} differ from regions.tiles {sorted(listed)}")
        rows, sums = Counter(), defaultdict(lambda: array("d"))
        for tile in listed:
            path = tile_dir / f"{tile}.csv.gz"
            if not path.exists():
                continue
            with gzip.open(path, "rt", newline="") as f:
                lines = f.read().split("\n")
            if lines[0] != TILE_HEADER:
                problems.append(f"{path}: header is {lines[0][:80]!r}")
                continue
            if lines[-1] == "":
                lines.pop()
            previous, last_cell = (-1, ""), -1
            for n, line in enumerate(lines[1:], start=2):
                f = line.split(",")
                if len(f) != len(TILE_COLUMNS) or f[12] not in ("true", "false") or f[14] != method:
                    problems.append(f"{path} line {n}: bad row {line[:120]!r}")
                    break
                cell = int(f[15])
                if (cell, f[3]) < previous:
                    problems.append(f"{path} line {n}: not sorted by cell_id, acq_utc")
                    break
                previous = (cell, f[3])
                if cell != last_cell:
                    if grid.tile_of(cell) != tile:
                        problems.append(f"{path} line {n}: cell {cell} is not in tile {tile}")
                        break
                    last_cell = cell
                year = int(f[4][:4])
                rows[year] += 1
                if f[12] == "true":
                    if not f[13]:
                        problems.append(f"{path} line {n}: an in-series row has no weight")
                        break
                    sums[year].append(float(f[13]))
        for (r, year), (h, _, _, points) in cells.items():
            if r != rid:
                continue
            if rows.get(year, 0) != points:
                problems.append(f"{rid} {year}: tiles hold {rows.get(year, 0):,} rows, "
                                f"cells.points sums to {points:,}")
            if abs(math.fsum(sums.get(year, ())) - h) > TOLERANCE:
                problems.append(f"{rid} {year}: tile weights sum to {math.fsum(sums.get(year, ())):.9f}, "
                                f"cells.harmonized to {h:.9f}")
        for year in set(rows) - {y for r, y in cells if r == rid}:
            problems.append(f"{rid} {year}: {rows[year]:,} tile rows but no cells")
    return problems


def check_against_pipeline(con, cfg, scratch_dir, cells, method, log=print):
    """Recompute per region-year totals from the pipeline tables in SQL alone: the in-box rows
    go to a scratch table indexed by hotspot_id, which then joins `series` and `weights` in id
    order. Returns (problems, comparison rows)."""
    problems, table = [], []
    scratch = scratch_dir / f".verify-{os.getpid()}.sqlite"
    scratch.unlink(missing_ok=True)
    regions = cfg["regions"]
    con.execute("ATTACH DATABASE ? AS v", (str(scratch),))
    try:
        con.execute("PRAGMA v.journal_mode = OFF")
        con.execute("PRAGMA v.synchronous = OFF")
        con.execute("CREATE TABLE v.t (hotspot_id TEXT NOT NULL, region INTEGER NOT NULL, "
                    "year INTEGER NOT NULL)")
        for ri, region in enumerate(regions):
            span = date_span(con, region["id"])
            if not span:
                continue
            for satellite in SATELLITES:
                for year in range(int(span[0][:4]), int(span[1][:4]) + 1):
                    with con:
                        con.execute(
                            "INSERT INTO v.t SELECT hotspot_id, ?, ? FROM main.hotspots "
                            "WHERE region_id = ? AND satellite = ? AND acq_date >= ? "
                            "AND acq_date < ? AND in_box = 1",
                            (ri, year, region["id"], satellite, f"{year}-01-01", f"{year + 1}-01-01"))
        con.execute("CREATE INDEX v.t_id ON t(hotspot_id)")
        totals = defaultdict(lambda: [0, 0, 0, 0, [], 0])
        for b in range(256):
            bounds = [f"{b:02x}"] + ([f"{b + 1:02x}"] if b < 255 else [])
            where = "t.hotspot_id >= ?" + (" AND t.hotspot_id < ?" if b < 255 else "")
            for ri, year, n, found, modis, viirs, harmonized, unweighted in con.execute(f"""
                    SELECT t.region, t.year, COUNT(*), COUNT(s.hotspot_id),
                           TOTAL(s.role IN ('modis', 'modis_overlap')),
                           TOTAL(s.in_series = 1 AND s.role <> 'modis'),
                           TOTAL(CASE WHEN s.in_series = 1 THEN
                                 CASE WHEN s.role = 'modis' THEN 1.0 ELSE w.weight END END),
                           TOTAL(s.in_series = 1 AND s.role <> 'modis' AND w.weight IS NULL)
                    FROM v.t t
                    LEFT JOIN main.series s ON s.hotspot_id = t.hotspot_id
                    LEFT JOIN main.weights w ON w.hotspot_id = t.hotspot_id AND w.method = ?
                    WHERE {where}
                    GROUP BY t.region, t.year""", [method, *bounds]).fetchall():
                acc = totals[regions[ri]["id"], year]
                acc[0] += n
                acc[1] += found
                acc[2] += int(modis)
                acc[3] += int(viirs)
                acc[4].append(harmonized)
                acc[5] += int(unweighted)
    finally:
        if con.in_transaction:
            con.rollback()
        con.execute("DETACH DATABASE v")
        scratch.unlink(missing_ok=True)
    for key in sorted(set(totals) | set(cells)):
        rid, year = key
        n, found, modis, viirs, parts, unweighted = totals.get(key, [0, 0, 0, 0, [], 0])
        h = math.fsum(parts)
        ch, cm, cv, cp = cells.get(key, (0.0, 0, 0, 0))
        table.append({"region_id": rid, "year": year, "pipeline": h, "cells": ch,
                      "diff": ch - h, "rows": n})
        if found != n:
            problems.append(f"{rid} {year}: {n - found:,} in-box hotspots have no series row")
        if unweighted:
            problems.append(f"{rid} {year}: {unweighted:,} in-series VIIRS rows have no weight")
        if (n, modis, viirs) != (cp, cm, cv):
            problems.append(f"{rid} {year}: pipeline rows/modis/viirs {n}/{modis}/{viirs}, "
                            f"cells points/modis_raw/viirs_raw {cp}/{cm}/{cv}")
        if abs(ch - h) > TOLERANCE:
            problems.append(f"{rid} {year}: cells.harmonized {ch:.9f}, pipeline weights {h:.9f}")
    return problems, table


def verify(con, cfg, version_dir, version, log=print):
    """Independent checks of a built version; returns (problems, region-year comparison)."""
    started = time.monotonic()
    path = version_dir / "serving.sqlite"
    serving = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
    problems = []
    try:
        meta = {k: json.loads(v) for k, v in serving.execute("SELECT key, value FROM meta")}
        method = meta["metadata"]["method"]["weight_method"]
        cur = meta["current_month"]
        if meta["metadata"]["data_version"] != version:
            problems.append(f"metadata.data_version is {meta['metadata']['data_version']}, "
                            f"not {version}")
        cells = {(rid, y): (h, m, v, p) for rid, y, h, m, v, p in serving.execute(
            "SELECT region_id, ym / 100, TOTAL(harmonized), SUM(modis_raw), SUM(viirs_raw), "
            "SUM(points) FROM cells GROUP BY 1, 2")}
        month_sums = dict(((rid, y), h) for rid, y, h in serving.execute(
            "SELECT region_id, ym / 100, TOTAL(harmonized) FROM cells WHERE ym % 100 = ? "
            "GROUP BY 1, 2", (cur["month"],)))
        day_sums = dict(((rid, y), h) for rid, y, h in serving.execute(
            "SELECT region_id, year, TOTAL(harmonized) FROM cell_days GROUP BY 1, 2"))
        tiles = {rid: json.loads(t) for rid, t in serving.execute("SELECT region_id, tiles FROM regions")}
        n_region_cells = dict(serving.execute("SELECT region_id, COUNT(*) FROM region_cells GROUP BY 1"))
    finally:
        serving.close()
    for key in set(month_sums) | set(day_sums):
        if abs(month_sums.get(key, 0.0) - day_sums.get(key, 0.0)) > TOLERANCE:
            problems.append(f"{key}: cell_days sum to {day_sums.get(key, 0.0):.9f}, "
                            f"month {cur['month']} of cells to {month_sums.get(key, 0.0):.9f}")
    for region in cfg["regions"]:
        expected = len(grid.cells_in_bbox(region["bbox"]))
        if n_region_cells.get(region["id"]) != expected:
            problems.append(f"{region['id']}: {n_region_cells.get(region['id'])} region_cells, "
                            f"expected {expected}")
    problems += check_tiles(version_dir, tiles, cells, method)
    log(f"verify: tiles read back in {time.monotonic() - started:.0f} s")
    pipeline_problems, table = check_against_pipeline(con, cfg, version_dir.parent, cells, method, log)
    problems += pipeline_problems
    log(f"verify: done in {time.monotonic() - started:.0f} s, {len(problems)} problems")
    return problems, table


def print_verify_table(table, log=print):
    log(f"\n{'region':<13} {'year':>4} {'in-box rows':>12} {'pipeline weights':>18} "
        f"{'cells.harmonized':>18} {'difference':>11}")
    for r in table:
        log(f"{r['region_id']:<13} {r['year']:>4} {r['rows']:>12,} {r['pipeline']:>18.6f} "
            f"{r['cells']:>18.6f} {r['diff']:>11.1e}")
    if table:
        log(f"largest |difference|: {max(abs(r['diff']) for r in table):.1e} "
            f"over {len(table)} region-years (limit {TOLERANCE:g})")


def link_or_copy(src, dst):
    """Hard-link `src` to `dst`, copying when the two are on different filesystems."""
    try:
        os.link(src, dst)
        return True
    except OSError:
        shutil.copy2(src, dst)
        return False


def copy_version(out_dir, version, target, published_at, log=print):
    target.mkdir(parents=True, exist_ok=True)
    partial = target / f".{version}.partial"
    if partial.exists():
        shutil.rmtree(partial)
    linked = copied = 0
    source = out_dir / version
    for src in sorted(source.rglob("*")):
        dst = partial / src.relative_to(source)
        if src.is_dir():
            dst.mkdir(parents=True, exist_ok=True)
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        if link_or_copy(src, dst):
            linked += 1
        else:
            copied += 1
    if (target / version).exists():
        shutil.rmtree(target / version)
    partial.rename(target / version)
    write_latest(target, version, published_at)
    log(f"{target}: {version} placed ({linked} files hard-linked, {copied} copied), "
        "latest.json updated")


class UploadError(RuntimeError):
    pass


def put_blob(api_url, token, pathname, path, max_age, attempts=3, sleep=None):
    """PUT one file to Vercel Blob at a fixed pathname (no random suffix, overwrite allowed),
    as @vercel/blob's put() does. Retries network errors, 429 and 5xx."""
    url = f"{api_url}/?pathname={urllib.parse.quote(pathname)}"
    size = path.stat().st_size
    headers = {
        "authorization": f"Bearer {token}",
        "x-api-version": os.environ.get("VERCEL_BLOB_API_VERSION_OVERRIDE") or BLOB_API_VERSION,
        "x-content-type": CONTENT_TYPES.get(path.suffix, "application/octet-stream"),
        "x-add-random-suffix": "0",
        "x-allow-overwrite": "1",
        "x-cache-control-max-age": str(max_age),
        "content-length": str(size),
    }
    for attempt in range(1, attempts + 1):
        with open(path, "rb") as body:
            request = urllib.request.Request(url, data=body, method="PUT", headers=headers)
            try:
                with urllib.request.urlopen(request, timeout=600) as response:
                    text = response.read()
                try:
                    return json.loads(text)
                except ValueError:
                    raise UploadError(f"PUT {pathname}: the answer is not JSON: {text[:200]!r}") from None
            except urllib.error.HTTPError as e:
                detail = e.read(300).decode(errors="replace")
                if (e.code < 500 and e.code != 429) or attempt == attempts:
                    raise UploadError(f"PUT {pathname}: HTTP {e.code}: {detail}") from None
            except (urllib.error.URLError, OSError) as e:
                if attempt == attempts:
                    raise UploadError(f"PUT {pathname}: {e}") from None
        (sleep or time.sleep)(2 ** attempt)


def upload_version(out_dir, version, token, log=print, sleep=None):
    """Upload `vN/` then latest.json; returns the blob URL of latest.json."""
    api_url = (os.environ.get("VERCEL_BLOB_API_URL") or BLOB_API_URL).rstrip("/")
    source = out_dir / version
    files = sorted(p for p in source.rglob("*") if p.is_file())
    started = time.monotonic()
    for n, path in enumerate(files, start=1):
        put_blob(api_url, token, f"{version}/{path.relative_to(source).as_posix()}", path,
                 IMMUTABLE_MAX_AGE, sleep=sleep)
        if n % 100 == 0:
            log(f"uploaded {n} of {len(files)} files")
    url = put_blob(api_url, token, "latest.json", out_dir / "latest.json", LATEST_MAX_AGE,
                   sleep=sleep).get("url")
    log(f"uploaded {version} ({len(files)} files) and latest.json in "
        f"{time.monotonic() - started:.0f} s: {url}")
    return url


def prune(directory, keep, log=print):
    """Delete versions beyond the newest `keep` (0 keeps all); never the one latest.json names."""
    if keep <= 0:
        return []
    latest = read_latest(directory)
    names = versions_in(directory)
    keepers = set(names[-keep:]) | ({latest["version"]} if latest else set())
    removed = [v for v in names if v not in keepers]
    for v in removed:
        shutil.rmtree(Path(directory) / v)
    if removed:
        log(f"{directory}: removed {', '.join(removed)}")
    return removed


def publish(con, cfg, out_dir=None, method=None, copy_to=(), verify_first=False, reuse=None,
            keep=2, token=None, log=print):
    """Build a new version (or take `reuse`), optionally verify it, make it latest, then copy,
    upload and prune. Returns the run report."""
    started = time.monotonic()
    out_dir = Path(out_dir) if out_dir else default_out_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    targets = [Path(d) for d in copy_to]
    targets = [d for d in targets if not (d.exists() and d.resolve() == out_dir.resolve())]
    problems, table = [], []
    if reuse:
        version = reuse
        if not VERSION_NAME.fullmatch(version) or not (out_dir / version / "serving.sqlite").is_file():
            raise PublishError(f"{out_dir / version} is not a published version")
        if verify_first:
            problems, table = verify(con, cfg, out_dir / version, version, log)
        latest = read_latest(out_dir)
        published_at = latest["published_at"] if latest and latest["version"] == version else _now()
        report = {"version": version, "reused": True}
    else:
        method = method or default_method(con)
        version = next_version([out_dir, *targets])
        log(f"publishing {version} with {method} weights into {out_dir}")
        partial = out_dir / f".{version}.partial"
        report = build(con, cfg, partial, version, method, log)
        if verify_first:
            problems, table = verify(con, cfg, partial, version, log)
    if verify_first:
        print_verify_table(table, log)
        report["verify"] = {"problems": problems[:50],
                            "max_abs_diff": max((abs(r["diff"]) for r in table), default=0.0),
                            "region_years": len(table)}
        if problems:
            for p in problems[:20]:
                log(f"PROBLEM: {p}")
            raise PublishError(f"{len(problems)} problems; {version} was not made latest")
    if not reuse:
        partial.rename(out_dir / version)
        published_at = _now()
    write_latest(out_dir, version, published_at)
    report["published_at"] = published_at
    for target in targets:
        copy_version(out_dir, version, target, published_at, log)
    report["copied_to"] = [str(t) for t in targets]
    if token:
        report["uploaded"] = upload_version(out_dir, version, token, log)
    for d in [out_dir, *targets]:
        prune(d, keep, log)
    sizes = size_report(out_dir / version)
    print_size_report(version, sizes, log)
    report["sizes"] = sizes
    report["seconds_total"] = round(time.monotonic() - started, 1)
    if not reuse:
        db.put_artifact("publish:report", report, con)
    log(f"\nlatest is {version} ({published_at}), {report['seconds_total']:.0f} s")
    return report


def add_arguments(parser):
    parser.add_argument("--method", choices=METHODS,
                        help="weights to ship (default: the validation:decision artifact, "
                             "else ratio_v1)")
    parser.add_argument("--copy-to", action="append", default=[], metavar="DIR",
                        help="also place the version and latest.json in DIR, hard-linked when on "
                             "the same filesystem, e.g. ../web/public/data (repeatable)")
    parser.add_argument("--upload", action="store_true",
                        help="upload the version, then latest.json, to Vercel Blob with "
                             "$BLOB_READ_WRITE_TOKEN")
    parser.add_argument("--verify", action="store_true",
                        help="before the version becomes latest, check it against the pipeline "
                             "database in SQL and read every tile back (a few minutes)")
    parser.add_argument("--reuse", metavar="VERSION",
                        help="skip the build: make this existing version latest again and copy "
                             "or upload it (to roll back, or to retry an upload)")
    parser.add_argument("--keep", type=int, default=2,
                        help="versions kept in the output and --copy-to directories; 0 keeps "
                             "all (default 2)")
    parser.add_argument("--out", type=Path,
                        help="output directory (default: publish/ next to $HOTORNOT_DB)")


def run(args):
    token = None
    if args.upload:
        token = os.environ.get("BLOB_READ_WRITE_TOKEN")
        if not token:
            print("publish: --upload needs BLOB_READ_WRITE_TOKEN in the environment")
            return 2
    con = db.connect()
    try:
        publish(con, config.load_config(), out_dir=args.out, method=args.method,
                copy_to=args.copy_to, verify_first=args.verify, reuse=args.reuse,
                keep=args.keep, token=token)
    except HotspotsNotReady:
        print("publish: hotspots is being rebuilt; publish after normalize and series finish")
        return 1
    except (PublishError, UploadError) as e:
        print(f"publish: {e}")
        return 1
    finally:
        con.close()
    return 0
