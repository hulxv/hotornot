"""Series assembly: `series` roles, `ratio_factors`, `ratio_v1` weights and `months` flags.

A row's vegetation test comes first (`non_vegetation`, then `static_masked` for NRT rows in
`static_mask`), then its satellite and date pick the role. NOAA-20 fills the region-days where
`coverage_daily` lists 0 S-NPP granules, from N20_START or the region's first day of NOAA-20
data if later, up to the day before VIIRS_SWITCH.

A satellite observed a region-day when `coverage_daily` lists granules for it. Where the count
is NULL (unknown) or there is no row, it observed the day if it has any hotspot row in the
region that day. The S-NPP ratio counts MODIS and S-NPP only on days S-NPP observed, and the
NOAA-20 ratio only on days both VIIRS satellites observed, so outages do not bias them.

`series` and `weights` are rewritten one hotspot_id range at a time, each in one short
transaction, so both stay complete while the step runs and a rerun leaves no stale rows.
"""
import calendar
import time
from collections import Counter, defaultdict
from datetime import date, timedelta

from hotornot import config, db
from hotornot.steps.matchups import HotspotsNotReady, check_hotspots, hotspots_version
from hotornot.steps.normalize import _wait_for_checkpoint

NAME = "series"
HELP = "Assign series roles, fit ratio_v1 factors and weights, flag months; print the annual table."

METHOD = "ratio_v1"
MIN_POOL_COUNT = 50
ROLES = ("modis", "snpp", "n20_gapfill", "n20",
         "modis_overlap", "n20_overlap", "non_vegetation", "static_masked")
ROLE_INDEX = {role: i for i, role in enumerate(ROLES)}
IN_SERIES = frozenset(ROLES[:4])
VEGETATION = frozenset(ROLES[:6])
MODIS_ROLES = frozenset({"modis", "modis_overlap"})
WEIGHTED = {"snpp": "S-NPP", "n20_gapfill": "NOAA-20", "n20_overlap": "NOAA-20", "n20": "NOAA-20"}
SATELLITES = ("Terra", "Aqua", "S-NPP", "NOAA-20")
MODIS = ("Terra", "Aqua")
SOURCE_NAMES = (("S-NPP", "SNPP"), ("NOAA-20", "N20"))
CHECK_TOLERANCE = 0.05

VIIRS_FROM = config.VIIRS_SERIES_START.isoformat()
SWITCH = config.VIIRS_SWITCH.isoformat()
AQUA_YM = config.AQUA_START.year * 100 + config.AQUA_START.month

# A staged row is its 8-byte hotspot_id followed by one byte each for role, region and month.
RECORD = 11

SERIES_COLUMNS = ["hotspot_id", "in_series", "role"]
SERIES_DDL = """
CREATE TABLE series (
    hotspot_id TEXT PRIMARY KEY,
    in_series  INTEGER NOT NULL,
    role       TEXT NOT NULL
) WITHOUT ROWID;
"""
WEIGHTS_COLUMNS = ["hotspot_id", "method", "weight"]
WEIGHTS_DDL = """
CREATE TABLE IF NOT EXISTS weights (
    hotspot_id TEXT NOT NULL,
    method     TEXT NOT NULL,
    weight     REAL NOT NULL,
    PRIMARY KEY (hotspot_id, method)
) WITHOUT ROWID;
"""
SMALL_DDL = """
CREATE TABLE ratio_factors (
    region_id TEXT NOT NULL,
    month     INTEGER NOT NULL,
    satellite TEXT NOT NULL,
    factor    REAL NOT NULL,
    level     TEXT NOT NULL,
    PRIMARY KEY (region_id, month, satellite)
);
CREATE TABLE months (
    region_id          TEXT NOT NULL,
    ym                 INTEGER NOT NULL,
    terra_only         INTEGER NOT NULL,
    viirs_source       TEXT,
    viirs_missing_days INTEGER NOT NULL,
    provisional        INTEGER NOT NULL,
    days_covered       INTEGER NOT NULL,
    PRIMARY KEY (region_id, ym)
);
"""

SELECT_SQL = """
SELECT hotspot_id, acq_date, in_box, fire_type, processing FROM hotspots
WHERE region_id = ? AND satellite = ? AND acq_date >= ? AND acq_date < ?"""


def role_of(satellite, acq_date, fire_type, masked, gapfill_days):
    """The `series.role` of one row. `masked`: its id is in `static_mask`; `gapfill_days`: the
    region's ISO dates on which NOAA-20 replaces S-NPP."""
    if fire_type is None:
        if masked:
            return "static_masked"
    elif fire_type != 0:
        return "non_vegetation"
    if satellite in MODIS:
        return "modis" if acq_date < VIIRS_FROM else "modis_overlap"
    if satellite == "S-NPP":
        if acq_date >= SWITCH:
            raise ValueError(f"S-NPP row on {acq_date}: CONTRACTS has no role for S-NPP"
                             f" from {SWITCH}")
        return "snpp"
    if satellite == "NOAA-20":
        if acq_date >= SWITCH:
            return "n20"
        return "n20_gapfill" if acq_date in gapfill_days else "n20_overlap"
    raise ValueError(f"unknown satellite {satellite!r}")


def pool(num, den, basis, min_count=MIN_POOL_COUNT):
    """{month: (num / den, level)} for calendar months 1 to 12; arguments map month to a count.

    A month whose `basis` is under `min_count`, or whose `den` is 0, is pooled with its two
    neighbours (December next to January); if those are still under `min_count`, the whole year
    is used. P08 and P09 reuse this rule.
    """
    out = {}
    for m in range(1, 13):
        groups = (("region_month", (m,)),
                  ("pooled_3month", ((m - 2) % 12 + 1, m, m % 12 + 1)),
                  ("region_year", range(1, 13)))
        for level, months in groups:
            d = sum(den.get(k, 0) for k in months)
            if d > 0 and (level == "region_year"
                          or sum(basis.get(k, 0) for k in months) >= min_count):
                out[m] = (sum(num.get(k, 0) for k in months) / d, level)
                break
        else:
            raise ValueError("nothing to divide by in any month")
    return out


class Coverage:
    """Which satellite observed which region-day."""

    def __init__(self, granules, row_days):
        self.granules = granules
        self.row_days = row_days

    def observed(self, region_id, satellite, day):
        g = self.granules.get((region_id, satellite), {}).get(day)
        if g is None:
            return day in self.row_days.get((region_id, satellite), ())
        return g > 0


def n20_data_start(region, cfg):
    """First ISO day with NOAA-20 data for the region (P03 downloads), never before N20_START."""
    if region["history"] == "api":
        first = date.fromisoformat(cfg["firms_api"]["NOAA-20"]["start"])
    else:
        first = date(cfg["firms_country"]["viirs-jpss1"][0], 1, 1)
    return max(first, config.N20_START).isoformat()


def gapfill_days(granules, region, cfg):
    first = n20_data_start(region, cfg)
    return {d for d, g in granules.get((region["id"], "S-NPP"), {}).items()
            if g == 0 and first <= d < SWITCH}


def days_between(first, last):
    """ISO dates from `first` to `last` inclusive."""
    d, end = date.fromisoformat(first), date.fromisoformat(last)
    while d <= end:
        yield d.isoformat()
        d += timedelta(days=1)


def month_starts(first, last):
    """(year, month, first day, first day of the next month) for each month from the month of
    ISO date `first` to that of `last`."""
    y, m = int(first[:4]), int(first[5:7])
    while (y, m) <= (int(last[:4]), int(last[5:7])):
        ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
        yield y, m, f"{y:04d}-{m:02d}-01", f"{ny:04d}-{nm:02d}-01"
        y, m = ny, nm


def read_inputs(con):
    granules = defaultdict(dict)
    for region_id, day, satellite, g in con.execute(
            "SELECT region_id, date, satellite, granules FROM coverage_daily"):
        granules[(region_id, satellite)][day] = g
    masked = {h for (h,) in con.execute("SELECT hotspot_id FROM static_mask")}
    return dict(granules), masked


def assign(con, regions, fill, masked, log):
    """Give every hotspot of `regions` its role. Returns the rows staged in 256 buckets by the
    first byte of their id, and row counts by (region_id, satellite, acq_date, role, in_box,
    processing)."""
    buckets = [bytearray() for _ in range(256)]
    counts = Counter()
    started = time.monotonic()
    for ri, region in enumerate(regions):
        rid = region["id"]
        spans = {}
        for satellite in SATELLITES:
            lo, hi = con.execute(
                "SELECT MIN(acq_date), MAX(acq_date) FROM hotspots"
                " WHERE region_id = ? AND satellite = ?", (rid, satellite)).fetchone()
            if lo is not None:
                spans[satellite] = (lo, hi)
        if not spans:
            continue
        first = min(s[0] for s in spans.values())
        last = max(s[1] for s in spans.values())
        rows_read = 0
        # Month by month, then satellite: normalize stored Terra and Aqua of a month together.
        for _, month, start, end in month_starts(first, last):
            tags = {role: bytes((i, ri, month)) for role, i in ROLE_INDEX.items()}
            for satellite, (lo, hi) in spans.items():
                if hi < start or lo >= end:
                    continue
                rows = con.execute(SELECT_SQL, (rid, satellite, start, end)).fetchall()
                rows_read += len(rows)
                chunk = Counter()
                for hid, day, in_box, fire_type, processing in rows:
                    raw = bytes.fromhex(hid)
                    if len(raw) != 8 or raw.hex() != hid:
                        raise ValueError(f"hotspot_id {hid!r} is not 16 lowercase hex digits")
                    role = role_of(satellite, day, fire_type, hid in masked, fill[rid])
                    chunk[day, role, in_box, processing] += 1
                    buckets[raw[0]] += raw + tags[role]
                for key, n in chunk.items():
                    counts[(rid, satellite, *key)] += n
        log(f"{rid}: {rows_read:,} rows, {time.monotonic() - started:.0f} s")
    return buckets, counts


def daily_counts(counts):
    """({(region, satellite): {day: in-box vegetation rows}}, {(region, satellite): days with
    any row})."""
    veg, row_days = defaultdict(Counter), defaultdict(set)
    for (rid, satellite, day, role, in_box, _), n in counts.items():
        row_days[rid, satellite].add(day)
        if in_box and role in VEGETATION:
            veg[rid, satellite][day] += n
    return veg, row_days


def fit_factors(region, cfg, veg, coverage, satellites, years=None):
    """({(month, satellite): (factor, level)}, calibration counts) for the VIIRS `satellites`
    that have rows to weight in the region. `years` limits the S-NPP calibration to those
    calibration years (P09's refits); the NOAA-20 transfer always uses N20_TRANSFER."""
    rid = region["id"]
    factors, calib = {}, {}
    if not satellites:
        return factors, calib
    modis, snpp = Counter(), Counter()
    cal = [d.isoformat() for d in config.CALIBRATION]
    days = 0
    for day in days_between(*cal):
        if (years is None or int(day[:4]) in years) and coverage.observed(rid, "S-NPP", day):
            m = int(day[5:7])
            days += 1
            modis[m] += veg[rid, "Terra"][day] + veg[rid, "Aqua"][day]
            snpp[m] += veg[rid, "S-NPP"][day]
    try:
        r_snpp = pool(modis, snpp, modis)
    except ValueError:
        raise ValueError(f"{rid}: no S-NPP vegetation rows on observed days"
                         f" {cal[0]}..{cal[1]}") from None
    calib["S-NPP"] = {"first": cal[0], "last": cal[1], "days": days,
                      "modis": _by_month(modis), "snpp": _by_month(snpp)}
    if "S-NPP" in satellites:
        for m, value in r_snpp.items():
            factors[m, "S-NPP"] = value

    if "NOAA-20" in satellites:
        first = max(config.N20_TRANSFER[0].isoformat(), n20_data_start(region, cfg))
        last = config.N20_TRANSFER[1].isoformat()
        snpp2, n20 = Counter(), Counter()
        days = 0
        for day in days_between(first, last):
            if coverage.observed(rid, "S-NPP", day) and coverage.observed(rid, "NOAA-20", day):
                m = int(day[5:7])
                days += 1
                snpp2[m] += veg[rid, "S-NPP"][day]
                n20[m] += veg[rid, "NOAA-20"][day]
        try:
            transfer = pool(snpp2, n20, snpp2)
        except ValueError:
            raise ValueError(f"{rid}: no NOAA-20 vegetation rows on days both VIIRS satellites"
                             f" observed, {first}..{last}") from None
        for m, (ratio, level) in transfer.items():
            factors[m, "NOAA-20"] = (r_snpp[m][0] * ratio, level)
        calib["NOAA-20"] = {"first": first, "last": last, "days": days,
                            "snpp": _by_month(snpp2), "n20": _by_month(n20)}
    return factors, calib


def _by_month(counter):
    return [counter[m] for m in range(1, 13)]


def region_dates(counts):
    """{region: {"sp_until", "nrt_until"}}: the last SP day and last day of any series row."""
    dates = defaultdict(lambda: {"sp_until": None, "nrt_until": None})
    for (rid, _, day, role, _, processing) in counts:
        if role not in IN_SERIES:
            continue
        d = dates[rid]
        d["nrt_until"] = max(d["nrt_until"] or day, day)
        if processing == "SP":
            d["sp_until"] = max(d["sp_until"] or day, day)
    return dict(dates)


def month_rows(rid, nrt_until, coverage, fill, provisional):
    """`months` rows for one region from RECORD_START to the month of `nrt_until`."""
    rows = []
    for year, month, start, _ in month_starts(config.RECORD_START.isoformat(), nrt_until):
        ym = year * 100 + month
        days = (int(nrt_until[8:]) if start[:7] == nrt_until[:7]
                else calendar.monthrange(year, month)[1])
        sources, missing = set(), 0
        if start >= VIIRS_FROM:
            for day in days_between(start, f"{start[:8]}{days:02d}"):
                satellite = "NOAA-20" if day >= SWITCH or day in fill else "S-NPP"
                sources.add(satellite)
                missing += not coverage.observed(rid, satellite, day)
        source = "+".join(name for s, name in SOURCE_NAMES if s in sources) or None
        rows.append((rid, ym, int(ym < AQUA_YM), source, missing, int((rid, ym) in provisional),
                     days))
    return rows


def build(con, cfg, log=print):
    """Everything the step writes: the staged rows and weights by tag, plus the small tables
    and artifacts."""
    started = time.monotonic()
    version = hotspots_version(con)
    regions = cfg["regions"]
    granules, masked = read_inputs(con)
    fill = {r["id"]: gapfill_days(granules, r, cfg) for r in regions}
    buckets, counts = assign(con, regions, fill, masked, log)
    check_hotspots(con, version)
    total = con.execute("SELECT COUNT(*) FROM hotspots").fetchone()[0]
    staged = sum(counts.values())
    if staged != total:
        raise ValueError(f"{total - staged:,} hotspots belong to regions missing from the config")

    veg, row_days = daily_counts(counts)
    coverage = Coverage(granules, row_days)
    weighted = defaultdict(set)
    for (rid, satellite, _, role, _, _) in counts:
        if role in WEIGHTED:
            weighted[rid].add(satellite)
    factors, calibration = {}, {}
    for region in regions:
        f, calibration[region["id"]] = fit_factors(region, cfg, veg, coverage,
                                                   weighted[region["id"]])
        factors.update({(region["id"], m, s): v for (m, s), v in f.items()})

    weight_by_tag = {}
    for ri, region in enumerate(regions):
        for role, satellite in WEIGHTED.items():
            for m in range(1, 13):
                value = factors.get((region["id"], m, satellite))
                if value is not None:
                    weight_by_tag[bytes((ROLE_INDEX[role], ri, m))] = value[0]

    dates = region_dates(counts)
    provisional = {(rid, int(day[:4] + day[5:7]))
                   for (rid, _, day, role, in_box, processing) in counts
                   if in_box and processing == "NRT" and role in IN_SERIES}
    months = []
    for region in regions:
        nrt_until = dates.get(region["id"], {}).get("nrt_until")
        if nrt_until:
            months += month_rows(region["id"], nrt_until, coverage, fill[region["id"]], provisional)

    ratio_rows = [(rid, m, s, v[0], v[1]) for (rid, m, s), v in sorted(factors.items())]
    report = make_report(cfg, counts, factors, calibration, dates, fill, months, total)
    report["inputs"] = input_versions(con)
    report["seconds_to_assign"] = round(time.monotonic() - started, 1)
    return {"version": version, "buckets": buckets, "weight_by_tag": weight_by_tag,
            "ratio_factors": ratio_rows, "months": months, "dates": dates, "report": report}


def input_versions(con):
    """When each input step last wrote its report; a stale input is named in `stale`."""
    names = ("normalize", "static_mask", "coverage")
    created = dict(con.execute(
        f"SELECT name, created_at FROM artifacts WHERE name IN ({', '.join('?' * len(names))})",
        [f"{n}:report" for n in names]))
    out = {n: created.get(f"{n}:report") for n in names}
    base = out["normalize"]
    out["stale"] = [n for n in names[1:] if base and (out[n] is None or out[n] < base)]
    return out


def _empty_year():
    return {"modis": 0, "viirs_raw": 0, "harmonized": 0.0, "n20_gapfill": 0}


def make_report(cfg, counts, factors, calibration, dates, fill, months, total):
    roles = defaultdict(lambda: defaultdict(Counter))
    annual = defaultdict(lambda: defaultdict(_empty_year))
    for (rid, satellite, day, role, in_box, _), n in counts.items():
        roles[rid][satellite][role] += n
        if not in_box:
            continue
        a = annual[rid][int(day[:4])]
        if role in MODIS_ROLES:
            a["modis"] += n
        if role not in IN_SERIES:
            continue
        if satellite in MODIS:
            a["harmonized"] += n
        else:
            a["viirs_raw"] += n
            a["harmonized"] += n * factors[rid, int(day[5:7]), WEIGHTED[role]][0]
            if role == "n20_gapfill":
                a["n20_gapfill"] += n

    first_viirs = config.VIIRS_SERIES_START.year
    cal_years = range(config.CALIBRATION[0].year, config.CALIBRATION[1].year + 1)
    table, modis_era_equal, cal_checks, cal_totals = {}, True, [], {}
    for region in cfg["regions"]:
        rid = region["id"]
        years = annual.get(rid, {})
        rows = []
        first_year = config.RECORD_START.year
        for year in range(first_year, max(years, default=first_year) + 1):
            a = years.get(year) or _empty_year()
            rows.append({"year": year, **a, "harmonized": round(a["harmonized"], 3),
                         "error": _error(a["harmonized"], a["modis"])})
            if year < first_viirs and a["harmonized"] != a["modis"]:
                modis_era_equal = False
            if year in cal_years:
                err = _error(a["harmonized"], a["modis"])
                cal_checks.append({"region_id": rid, "year": year, "error": err,
                                   "ok": err is not None and abs(err) <= CHECK_TOLERANCE})
        table[rid] = rows
        h = sum(years.get(y, {}).get("harmonized", 0.0) for y in cal_years)
        m = sum(years.get(y, {}).get("modis", 0) for y in cal_years)
        cal_totals[rid] = _error(h, m)

    in_series = sum(n for k, n in counts.items() if k[3] in IN_SERIES)
    return {
        "method": METHOD,
        "min_pool_count": MIN_POOL_COUNT,
        "rows": total,
        "in_series": in_series,
        "weights": sum(n for k, n in counts.items() if k[3] in WEIGHTED),
        "roles": {rid: {s: dict(c) for s, c in sats.items()} for rid, sats in roles.items()},
        "gapfill_days": {rid: len(days) for rid, days in fill.items()},
        "dates": dates,
        "factors": [{"region_id": rid, "month": m, "satellite": s, "factor": v[0], "level": v[1]}
                    for (rid, m, s), v in sorted(factors.items())],
        "calibration": calibration,
        "months_partial": {r["id"]: sum(1 for row in months if row[0] == r["id"]
                                        and (row[2] or row[4]))
                           for r in cfg["regions"]},
        "annual": table,
        "checks": {
            "modis_era_equal": modis_era_equal,
            "tolerance": CHECK_TOLERANCE,
            "calibration_years": cal_checks,
            "calibration_totals": cal_totals,
        },
    }


def _error(harmonized, modis):
    return (harmonized - modis) / modis if modis else None


def id_range(bucket):
    """SQL condition and parameters for the hotspot_id range of `bucket`; the 256 ranges tile
    every possible id, so a rewrite also clears ids that no longer exist."""
    conds, params = [], []
    if bucket > 0:
        conds.append("hotspot_id >= ?")
        params.append(f"{bucket:02x}")
    if bucket < 255:
        conds.append("hotspot_id < ?")
        params.append(f"{bucket + 1:02x}")
    return " AND ".join(conds), params


def ensure_tables(con):
    with con:
        if [r[1] for r in con.execute("PRAGMA table_info(series)")] != SERIES_COLUMNS:
            db.recreate(con, SERIES_DDL)
        columns = [r[1] for r in con.execute("PRAGMA table_info(weights)")]
        if not columns:
            con.execute(WEIGHTS_DDL)
        elif columns != WEIGHTS_COLUMNS:
            raise RuntimeError(f"weights has columns {columns}, expected {WEIGHTS_COLUMNS}")


def write(con, built, log=print):
    """Rewrite `series` and the `ratio_v1` weights range by range, then the small tables and
    artifacts in one last transaction. Returns (series rows, weight rows, longest write s)."""
    ensure_tables(con)
    in_series = [int(role in IN_SERIES) for role in ROLES]
    buckets, weight_by_tag = built["buckets"], built["weight_by_tag"]
    n_series = n_weights = 0
    longest = 0.0
    for b in range(256):
        data = bytes(buckets[b])
        buckets[b] = None
        series_rows, weight_rows = [], []
        for rec in sorted(data[i:i + RECORD] for i in range(0, len(data), RECORD)):
            hid = rec[:8].hex()
            series_rows.append((hid, in_series[rec[8]], ROLES[rec[8]]))
            w = weight_by_tag.get(rec[8:])
            if w is not None:
                weight_rows.append((hid, METHOD, w))
        where, params = id_range(b)
        _wait_for_checkpoint(con, log)
        check_hotspots(con, built["version"])
        t0 = time.monotonic()
        with con:
            con.execute(f"DELETE FROM series WHERE {where}", params)
            con.executemany("INSERT INTO series VALUES (?, ?, ?)", series_rows)
            con.execute(f"DELETE FROM weights WHERE method = ? AND {where}", [METHOD, *params])
            con.executemany("INSERT INTO weights VALUES (?, ?, ?)", weight_rows)
        longest = max(longest, time.monotonic() - t0)
        n_series += len(series_rows)
        n_weights += len(weight_rows)
    check_hotspots(con, built["version"])
    with con:
        db.recreate(con, SMALL_DDL)
        con.executemany("INSERT INTO ratio_factors VALUES (?, ?, ?, ?, ?)", built["ratio_factors"])
        con.executemany("INSERT INTO months VALUES (?, ?, ?, ?, ?, ?, ?)", built["months"])
        db.put_artifact("series:dates", built["dates"], con)
        db.put_artifact("series:report", built["report"], con)
    return n_series, n_weights, longest


LEVEL_CODES = {"region_month": "m", "pooled_3month": "p", "region_year": "y"}


def _pct(x):
    return "-" if x is None else f"{x:+.1%}"


def print_report(report):
    print(f"series: {report['rows']:,} hotspots, {report['in_series']:,} in series;"
          f" {report['weights']:,} {report['method']} weights on VIIRS vegetation rows")
    if report["inputs"]["stale"]:
        print(f"WARNING: {', '.join(report['inputs']['stale'])} ran before the last normalize;"
              " rerun them, then this step")

    widths = {r: max(len(r), 9) for r in ROLES}
    print(f"\nroles, all rows (in box and buffer)\n{'region':<13} {'satellite':<9}"
          + "".join(f" {r:>{widths[r]}}" for r in ROLES))
    for rid, sats in report["roles"].items():
        for satellite in SATELLITES:
            if satellite in sats:
                print(f"{rid:<13} {satellite:<9}" + "".join(
                    f" {sats[satellite].get(r, 0):>{widths[r]},}" for r in ROLES))

    print("\nratio_v1 factors (MODIS-equivalent weight per VIIRS hotspot); level"
          " m = region_month, p = pooled_3month, y = region_year")
    print(f"{'region':<13} {'satellite':<9}" + "".join(f" {calendar.month_abbr[m]:>7}"
                                                        for m in range(1, 13)))
    by_key = defaultdict(dict)
    for f in report["factors"]:
        by_key[f["region_id"], f["satellite"]][f["month"]] = f
    for (rid, satellite), months in by_key.items():
        cells = "".join(f" {months[m]['factor']:>6.3f}{LEVEL_CODES[months[m]['level']]}"
                        for m in range(1, 13))
        print(f"{rid:<13} {satellite:<9}{cells}")

    for rid, rows in report["annual"].items():
        d = report["dates"].get(rid, {})
        print(f"\n{rid}: sp_until {d.get('sp_until')}, nrt_until {d.get('nrt_until')};"
              f" {report['gapfill_days'].get(rid, 0)} gap-fill days;"
              f" {report['months_partial'].get(rid, 0)} partial months")
        print(f"{'year':<6} {'MODIS':>9} {'VIIRS raw':>10} {'harmonized':>12} {'n20 fill':>9}"
              f" {'vs MODIS':>9}")
        for row in rows:
            print(f"{row['year']:<6} {row['modis']:>9,} {row['viirs_raw']:>10,}"
                  f" {row['harmonized']:>12,.1f} {row['n20_gapfill']:>9,} {_pct(row['error']):>9}")

    checks = report["checks"]
    cal = checks["calibration_years"]
    bad = [c for c in cal if not c["ok"]]
    print(f"\n2000-{config.VIIRS_SERIES_START.year - 1}: harmonized equals MODIS in every"
          f" region and year: {'yes' if checks['modis_era_equal'] else 'NO'}")
    span = f"{config.CALIBRATION[0].year}-{config.CALIBRATION[1].year}"
    print(f"{span} totals, harmonized against MODIS: " + ", ".join(
        f"{rid} {_pct(e)}" for rid, e in checks["calibration_totals"].items()))
    print(f"{span} single years within {checks['tolerance']:.0%} of MODIS:"
          f" {len(cal) - len(bad)} of {len(cal)} region-years; outside: "
          + (", ".join(f"{c['region_id']} {c['year']} {_pct(c['error'])}" for c in bad) or "none"))


def add_arguments(parser):
    pass


def run(args):
    con = db.connect()
    try:
        built = build(con, config.load_config())
        n_series, n_weights, longest = write(con, built)
    except HotspotsNotReady:
        print("series: hotspots is being rebuilt, or was rebuilt while this step ran;"
              " rerun series after normalize finishes")
        return 1
    finally:
        con.close()
    print(f"wrote {n_series:,} series rows and {n_weights:,} weights in 256 transactions,"
          f" longest {longest:.2f} s\n")
    print_report(built["report"])
    return 0
