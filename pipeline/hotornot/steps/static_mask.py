"""Static-source mask for NRT rows, which carry no FIRMS `type`: `static_sources`, `static_mask`.

An NRT row is masked as

- `near_sp_static` when it lies within `radius_km` of a static source: a location merged from
  the region's last `source_days` of SP rows of type 1 to 3 (volcano, other static land
  source, offshore) and detected on at least `min_source_days` days,
- `persistent` when its `bucket_deg` bucket has detections on at least `min_days` distinct days
  in the `window_days` ending on its date. This catches flares newer than the SP rows.

The leakage test applies both rules to the SP rows of `test_year` with their type hidden, using
static sources from earlier SP years only.
"""
import bisect
import math
import time
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from datetime import date

from hotornot import config, db, geo

NAME = "static-mask"
HELP = "Mask NRT rows near SP static sources or at persistent locations; print the leakage test."

SATELLITES = ("Terra", "Aqua", "S-NPP", "NOAA-20")
SENSORS = ("MODIS", "VIIRS_375")
REASONS = ("near_sp_static", "persistent")
TEST_YEAR = 2025
LEAKAGE_LIMIT = 0.05
FALSE_MASKING_LIMIT = 0.02

# Merge seeds are the densest spots first; this cell size only ranks them.
SEED_CELL_DEG = 0.001

DDL = """
CREATE TABLE static_sources (
    region_id TEXT NOT NULL,
    lat       REAL NOT NULL,
    lon       REAL NOT NULL,
    fire_type INTEGER NOT NULL,
    n_days    INTEGER NOT NULL
);
CREATE TABLE static_mask (
    hotspot_id TEXT PRIMARY KEY,
    reason     TEXT NOT NULL
) WITHOUT ROWID;
"""


@dataclass(frozen=True)
class Params:
    """Defaults are the best found by the 2025 leakage test; see the P04 hand-off."""
    merge_km: float = 0.375
    radius_km: float = 0.5
    source_days: int = 365
    min_source_days: int = 20
    bucket_deg: float = 0.004
    min_days: int = 20
    window_days: int = 90


def merge_locations(rows, merge_km):
    """[(lat, lon, fire_type, n_days)] from SP rows (lat, lon, fire_type, acq_date).

    Rows are taken densest spot first. A row within `merge_km` of a location's first row joins
    the nearest such location, otherwise it starts one. A location sits at the mean of its rows
    and takes their most common type.
    """
    seed_cells = Counter(_cell(lat, lon, SEED_CELL_DEG) for lat, lon, _, _ in rows)
    order = sorted(rows, key=lambda r: (-seed_cells[_cell(r[0], r[1], SEED_CELL_DEG)],
                                        _cell(r[0], r[1], SEED_CELL_DEG), r))
    seeds = geo.GridIndex(merge_km)
    members = []
    for row in order:
        near = seeds.near(row[0], row[1], merge_km)
        if near:
            members[near[0][1]].append(row)
        else:
            seeds.add(row[0], row[1], len(members))
            members.append([row])
    locations = []
    for group in members:
        types = Counter(r[2] for r in group)
        locations.append((sum(r[0] for r in group) / len(group),
                          sum(r[1] for r in group) / len(group),
                          min(types, key=lambda t: (-types[t], t)),
                          len({r[3] for r in group})))
    return locations


def static_sources(static_rows, params, until=None):
    """Locations from the SP rows (lat, lon, fire_type, acq_date) of type 1 to 3 dated up to
    `until` and within `source_days` (0: all) of the latest of them."""
    rows = [r for r in static_rows if until is None or r[3] <= until]
    if rows and params.source_days:
        first = _shift(max(r[3] for r in rows), 1 - params.source_days)
        rows = [r for r in rows if r[3] >= first]
    return [s for s in merge_locations(rows, params.merge_km) if s[3] >= params.min_source_days]


def _cell(lat, lon, size_deg):
    return math.floor(lat / size_deg), math.floor(lon / size_deg)


class Masker:
    """Both rules over fixed static sources and the detections (lat, lon, acq_date) that feed
    the persistence counts."""

    def __init__(self, sources, detections, params):
        self.params = params
        self.sources = geo.GridIndex(params.radius_km)
        for lat, lon, *_ in sources:
            self.sources.add(lat, lon, None)
        days = defaultdict(set)
        for lat, lon, acq_date in detections:
            days[_cell(lat, lon, params.bucket_deg)].add(_day(acq_date))
        self.days = {bucket: sorted(d) for bucket, d in days.items()}

    def reason(self, lat, lon, acq_date):
        """`near_sp_static`, `persistent` or None."""
        if self.sources.near(lat, lon, self.params.radius_km):
            return "near_sp_static"
        if self.days_seen(lat, lon, acq_date) >= self.params.min_days:
            return "persistent"
        return None

    def days_seen(self, lat, lon, acq_date):
        """Distinct detection days in the row's bucket in the window ending on its date."""
        seq = self.days.get(_cell(lat, lon, self.params.bucket_deg), ())
        day = _day(acq_date)
        return (bisect.bisect_right(seq, day)
                - bisect.bisect_left(seq, day - self.params.window_days + 1))


def _day(acq_date):
    return date.fromisoformat(acq_date).toordinal()


def _shift(acq_date, days):
    return date.fromordinal(_day(acq_date) + days).isoformat()


def select_rows(con, region_id, columns, first=None, last=None, where=""):
    """Rows of one region, read one satellite-year at a time so no read stays open for long."""
    for satellite in SATELLITES:
        lo, hi = con.execute(
            "SELECT MIN(acq_date), MAX(acq_date) FROM hotspots WHERE region_id = ? AND satellite = ?",
            (region_id, satellite)).fetchone()
        if lo is None:
            continue
        lo, hi = max(lo, first or lo), min(hi, last or hi)
        for year in range(int(lo[:4]), int(hi[:4]) + 1):
            yield from con.execute(
                f"SELECT {columns} FROM hotspots WHERE region_id = ? AND satellite = ?"
                f" AND acq_date BETWEEN ? AND ?{where}",
                (region_id, satellite, max(lo, f"{year}-01-01"), min(hi, f"{year}-12-31"))
            ).fetchall()


def leakage_test(static_rows, window_rows, test_year, params):
    """Counts per sensor and in total for the SP in-box rows of `test_year`, typed as if NRT.

    `static_rows` are SP rows (lat, lon, fire_type, acq_date) of type 1 to 3, all years;
    `window_rows` are every row (lat, lon, acq_date, fire_type, processing, in_box, sensor) from
    `window_days` before the test year to its end.
    """
    sources = static_sources(static_rows, params, until=f"{test_year - 1}-12-31")
    masker = Masker(sources, [r[:3] for r in window_rows], params)
    stats = {key: _empty_stats() for key in ("all", *SENSORS)}
    first, last = None, None
    for lat, lon, acq_date, fire_type, processing, in_box, sensor in window_rows:
        if processing != "SP" or not in_box or not acq_date.startswith(str(test_year)):
            continue
        first, last = min(first or acq_date, acq_date), max(last or acq_date, acq_date)
        reason = masker.reason(lat, lon, acq_date)
        for s in (stats["all"], stats[sensor]):
            if fire_type == 0:
                s["type0"] += 1
                if reason:
                    s["false_masked"] += 1
                    s["false_masked_by_reason"][reason] += 1
            else:
                s["static"] += 1
                if reason:
                    s["caught_by_reason"][reason] += 1
                else:
                    s["leaked"] += 1
    for s in stats.values():
        s["leakage"] = s["leaked"] / s["type0"] if s["type0"] else None
        s["false_masking"] = s["false_masked"] / s["type0"] if s["type0"] else None
    all_ = stats["all"]
    return {
        "test_year": test_year,
        "first_date": first,
        "last_date": last,
        "sources": len(sources),
        "passed": (all_["type0"] > 0 and all_["leakage"] < LEAKAGE_LIMIT
                   and all_["false_masking"] < FALSE_MASKING_LIMIT),
        "by_sensor": stats,
    }


def _empty_stats():
    return {"type0": 0, "static": 0, "leaked": 0, "false_masked": 0,
            "caught_by_reason": dict.fromkeys(REASONS, 0),
            "false_masked_by_reason": dict.fromkeys(REASONS, 0)}


def mask_region(con, region_id, params, test_year=TEST_YEAR):
    """(static source rows, static_mask rows, report entry) for one region."""
    static_rows, nrt = [], []
    for hotspot_id, lat, lon, acq_date, fire_type, processing, in_box in select_rows(
            con, region_id, "hotspot_id, lat, lon, acq_date, fire_type, processing, in_box",
            where=" AND (processing = 'NRT' OR fire_type BETWEEN 1 AND 3)"):
        if processing == "NRT":
            nrt.append((hotspot_id, lat, lon, acq_date, in_box))
        else:
            static_rows.append((lat, lon, fire_type, acq_date))

    sources = static_sources(static_rows, params)
    masked, by_reason, in_box_by_reason = [], Counter(), Counter()
    if nrt:
        first = min(r[3] for r in nrt)
        last = max(r[3] for r in nrt)
        detections = list(select_rows(con, region_id, "lat, lon, acq_date",
                                      _shift(first, 1 - params.window_days), last))
        masker = Masker(sources, detections, params)
        del detections
        for hotspot_id, lat, lon, acq_date, in_box in nrt:
            reason = masker.reason(lat, lon, acq_date)
            if reason:
                masked.append((hotspot_id, reason))
                by_reason[reason] += 1
                in_box_by_reason[reason] += in_box

    window_rows = list(select_rows(
        con, region_id, "lat, lon, acq_date, fire_type, processing, in_box, sensor",
        _shift(f"{test_year}-01-01", 1 - params.window_days), f"{test_year}-12-31"))
    test = leakage_test(static_rows, window_rows, test_year, params)

    entry = {
        "region_id": region_id,
        "static_sources": {
            "sp_rows": len(static_rows),
            "locations": len(sources),
            "by_type": {str(t): n for t, n in sorted(Counter(s[2] for s in sources).items())},
        },
        "nrt": {
            "rows": len(nrt),
            "in_box": sum(r[4] for r in nrt),
            "first_date": min((r[3] for r in nrt), default=None),
            "last_date": max((r[3] for r in nrt), default=None),
            "masked_by_reason": {r: by_reason[r] for r in REASONS},
            "in_box_masked_by_reason": {r: in_box_by_reason[r] for r in REASONS},
        },
        "leakage_test": test,
    }
    return [(region_id, *s) for s in sources], masked, entry


def build(con, cfg, params, test_year=TEST_YEAR, log=print):
    started = time.monotonic()
    sources, masked, entries = [], [], []
    for region in cfg["regions"]:
        log(f"{region['id']}: reading rows, {time.monotonic() - started:.0f} s")
        s, m, entry = mask_region(con, region["id"], params, test_year)
        sources += s
        masked += m
        entries.append(entry)
    report = {
        "params": asdict(params),
        "test_year": test_year,
        "limits": {"leakage": LEAKAGE_LIMIT, "false_masking": FALSE_MASKING_LIMIT},
        "passed": all(e["leakage_test"]["passed"] for e in entries),
        "regions": entries,
        "seconds": round(time.monotonic() - started, 1),
    }
    return sources, masked, report


def write(con, sources, masked, report):
    with con:
        db.recreate(con, DDL)
        con.executemany("INSERT INTO static_sources VALUES (?, ?, ?, ?, ?)", sources)
        con.executemany("INSERT INTO static_mask VALUES (?, ?)", masked)
        db.put_artifact("static_mask:report", report, con)


def _pct(x):
    return "-" if x is None else f"{x:.2%}"


def print_report(report):
    p = report["params"]
    span = f"the last {p['source_days']} days of" if p["source_days"] else "all"
    print(f"parameters: sources from {span} SP static rows, merged within {p['merge_km']} km,"
          f" kept with {p['min_source_days']}+ days; mask radius {p['radius_km']} km; persistent"
          f" at {p['min_days']} days in {p['window_days']} in a {p['bucket_deg']}° bucket")
    print(f"\n{'region':<13} {'SP static rows':>14} {'locations':>9}  types 1/2/3"
          f"  {'NRT rows':>8} {'near_sp_static':>14} {'persistent':>10}  unmasked")
    for e in report["regions"]:
        s, n = e["static_sources"], e["nrt"]
        types = "/".join(f"{s['by_type'].get(t, 0):,}" for t in "123")
        near, pers = n["masked_by_reason"]["near_sp_static"], n["masked_by_reason"]["persistent"]
        print(f"{e['region_id']:<13} {s['sp_rows']:>14,} {s['locations']:>9,}  {types:<11}"
              f"  {n['rows']:>8,} {near:>14,} {pers:>10,}  {n['rows'] - near - pers:>8,}")

    year = report["test_year"]
    print(f"\nLeakage test: static sources from SP rows through {year - 1}, type hidden on {year}"
          f" SP in-box rows")
    print("leakage = unmasked type 1-3 / type 0; false masking = masked type 0 / type 0;"
          f" limits {report['limits']['leakage']:.0%} and {report['limits']['false_masking']:.0%}")
    print(f"{'region':<13} {'sensor':<9} {'test rows':<23} {'type 0':>8} {'type 1-3':>8}"
          f" {'leaked':>7} {'false masked':>12} {'leakage':>8} {'false mask':>10}  result")
    for e in report["regions"]:
        t = e["leakage_test"]
        span = f"{t['first_date']}..{t['last_date']}" if t["first_date"] else "none"
        for sensor, s in t["by_sensor"].items():
            result = ("pass" if t["passed"] else "FAIL") if sensor == "all" else ""
            print(f"{e['region_id'] if sensor == 'all' else '':<13} {sensor:<9}"
                  f" {span if sensor == 'all' else '':<23} {s['type0']:>8,} {s['static']:>8,}"
                  f" {s['leaked']:>7,} {s['false_masked']:>12,} {_pct(s['leakage']):>8}"
                  f" {_pct(s['false_masking']):>10}  {result}")
    print(f"\n{'all regions pass' if report['passed'] else 'some regions FAIL'};"
          f" {report['seconds']:.0f} s")


def add_arguments(parser):
    d = Params()
    parser.add_argument("--merge-km", type=float, default=d.merge_km,
                        help="SP rows this close to a location's first row join it (default %(default)s)")
    parser.add_argument("--radius-km", type=float, default=d.radius_km,
                        help="mask NRT rows this close to a static source (default %(default)s)")
    parser.add_argument("--source-days", type=int, default=d.source_days,
                        help="build sources from the last this many days of SP static rows;"
                             " 0 for all (default %(default)s)")
    parser.add_argument("--min-source-days", type=int, default=d.min_source_days,
                        help="detection days a source needs (default %(default)s)")
    parser.add_argument("--bucket-deg", type=float, default=d.bucket_deg,
                        help="persistence bucket size in degrees (default %(default)s)")
    parser.add_argument("--min-days", type=int, default=d.min_days,
                        help="detection days that make a bucket persistent (default %(default)s)")
    parser.add_argument("--window-days", type=int, default=d.window_days,
                        help="trailing window for --min-days, ending on the row's date"
                             " (default %(default)s)")
    parser.add_argument("--test-year", type=int, default=TEST_YEAR,
                        help="SP year whose type is hidden in the leakage test (default %(default)s)")


def run(args):
    params = Params(args.merge_km, args.radius_km, args.source_days, args.min_source_days,
                    args.bucket_deg, args.min_days, args.window_days)
    con = db.connect()
    try:
        sources, masked, report = build(con, config.load_config(), params, args.test_year)
        write(con, sources, masked, report)
    finally:
        con.close()
    print(f"static_sources: {len(sources):,} locations; static_mask: {len(masked):,} NRT rows\n")
    print_report(report)
    return 0
