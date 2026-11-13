#!/usr/bin/env python3
"""Download HotOrNot source data into SQLite.

    python3 -I ingest.py plan | firms | firms7d | api | cmr | boundaries | summary
    options: --db PATH --workers N --sources modis,viirs-snpp --countries Egypt --regions nile_delta
             --refresh --by-year
"""
import argparse
import collections
import csv
import datetime as dt
import io
import json
import os
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
PIPELINE = os.path.abspath(os.path.join(HERE, "..", ".."))
CONFIG_PATH = os.path.join(PIPELINE, "config", "regions.json")
DEFAULT_DB = os.path.join(PIPELINE, "data", "hotornot.sqlite")
USER_AGENT = "hotornot-pipeline/0.1"
FIRMS_COUNTRY_URL = "https://firms.modaps.eosdis.nasa.gov/data/country/{s}/{y}/{s}_{y}_{c}.csv"
CMR_GRANULES_URL = "https://cmr.earthdata.nasa.gov/search/granules.json"
BOUNDARIES_URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/"
                  "geojson/ne_50m_admin_0_countries.geojson")
FIRMS_API = "https://firms.modaps.eosdis.nasa.gov"
ENV_PATH = os.path.join(PIPELINE, ".env")
MODIS_SATELLITE = {"Terra": "Terra", "T": "Terra", "Aqua": "Aqua", "A": "Aqua"}
VIIRS_SATELLITE = {"viirs-snpp": "S-NPP", "viirs-jpss1": "NOAA-20"}
API_SATELLITE_SOURCE = {"MODIS": "modis", "S-NPP": "viirs-snpp", "NOAA-20": "viirs-jpss1"}
TRANSACTIONS_PER_DAY = 2
TRANSACTION_BUDGET = 4500
TRANSACTION_WINDOW_S = 600

SCHEMA = """
CREATE TABLE IF NOT EXISTS raw_files (
    file_id            INTEGER PRIMARY KEY,
    file_key           TEXT NOT NULL UNIQUE,
    kind               TEXT NOT NULL,
    source             TEXT NOT NULL,
    country            TEXT,
    year               INTEGER,
    url                TEXT NOT NULL,
    status             TEXT NOT NULL,
    http_last_modified TEXT,
    bytes              INTEGER,
    rows_read          INTEGER,
    rows_kept          INTEGER,
    fetched_at         TEXT,
    error              TEXT
);
CREATE TABLE IF NOT EXISTS raw_hotspots (
    file_id     INTEGER NOT NULL REFERENCES raw_files(file_id),
    region_id   TEXT NOT NULL,
    in_box      INTEGER NOT NULL,
    source      TEXT NOT NULL,
    satellite   TEXT NOT NULL,
    latitude    REAL NOT NULL,
    longitude   REAL NOT NULL,
    acq_date    TEXT NOT NULL,
    acq_time    TEXT NOT NULL,
    bright_mir  REAL,
    bright_tir  REAL,
    scan        REAL,
    track       REAL,
    confidence  TEXT,
    version     TEXT,
    frp         REAL,
    daynight    TEXT,
    type        INTEGER,
    processing  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS raw_hotspots_file ON raw_hotspots(file_id);
CREATE TABLE IF NOT EXISTS cmr_granules (
    short_name  TEXT NOT NULL,
    region_id   TEXT NOT NULL,
    granule_id  TEXT NOT NULL,
    time_start  TEXT NOT NULL,
    time_end    TEXT,
    day_night   TEXT,
    footprint   TEXT,
    PRIMARY KEY (short_name, region_id, granule_id)
);
CREATE TABLE IF NOT EXISTS cmr_slices (
    short_name  TEXT NOT NULL,
    region_id   TEXT NOT NULL,
    year        INTEGER NOT NULL,
    hits        INTEGER,
    stored      INTEGER,
    done        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (short_name, region_id, year)
);
CREATE TABLE IF NOT EXISTS country_boundaries (
    name        TEXT NOT NULL,
    iso_a3      TEXT,
    geometry    TEXT NOT NULL
);
"""


def log(msg):
    print("[%s] %s" % (dt.datetime.now().strftime("%H:%M:%S"), msg), flush=True)


def load_config():
    with open(CONFIG_PATH) as f:
        cfg = json.load(f)
    b = cfg["buffer_deg"]
    for r in cfg["regions"]:
        west, south, east, north = r["bbox"]
        r["buffered"] = (west - b, south - b, east + b, north + b)
    return cfg


def connect(db_path):
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    con = sqlite3.connect(db_path, timeout=300)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.executescript(SCHEMA)
    return con


def inside(box, lon, lat):
    return box[0] <= lon <= box[2] and box[1] <= lat <= box[3]


def open_url(url, method="GET", headers=None, timeout=120):
    h = {"User-Agent": USER_AGENT}
    h.update(headers or {})
    return urllib.request.urlopen(urllib.request.Request(url, headers=h, method=method), timeout=timeout)


def with_retries(fn, attempts=4):
    last = None
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            last = "HTTP %s" % e.code
        except Exception as e:
            last = "%s: %s" % (type(e).__name__, e)
        if attempt < attempts:
            time.sleep(min(90, 5 * attempt * attempt))
    raise RuntimeError(last)


class CountingReader(io.RawIOBase):
    def __init__(self, f):
        self.f, self.n = f, 0

    def readable(self):
        return True

    def readinto(self, b):
        data = self.f.read(len(b))
        self.n += len(data)
        b[: len(data)] = data
        return len(data)


def num(v):
    return float(v) if v not in ("", None) else None


def stream_firms(url, source, regions):
    def once():
        with open_url(url, timeout=180) as resp:
            length = resp.headers.get("Content-Length")
            counter = CountingReader(resp)
            text = io.TextIOWrapper(io.BufferedReader(counter, 1 << 20), encoding="utf-8", newline="")
            reader = csv.reader(text)
            header = next(reader, [])
            if "latitude" not in header:
                raise IOError("unexpected response: %s" % ",".join(header)[:120])
            c = {name: i for i, name in enumerate(header)}
            i_lat, i_lon = c["latitude"], c["longitude"]
            i_mir = c.get("brightness", c.get("bright_ti4"))
            i_tir = c.get("bright_t31", c.get("bright_ti5"))
            i_type = c.get("type")
            idx = [c[k] for k in ("acq_date", "acq_time", "scan", "track", "confidence",
                                  "version", "frp", "daynight", "satellite")]
            rows, read = [], 0
            for r in reader:
                if not r:
                    continue
                read += 1
                lat, lon = float(r[i_lat]), float(r[i_lon])
                for reg in regions:
                    if not inside(reg["buffered"], lon, lat):
                        continue
                    acq_date, acq_time, scan, track, conf, ver, frp, dn, sat = (r[i] for i in idx)
                    satellite = (MODIS_SATELLITE.get(sat, sat) if source == "modis"
                                 else VIIRS_SATELLITE[source])
                    fire_type = r[i_type] if i_type is not None else ""
                    rows.append((
                        reg["id"], 1 if inside(reg["bbox"], lon, lat) else 0, source, satellite,
                        lat, lon, acq_date, acq_time.zfill(4),
                        num(r[i_mir]), num(r[i_tir]), num(scan), num(track), conf, ver, num(frp), dn,
                        int(fire_type) if fire_type != "" else None,
                        "NRT" if "NRT" in ver.upper() else "SP",
                    ))
                    break
            if length is not None and counter.n != int(length):
                raise IOError("truncated: got %d of %s bytes" % (counter.n, length))
            return {"rows": rows, "read": read, "bytes": counter.n,
                    "last_modified": resp.headers.get("Last-Modified")}

    return with_retries(once)


def register_file(con, key, kind, source, country, year, url):
    con.execute("INSERT OR IGNORE INTO raw_files(file_key, kind, source, country, year, url, status) "
                "VALUES (?,?,?,?,?,?, 'pending')", (key, kind, source, country, year, url))
    return con.execute("SELECT file_id, status FROM raw_files WHERE file_key=?", (key,)).fetchone()


def store_result(con, file_id, result, error=None):
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    with con:
        con.execute("DELETE FROM raw_hotspots WHERE file_id=?", (file_id,))
        if error is not None:
            con.execute("UPDATE raw_files SET status='error', error=?, fetched_at=? WHERE file_id=?",
                        (error, now, file_id))
        elif result is None:
            con.execute("UPDATE raw_files SET status='missing', error='HTTP 404', fetched_at=? "
                        "WHERE file_id=?", (now, file_id))
        else:
            con.executemany("INSERT INTO raw_hotspots VALUES (%s)" % ",".join("?" * 19),
                            [(file_id,) + row for row in result["rows"]])
            con.execute("UPDATE raw_files SET status='done', error=NULL, http_last_modified=?, bytes=?, "
                        "rows_read=?, rows_kept=?, fetched_at=? WHERE file_id=?",
                        (result["last_modified"], result["bytes"], result["read"],
                         len(result["rows"]), now, file_id))


def run_downloads(con, jobs, workers):
    total, done, t0 = len(jobs), 0, time.time()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(stream_firms, url, source, regions): (fid, label)
                   for fid, label, url, source, regions in jobs}
        for fut in as_completed(futures):
            fid, label = futures[fut]
            done += 1
            try:
                res = fut.result()
                store_result(con, fid, res)
                if res is None:
                    log("[%d/%d] %s: missing (404)" % (done, total, label))
                else:
                    log("[%d/%d] %s: %s rows read, %s kept, %.1f MB" % (
                        done, total, label, format(res["read"], ","), format(len(res["rows"]), ","),
                        res["bytes"] / 1e6))
            except Exception as e:
                store_result(con, fid, None, error=str(e))
                log("[%d/%d] %s: ERROR %s" % (done, total, label, e))
    log("finished %d files in %.1f min" % (total, (time.time() - t0) / 60))


def country_jobs(cfg, args):
    sources = args.sources.split(",") if args.sources else list(cfg["firms_country"])
    wanted = set(args.countries.split(",")) if args.countries else None
    by_country = {}
    for reg in cfg["regions"]:
        for country in reg["countries"]:
            by_country.setdefault(country, []).append(reg)
    out = []
    for source in sources:
        first_year, last_year = cfg["firms_country"][source]
        for year in range(first_year, last_year + 1):
            for country, regions in by_country.items():
                if wanted is None or country in wanted:
                    url = FIRMS_COUNTRY_URL.format(s=source, y=year, c=country)
                    out.append((source, year, country, regions, url))
    return out


def cmd_plan(cfg, args):
    jobs = country_jobs(cfg, args)
    urls = [j[4] for j in jobs]

    def head(url):
        return with_retries(lambda: open_url(url, method="HEAD", timeout=60).headers.get("Content-Length"))

    with ThreadPoolExecutor(max_workers=8) as pool:
        sizes = dict(zip(urls, pool.map(head, urls)))
    table = {}
    for source, year, country, _, url in jobs:
        found, missing, nbytes, miss_years = table.get((source, country), (0, 0, 0, []))
        if sizes[url] is None:
            table[(source, country)] = (found, missing + 1, nbytes, miss_years + [year])
        else:
            table[(source, country)] = (found + 1, missing, nbytes + int(sizes[url]), miss_years)
    total = 0
    print("%-12s %-14s %5s %7s %9s" % ("source", "country", "files", "missing", "MB"))
    for (source, country), (found, missing, nbytes, miss_years) in sorted(table.items()):
        total += nbytes
        note = (" years " + ",".join(map(str, miss_years))) if miss_years else ""
        print("%-12s %-14s %5d %7d %9.0f%s" % (source, country, found, missing, nbytes / 1e6, note))
    print("total to stream: %.2f GB" % (total / 1e9))


def cmd_firms(cfg, args):
    con = connect(args.db)
    jobs = []
    for source, year, country, regions, url in country_jobs(cfg, args):
        fid, status = register_file(con, url, "country", source, country, year, url)
        if status in ("done", "missing") and not args.refresh:
            continue
        jobs.append((fid, "%s %d %s" % (source, year, country), url, source, regions))
    con.commit()
    log("%d country files to download (%d workers)" % (len(jobs), args.workers))
    run_downloads(con, jobs, args.workers)
    log("creating indexes")
    con.execute("CREATE INDEX IF NOT EXISTS raw_hotspots_region_date "
                "ON raw_hotspots(region_id, source, acq_date)")
    con.commit()


def cmd_firms7d(cfg, args):
    con = connect(args.db)
    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
    jobs = []
    for source, url in cfg["firms_7d"].items():
        fid, status = register_file(con, "%s@%s" % (url, today), "global7d", source, None, None, url)
        if status == "done" and not args.refresh:
            continue
        jobs.append((fid, "%s 7-day (%s)" % (source, today), url, source, cfg["regions"]))
    con.commit()
    run_downloads(con, jobs, args.workers)


def load_map_key():
    key = os.environ.get("FIRMS_MAP_KEY")
    if not key and os.path.exists(ENV_PATH):
        with open(ENV_PATH) as f:
            for line in f:
                if line.startswith("FIRMS_MAP_KEY="):
                    key = line.split("=", 1)[1].strip()
    if not key:
        sys.exit("FIRMS_MAP_KEY missing: set it in the environment or %s" % ENV_PATH)
    return key


def api_status(key):
    with open_url("%s/mapserver/mapkey_status/?MAP_KEY=%s" % (FIRMS_API, key), timeout=60) as resp:
        return json.load(resp)


def api_availability(key):
    with open_url("%s/api/data_availability/csv/%s/ALL" % (FIRMS_API, key), timeout=60) as resp:
        rows = csv.DictReader(io.TextIOWrapper(resp, encoding="utf-8"))
        return {r["data_id"]: (dt.date.fromisoformat(r["min_date"]), dt.date.fromisoformat(r["max_date"]))
                for r in rows}


class TransactionBudget:
    def __init__(self, already_used):
        self.lock = threading.Lock()
        self.spent = collections.deque([(time.time(), already_used)])

    def acquire(self, cost):
        while True:
            with self.lock:
                now = time.time()
                while self.spent and now - self.spent[0][0] > TRANSACTION_WINDOW_S:
                    self.spent.popleft()
                if sum(c for _, c in self.spent) + cost <= TRANSACTION_BUDGET:
                    self.spent.append((now, cost))
                    return
                wait = TRANSACTION_WINDOW_S - (now - self.spent[0][0]) + 1
            time.sleep(min(max(wait, 1), 30))


def api_windows(cfg, args, availability, today):
    wanted_regions = set(args.regions.split(",")) if args.regions else None
    wanted_sats = set(args.sources.split(",")) if args.sources else None
    out = []
    for reg in cfg["regions"]:
        if wanted_regions and reg["id"] not in wanted_regions:
            continue
        for sat, spec in cfg["firms_api"].items():
            if wanted_sats and sat not in wanted_sats:
                continue
            start = dt.date.fromisoformat(spec["start"])
            end = min(dt.date.fromisoformat(spec["end"]), today) if spec["end"] else today
            if reg["history"] == "country_files":
                start = max(start, dt.date(cfg["firms_country"]["modis"][1] + 1, 1, 1))
            sp_end = availability[spec["sp"]][1]
            day = start
            while day <= end:
                product, limit = (spec["sp"], min(sp_end, end)) if day <= sp_end else (spec["nrt"], end)
                days = min(5, (limit - day).days + 1)
                out.append((reg, sat, product, day, days))
                day += dt.timedelta(days=days)
    return out


def cmd_api(cfg, args):
    key = load_map_key()
    con = connect(args.db)
    today = dt.datetime.now(dt.timezone.utc).date()
    availability = api_availability(key)
    jobs = []
    for reg, sat, product, day, days in api_windows(cfg, args, availability, today):
        file_key = "api:%s:%s:%s:%d" % (product, reg["id"], day.isoformat(), days)
        public_url = "%s/api/area/csv/<MAP_KEY>/%s/%s/%d/%s" % (
            FIRMS_API, product, ",".join(str(v) for v in reg["buffered"]), days, day.isoformat())
        fid, status = register_file(con, file_key, "api", API_SATELLITE_SOURCE[sat], None, day.year, public_url)
        if status in ("done", "missing") and not args.refresh:
            continue
        jobs.append((fid, reg, sat, product, day, days, public_url.replace("<MAP_KEY>", key)))
    con.commit()
    cost = sum(j[5] for j in jobs) * TRANSACTIONS_PER_DAY
    log("%d API windows to fetch, about %d transactions (~%.0f min at the limit)" % (
        len(jobs), cost, cost / TRANSACTION_BUDGET * TRANSACTION_WINDOW_S / 60))
    budget = TransactionBudget(api_status(key).get("current_transactions", 0))

    def fetch(job):
        _, reg, sat, _, _, days, url = job
        budget.acquire(days * TRANSACTIONS_PER_DAY)
        return stream_firms(url, API_SATELLITE_SOURCE[sat], [reg])

    done, kept, errors, t0 = 0, 0, 0, time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(fetch, j): j for j in jobs}
        for fut in as_completed(futures):
            fid, reg, sat, product, day, days, _ = futures[fut]
            done += 1
            try:
                res = fut.result()
                store_result(con, fid, res)
                kept += len(res["rows"]) if res else 0
            except Exception as e:
                errors += 1
                store_result(con, fid, None, error=str(e))
                log("ERROR %s %s %s: %s" % (product, reg["id"], day, e))
            if done % 50 == 0 or done == len(jobs):
                log("%d/%d windows, %s rows kept, %d errors, %.1f min" % (
                    done, len(jobs), format(kept, ","), errors, (time.time() - t0) / 60))


def cmr_footprint(entry):
    polygons = []
    for poly in entry.get("polygons") or []:
        rings = []
        for ring in poly:
            values = [float(x) for x in ring.split()]
            lats, lons = values[0::2], values[1::2]
            rings.append([[lon, lat] for lat, lon in zip(lats, lons)])
        polygons.append(rings)
    for box in entry.get("boxes") or []:
        south, west, north, east = (float(x) for x in box.split())
        polygons.append([[[west, south], [east, south], [east, north], [west, north], [west, south]]])
    return json.dumps(polygons, separators=(",", ":")) if polygons else None


def fetch_cmr_slice(product, region, year):
    start = max(dt.date.fromisoformat(product["start"]), dt.date(year, 1, 1))
    last = dt.date.fromisoformat(product["end"]) if product["end"] else dt.date.today()
    end = min(last, dt.date(year, 12, 31))
    west, south, east, north = region["buffered"]
    params = urllib.parse.urlencode({
        "collection_concept_id": product["concept_id"],
        "bounding_box": "%s,%s,%s,%s" % (west, south, east, north),
        "temporal": "%sT00:00:00Z,%sT23:59:59Z" % (start.isoformat(), end.isoformat()),
        "page_size": 2000,
        "sort_key": "start_date",
    })
    rows, search_after = [], None
    while True:
        headers = {"CMR-Search-After": search_after} if search_after else {}

        def page():
            with open_url(CMR_GRANULES_URL + "?" + params, headers=headers, timeout=180) as resp:
                return (int(resp.headers.get("CMR-Hits", "0")), resp.headers.get("CMR-Search-After"),
                        json.load(resp)["feed"]["entry"])

        hits, search_after, entries = with_retries(page)
        for x in entries:
            rows.append((product["short_name"], region["id"], x.get("title") or x["id"],
                         x["time_start"], x.get("time_end"), x.get("day_night_flag"), cmr_footprint(x)))
        if not entries or len(rows) >= hits or not search_after:
            return hits, rows


def cmd_cmr(cfg, args):
    con = connect(args.db)
    tasks = []
    for product in cfg["cmr"]:
        first_year = int(product["start"][:4])
        last_year = int(product["end"][:4]) if product["end"] else dt.date.today().year
        for region in cfg["regions"]:
            for year in range(first_year, last_year + 1):
                row = con.execute("SELECT done FROM cmr_slices WHERE short_name=? AND region_id=? AND year=?",
                                  (product["short_name"], region["id"], year)).fetchone()
                open_ended = product["end"] is None and year == dt.date.today().year
                if row and row[0] and not args.refresh and not open_ended:
                    continue
                tasks.append((product, region, year))
    log("%d CMR slices to fetch" % len(tasks))
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(fetch_cmr_slice, *t): t for t in tasks}
        for i, fut in enumerate(as_completed(futures), 1):
            product, region, year = futures[fut]
            label = "%s %s %d" % (product["short_name"], region["id"], year)
            try:
                hits, rows = fut.result()
            except Exception as e:
                log("[%d/%d] %s: ERROR %s" % (i, len(tasks), label, e))
                continue
            with con:
                con.executemany("INSERT OR REPLACE INTO cmr_granules VALUES (?,?,?,?,?,?,?)", rows)
                con.execute("INSERT OR REPLACE INTO cmr_slices VALUES (?,?,?,?,?,1)",
                            (product["short_name"], region["id"], year, hits, len(rows)))
            log("[%d/%d] %s: %d granules" % (i, len(tasks), label, len(rows)))


def cmd_boundaries(cfg, args):
    con = connect(args.db)
    with open_url(BOUNDARIES_URL, timeout=120) as resp:
        features = json.load(resp)["features"]
    with con:
        con.execute("DELETE FROM country_boundaries")
        con.executemany("INSERT INTO country_boundaries VALUES (?,?,?)", [
            (f["properties"]["NAME"], f["properties"].get("ISO_A3"),
             json.dumps(f["geometry"], separators=(",", ":"))) for f in features])
    log("stored %d country boundaries" % len(features))


def cmd_summary(cfg, args):
    con = connect(args.db)
    print("FILES")
    for row in con.execute("SELECT kind, source, status, COUNT(*), ROUND(SUM(bytes)/1e9, 2), SUM(rows_kept) "
                           "FROM raw_files GROUP BY 1,2,3 ORDER BY 1,2,3"):
        print("  %-9s %-12s %-8s files=%-4d GB=%-6s kept=%s" % row)
    for row in con.execute("SELECT source, year, country, error FROM raw_files "
                           "WHERE status IN ('missing','error') ORDER BY 1,2,3"):
        print("  not loaded: %s %s %s (%s)" % row)
    print("\nHOTSPOTS IN EXACT BOX")
    for row in con.execute(
            "SELECT region_id, source, MIN(acq_date), MAX(acq_date), SUM(type = 0), COUNT(*) "
            "FROM raw_hotspots WHERE in_box = 1 GROUP BY 1,2 ORDER BY 1,2"):
        print("  %-13s %-12s %s .. %s  type0=%-10s all=%s" % (
            row[0], row[1], row[2], row[3], format(row[4] or 0, ","), format(row[5], ",")))
    total = con.execute("SELECT COUNT(*), SUM(in_box) FROM raw_hotspots").fetchone()
    print("  total rows %s (in exact boxes %s)" % (format(total[0], ","), format(total[1] or 0, ",")))
    if args.by_year:
        print("\nIN-BOX ROWS BY YEAR")
        for row in con.execute("SELECT region_id, source, substr(acq_date,1,4), COUNT(*) FROM raw_hotspots "
                               "WHERE in_box=1 GROUP BY 1,2,3 ORDER BY 1,2,3"):
            print("  %-13s %-12s %s %s" % (row[0], row[1], row[2], format(row[3], ",")))
    print("\nCMR GRANULES")
    for row in con.execute("SELECT short_name, region_id, MIN(time_start), MAX(time_start), COUNT(*) "
                           "FROM cmr_granules GROUP BY 1,2 ORDER BY 1,2"):
        print("  %-9s %-13s %s .. %s  %s" % (row[0], row[1], row[2][:10], row[3][:10], format(row[4], ",")))
    print("\nCOUNTRY BOUNDARIES: %d" % con.execute("SELECT COUNT(*) FROM country_boundaries").fetchone()[0])
    size = os.path.getsize(args.db) / 1e9 if os.path.exists(args.db) else 0
    print("database: %s (%.2f GB)" % (args.db, size))


COMMANDS = {"plan": cmd_plan, "firms": cmd_firms, "firms7d": cmd_firms7d, "api": cmd_api,
            "cmr": cmd_cmr, "boundaries": cmd_boundaries, "summary": cmd_summary}


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=list(COMMANDS))
    p.add_argument("--db", default=DEFAULT_DB)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--sources")
    p.add_argument("--countries")
    p.add_argument("--regions")
    p.add_argument("--refresh", action="store_true")
    p.add_argument("--by-year", action="store_true")
    args = p.parse_args()
    COMMANDS[args.command](load_config(), args)


if __name__ == "__main__":
    sys.exit(main())
