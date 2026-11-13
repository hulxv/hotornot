"""Normalize raw FIRMS rows from finished files into `hotspots` (CONTRACTS schema).

Every run rebuilds the table: drop it, then refill it one slice (region, raw source, month) at
a time in append-only transactions of `batch_rows` rows. Rows arrive in nearly the order of
the (region_id, satellite, acq_date) and tile_id indexes, so those are kept current during the
load. Keeping the hotspot_id and cell_id indexes current instead rewrote about 150 MB of
scattered pages per 50k-row transaction on the 10M-row table, so they are built after the load
in one sorted pass each. That is also why `hotspot_id` is unique through an index rather than
a declared PRIMARY KEY, which SQLite would maintain row by row.
"""
import hashlib
import time
from collections import Counter
from datetime import date, timedelta

from hotornot import config, db, grid
from hotornot.ingest.ingest import API_SATELLITE_SOURCE

NAME = "normalize"
HELP = "Rebuild `hotspots` from finished raw files: map columns, drop duplicates, SP replaces NRT."

BATCH_ROWS = 50_000
CACHE_KIB = 256 * 1024
# Readers that stay open keep the WAL from being reset, so it grows by every page written.
# Writing pauses above this many un-checkpointed 4 KiB frames (1 GiB) to protect free disk.
WAL_FRAME_LIMIT = 262_144

SENSOR = {"Terra": "MODIS", "Aqua": "MODIS", "S-NPP": "VIIRS_375", "NOAA-20": "VIIRS_375"}
# The FIRMS global 7-day VIIRS file spells confidence out; every other VIIRS file uses l/n/h.
CONFIDENCE = {"low": "l", "nominal": "n", "high": "h"}

COLUMNS = ("hotspot_id", "region_id", "in_box", "satellite", "sensor", "acq_utc", "acq_date",
           "ym", "lat", "lon", "daynight", "frp_mw", "scan_km", "track_km", "confidence",
           "fire_type", "processing", "cell_id", "tile_id", "file_id")

DDL = """
CREATE TABLE hotspots (
    hotspot_id  TEXT NOT NULL,
    region_id   TEXT NOT NULL,
    in_box      INTEGER NOT NULL,
    satellite   TEXT NOT NULL,
    sensor      TEXT NOT NULL,
    acq_utc     TEXT NOT NULL,
    acq_date    TEXT NOT NULL,
    ym          INTEGER NOT NULL,
    lat         REAL NOT NULL,
    lon         REAL NOT NULL,
    daynight    TEXT,
    frp_mw      REAL,
    scan_km     REAL,
    track_km    REAL,
    confidence  TEXT,
    fire_type   INTEGER,
    processing  TEXT NOT NULL,
    cell_id     INTEGER NOT NULL,
    tile_id     TEXT NOT NULL,
    file_id     INTEGER NOT NULL
);
CREATE INDEX hotspots_region_satellite_date ON hotspots(region_id, satellite, acq_date);
CREATE INDEX hotspots_tile ON hotspots(tile_id);
"""
INDEXES_AFTER_LOAD = {
    "hotspots_hotspot_id": "CREATE UNIQUE INDEX hotspots_hotspot_id ON hotspots(hotspot_id)",
    "hotspots_cell": "CREATE INDEX hotspots_cell ON hotspots(cell_id)",
}

RAW_SLICE_SQL = """
SELECT rowid, file_id, in_box, satellite, latitude, longitude, acq_date, acq_time, scan, track,
       confidence, frp, daynight, type, processing
FROM raw_hotspots
WHERE region_id = ? AND source = ? AND acq_date >= ? AND acq_date < ?"""
INSERT_SQL = f"INSERT INTO hotspots VALUES ({', '.join('?' * len(COLUMNS))})"


def add_arguments(parser):
    parser.add_argument("--batch-rows", type=int, default=BATCH_ROWS,
                        help=f"rows per insert transaction (default {BATCH_ROWS:,})")


def run(args):
    con = db.connect()
    con.execute(f"PRAGMA cache_size = -{CACHE_KIB}")
    con.execute("PRAGMA threads = 4")
    try:
        report = normalize(con, batch_rows=args.batch_rows)
    finally:
        con.close()
    written = report["written"]
    print(f"hotspots: {report['rows']:,} rows from {report['raw_rows']:,} raw rows; dropped "
          f"{report['duplicates_dropped']:,} duplicates and {report['nrt_replaced_by_sp']:,} NRT "
          f"rows on SP days; in-box NRT share {report['nrt_share']:.4%}")
    print(f"old table dropped in {written['drop_s']} s; {written['transactions']} insert "
          f"transactions, longest {written['longest_s']} s; indexes built in "
          f"{written['index_s']} s; total {report['seconds']:.0f} s")
    if report["files_not_done"]:
        print(f"{report['files_not_done']:,} raw files are not finished yet; rerun when they are")
    return 0


def hotspot_id(satellite, acq_date, acq_time, lat, lon):
    key = f"{satellite}|{acq_date}|{acq_time}|{lat:.5f}|{lon:.5f}"
    return hashlib.sha1(key.encode()).hexdigest()[:16]


def normalize(con, cfg=None, batch_rows=BATCH_ROWS, log=None):
    """Rebuild `hotspots` from the finished raw files and store `normalize:report`."""
    started = time.monotonic()
    log = log or (lambda msg: print(msg, flush=True))
    cfg = cfg or config.load_config()
    files = {file_id: fetched_at or "" for file_id, fetched_at in con.execute(
        "SELECT file_id, fetched_at FROM raw_files WHERE status = 'done'")}
    sp_windows = _sp_window_days(con, cfg)
    slices = sorted(con.execute(
        "SELECT DISTINCT region_id, source, substr(acq_date, 1, 7) FROM raw_hotspots"))
    t = time.monotonic()
    with con:
        db.recreate(con, DDL)
    drop_s = round(time.monotonic() - t, 1)

    stats, in_box, tiles = Counter(), Counter(), {}
    writer = _Writer(con, batch_rows, log)
    group = None
    for region_id, source, month in slices:
        if group != (region_id, source):
            group = (region_id, source)
            log(f"{region_id} {source} from {month}: {stats['rows']:,} rows so far, "
                f"{time.monotonic() - started:.0f} s")
        raw = con.execute(RAW_SLICE_SQL, (region_id, source, *_month_range(month))).fetchall()
        rows = _build_slice(raw, files, sp_windows.get((region_id, source), ()), region_id,
                            tiles, stats)
        for r in rows:
            if r[2]:
                in_box[r[1], r[3], int(r[6][:4]), r[16]] += 1
        writer.add(rows)
    writer.flush()

    index_s = {}
    for name, ddl in INDEXES_AFTER_LOAD.items():
        log(f"indexing {name}")
        _wait_for_checkpoint(con, log)
        t = time.monotonic()
        with con:
            con.execute(ddl)
        index_s[name] = round(time.monotonic() - t, 1)

    by_key = {}
    for (region_id, satellite, year, processing), n in in_box.items():
        entry = by_key.setdefault((region_id, satellite, year), {
            "region_id": region_id, "satellite": satellite, "year": year, "rows": 0,
            "nrt_rows": 0})
        entry["rows"] += n
        if processing == "NRT":
            entry["nrt_rows"] += n
    in_box_rows = sum(e["rows"] for e in by_key.values())
    report = {
        "raw_rows": stats["raw_rows"],
        "rows": stats["rows"],
        "duplicates_dropped": stats["duplicates"],
        "nrt_replaced_by_sp": stats["nrt_replaced"],
        "nrt_share": (sum(e["nrt_rows"] for e in by_key.values()) / in_box_rows
                      if in_box_rows else 0.0),
        "files_done": len(files),
        "files_not_done": con.execute(
            "SELECT COUNT(*) FROM raw_files WHERE status NOT IN ('done', 'missing')").fetchone()[0],
        "in_box": [by_key[k] for k in sorted(by_key)],
        "written": {"drop_s": drop_s, "transactions": writer.transactions,
                    "longest_s": round(writer.longest_s, 2), "index_s": index_s},
        "seconds": round(time.monotonic() - started, 1),
    }
    db.put_artifact("normalize:report", report, con)
    return report


def _sp_window_days(con, cfg):
    """{(region_id, source): dates} covered by finished SP API windows, rows or not.

    SP is final for every day of the window, so NRT rows on a day where SP found nothing in
    the region are stale too.
    """
    sp_source = {spec["sp"]: API_SATELLITE_SOURCE[sat] for sat, spec in cfg["firms_api"].items()}
    days = {}
    for (key,) in con.execute(
            "SELECT file_key FROM raw_files WHERE kind = 'api' AND status = 'done'"):
        parts = key.split(":")
        if len(parts) == 5 and parts[1] in sp_source:
            _, product, region_id, first, n = parts
            start = date.fromisoformat(first)
            days.setdefault((region_id, sp_source[product]), set()).update(
                (start + timedelta(days=i)).isoformat() for i in range(int(n)))
    return days


def _month_range(month):
    year, mon = int(month[:4]), int(month[5:7])
    return f"{month}-01", f"{year + mon // 12:04d}-{mon % 12 + 1:02d}-01"


def _build_slice(raw, files, sp_window_days, region_id, tiles, stats):
    best, sp_days = {}, set()
    read = 0
    for r in raw:
        rowid, file_id, _, sat, lat, lon, acq_date, acq_time = r[:8]
        fetched = files.get(file_id)
        if fetched is None:
            continue
        read += 1
        processing = r[14]
        if processing == "SP":
            sp_days.add((sat, acq_date))
        hid = hotspot_id(sat, acq_date, acq_time, lat, lon)
        rank = (processing == "SP", fetched, file_id, -rowid)
        kept = best.get(hid)
        if kept is None or rank > kept[0]:
            best[hid] = (rank, r)
    stats["raw_rows"] += read
    stats["duplicates"] += read - len(best)

    rows = []
    for hid, (_, r) in best.items():
        (_, file_id, in_box, sat, lat, lon, acq_date, acq_time, scan, track, confidence, frp,
         daynight, fire_type, processing) = r
        if processing == "NRT" and ((sat, acq_date) in sp_days or acq_date in sp_window_days):
            stats["nrt_replaced"] += 1
            continue
        cell_id = grid.cell_of(lat, lon)[2]
        tile_id = tiles.get(cell_id)
        if tile_id is None:
            tile_id = tiles[cell_id] = grid.tile_of(cell_id)
        rows.append((hid, region_id, in_box, sat, SENSOR[sat],
                     f"{acq_date}T{acq_time[:2]}:{acq_time[2:]}Z", acq_date,
                     int(acq_date[:4]) * 100 + int(acq_date[5:7]), lat, lon, daynight, frp, scan,
                     track, CONFIDENCE.get(confidence, confidence), fire_type, processing,
                     cell_id, tile_id, file_id))
    stats["rows"] += len(rows)
    rows.sort(key=lambda row: (row[3], row[5], row[0]))
    return rows


def _wait_for_checkpoint(con, log):
    waited = False
    while True:
        _, frames, backfilled = con.execute("PRAGMA wal_checkpoint(PASSIVE)").fetchone()
        if frames < WAL_FRAME_LIMIT or backfilled >= frames:
            if waited:
                log("WAL checkpointed, writing again")
            return
        if not waited:
            log(f"WAL holds {frames:,} frames that an open reader keeps from being "
                "checkpointed; waiting")
            waited = True
        time.sleep(5)


class _Writer:
    def __init__(self, con, batch_rows, log):
        self.con, self.batch_rows, self.log = con, batch_rows, log
        self.rows = []
        self.transactions = 0
        self.longest_s = 0.0

    def add(self, rows):
        self.rows += rows
        while len(self.rows) >= self.batch_rows:
            self._write(self.rows[:self.batch_rows])
            self.rows = self.rows[self.batch_rows:]

    def flush(self):
        if self.rows:
            self._write(self.rows)
            self.rows = []

    def _write(self, rows):
        _wait_for_checkpoint(self.con, self.log)
        started = time.monotonic()
        with self.con:
            self.con.executemany(INSERT_SQL, rows)
        self.transactions += 1
        self.longest_s = max(self.longest_s, time.monotonic() - started)
