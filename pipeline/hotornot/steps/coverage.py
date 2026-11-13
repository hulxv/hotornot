"""Daily satellite coverage per region from the CMR granule listings: `coverage_daily`.

A granule counts for a region when its footprint (great-circle edges) touches the region's
exact bbox, on the UTC date of its `time_start`. A day with no counted granule gets 0 (the
satellite did not observe the region) only when the listing can vouch for that day; otherwise
`granules` is NULL (unknown), for one of these reasons:

- `after_listing`: past the last fully listed day of the product (CMR lists NOAA-20 days late),
- `slice_incomplete`: the region-year's CMR request did not finish,
- `firms_detections`: FIRMS has rows from that satellite that day, either inside the region's
  bbox, or anywhere while no region has a listed granule that day. The CMR product has a gap
  there, not the satellite.
"""
import textwrap
from collections import Counter
from datetime import UTC, date, datetime, timedelta

from hotornot import config, db, geo

NAME = "coverage"
HELP = "Count CMR granules over each region by UTC day and satellite into coverage_daily."

PRODUCTS = {"MYD14": "Aqua", "VNP14IMG": "S-NPP", "VJ114IMG": "NOAA-20"}
REASONS = ("after_listing", "slice_incomplete", "firms_detections")

# FIRMS acq_time is the scan time, so a row stamped just after midnight can belong to a
# granule that started (and is counted) the day before; MODIS and VIIRS granules last 5 and 6
# minutes.
FIRST_OWN_TIME = "0010"

# Inclusive windows from the NASA Earthdata and LAADS S-NPP outage alerts.
SNPP_OUTAGES_2026 = (
    (date(2026, 4, 29), date(2026, 5, 8)),
    (date(2026, 6, 1), date(2026, 6, 10)),
    (date(2026, 7, 10), date(2026, 7, 17)),
    (date(2026, 8, 2), date(2026, 8, 10)),
)

DDL = """
CREATE TABLE coverage_daily (
    region_id TEXT NOT NULL,
    date      TEXT NOT NULL,
    satellite TEXT NOT NULL,
    granules  INTEGER,  -- NULL: unknown, the CMR listing cannot vouch for this day; 0: no look
    PRIMARY KEY (region_id, date, satellite)
) WITHOUT ROWID"""

DAY = timedelta(days=1)


def periods(until):
    """{satellite: (first_day, last_day)} of the rows written."""
    return {
        "Aqua": config.CALIBRATION,
        "S-NPP": (config.SNPP_START, config.VIIRS_SWITCH - DAY),
        "NOAA-20": (config.N20_START, until),
    }


def listings(con, cfg):
    """{short_name: (first_day, complete_through, last_time_start)} of each CMR listing."""
    last = dict(con.execute("SELECT short_name, MAX(time_start) FROM cmr_granules GROUP BY 1"))
    out = {}
    for product in cfg["cmr"]:
        name = product["short_name"]
        first = date.fromisoformat(product["start"])
        end = date.fromisoformat(product["end"]) if product["end"] else None
        last_time = last.get(name)
        if last_time is None:
            out[name] = (first, first - DAY, None)
            continue
        last_day = date.fromisoformat(last_time[:10])
        # A closed request window listed through its end is complete. Otherwise CMR may still
        # add granules on the last listed day, so only the days before it are complete.
        through = end if end is not None and last_day >= end else last_day - DAY
        out[name] = (first, through, last_time)
    return out


def complete_slices(con):
    return {(s, r, y) for s, r, y in con.execute(
        "SELECT short_name, region_id, year FROM cmr_slices WHERE done = 1 AND stored >= hits")}


def count_granules(con, regions, spans):
    """Granules touching each exact bbox by (region_id, day, satellite); per (region_id,
    satellite) the listed granules that miss the exact bbox and those without a footprint; and
    the (day, satellite) pairs with any granule listed for any region."""
    bboxes = {r["id"]: r["bbox"] for r in regions}
    counts, missed, no_footprint, listed = Counter(), Counter(), Counter(), set()
    for short_name, satellite in PRODUCTS.items():
        first, last = spans[satellite]
        rows = con.execute(
            "SELECT region_id, time_start, footprint FROM cmr_granules "
            "WHERE short_name = ? AND time_start >= ? AND time_start < ?",
            (short_name, first.isoformat(), (last + DAY).isoformat())).fetchall()
        for region_id, time_start, footprint in rows:
            if region_id not in bboxes:
                continue
            day = time_start[:10]
            listed.add((day, satellite))
            if footprint is None:
                # CMR matched it to the buffered box without a shape. Counting it is the safer
                # error: a false 0 would trigger NOAA-20 gap fill on an observed day.
                no_footprint[region_id, satellite] += 1
                counts[region_id, day, satellite] += 1
            elif geo.polygon_intersects_bbox(geo.footprint_rings(footprint), bboxes[region_id]):
                counts[region_id, day, satellite] += 1
            else:
                missed[region_id, satellite] += 1
    return counts, missed, no_footprint, listed


def firms_days(con, first, last):
    """{(region_id, day, satellite): 1 when a FIRMS row lies in the exact bbox, else 0}."""
    return {(r, d, s): in_box for r, d, s, in_box in con.execute(
        "SELECT region_id, acq_date, satellite, MAX(in_box) FROM raw_hotspots "
        "WHERE satellite IN (?, ?, ?) AND acq_date BETWEEN ? AND ? AND acq_time >= ? "
        "GROUP BY 1, 2, 3",
        (*PRODUCTS.values(), first.isoformat(), last.isoformat(), FIRST_OWN_TIME))}


def ranges(days):
    """Sorted ISO dates merged into [first, last] runs of consecutive days."""
    out = []
    for text in days:
        day = date.fromisoformat(text)
        if out and date.fromisoformat(out[-1][1]) + DAY == day:
            out[-1][1] = text
        else:
            out.append([text, text])
    return out


def build(con, cfg, until):
    """(coverage_daily rows, coverage:report) without writing anything."""
    regions = cfg["regions"]
    spans = periods(until)
    listed_span = listings(con, cfg)
    slices = complete_slices(con)
    counts, missed, no_footprint, listed = count_granules(con, regions, spans)
    firms = firms_days(con, min(s[0] for s in spans.values()), max(s[1] for s in spans.values()))
    active = {(d, s) for _, d, s in firms}

    rows, series = [], []
    for region in regions:
        rid = region["id"]
        for short_name, satellite in PRODUCTS.items():
            first, last = spans[satellite]
            listed_from, listed_through, _ = listed_span.get(short_name, (date.max, date.min, None))
            zero, unknown, reasons = [], [], Counter()
            granules = covered = firms_total = firms_no_granule = 0
            day = first
            while day <= last:
                text = day.isoformat()
                n = counts[rid, text, satellite]
                seen = firms.get((rid, text, satellite)) == 1
                firms_total += seen
                firms_no_granule += seen and not n
                reason = None
                if n:
                    granules += n
                    covered += 1
                elif not listed_from <= day <= listed_through:
                    reason = "after_listing"
                elif (short_name, rid, day.year) not in slices:
                    reason = "slice_incomplete"
                elif seen or ((text, satellite) in active and (text, satellite) not in listed):
                    reason = "firms_detections"
                if reason:
                    reasons[reason] += 1
                    unknown.append(text)
                elif not n:
                    zero.append(text)
                rows.append((rid, text, satellite, None if reason else n))
                day += DAY
            series.append({
                "region_id": rid, "satellite": satellite,
                "first_day": first.isoformat(), "last_day": last.isoformat(),
                "days": max(0, (last - first).days + 1), "covered_days": covered,
                "zero_days": len(zero), "unknown_days": len(unknown),
                "unknown_reasons": {r: reasons[r] for r in REASONS},
                "granules": granules,
                "granules_missing_bbox": missed[rid, satellite],
                "granules_without_footprint": no_footprint[rid, satellite],
                "firms_days": firms_total, "firms_days_without_granule": firms_no_granule,
                "zero_ranges": ranges(zero), "unknown_ranges": ranges(unknown),
            })

    by_key = {(rid, text, sat): n for rid, text, sat, n in rows if sat == "S-NPP"}
    outages = []
    for start, end in SNPP_OUTAGES_2026:
        window = [(start + i * DAY).isoformat() for i in range((end - start).days + 1)]
        outages.append({
            "start": start.isoformat(), "end": end.isoformat(), "days": len(window),
            "zero_days": {r["id"]: sum(by_key[r["id"], d, "S-NPP"] == 0 for d in window)
                          for r in regions},
            "unknown_days": {r["id"]: sum(by_key[r["id"], d, "S-NPP"] is None for d in window)
                             for r in regions},
        })

    report = {
        "until": until.isoformat(),
        "rows": len(rows),
        "listings": [{
            "satellite": satellite, "short_name": short_name,
            "first_day": spans[satellite][0].isoformat(),
            "last_day": spans[satellite][1].isoformat(),
            "complete_through": (listed_span[short_name][1].isoformat()
                                 if short_name in listed_span else None),
            "last_granule": listed_span[short_name][2] if short_name in listed_span else None,
        } for short_name, satellite in PRODUCTS.items()],
        "series": series,
        "snpp_outages_2026": outages,
    }
    return rows, report


def print_report(report):
    print(f"coverage_daily: {report['rows']:,} rows, NOAA-20 through {report['until']}")
    print("granules NULL = unknown: the listing cannot vouch for the day; 0 = did not observe")
    print("\nCMR listings")
    for x in report["listings"]:
        print(f"  {x['satellite']:<8} {x['short_name']:<9} rows {x['first_day']}..{x['last_day']}"
              f"  complete through {x['complete_through']}  last granule {x['last_granule']}")

    def runs(label, spans):
        text = ", ".join(a if a == b else f"{a}..{b}" for a, b in spans)
        print(textwrap.fill(text, width=100, initial_indent=f"      {label}: ",
                            subsequent_indent=" " * (8 + len(label))))

    region_ids = list(dict.fromkeys(s["region_id"] for s in report["series"]))
    for rid in region_ids:
        print(f"\n{rid}")
        for s in report["series"]:
            if s["region_id"] != rid:
                continue
            reasons = ", ".join(f"{k} {v}" for k, v in s["unknown_reasons"].items() if v)
            print(f"  {s['satellite']:<8} {s['first_day']}..{s['last_day']}  days {s['days']:,}"
                  f"  covered {s['covered_days']:,}  zero {s['zero_days']:,}"
                  f"  unknown {s['unknown_days']:,}{f' ({reasons})' if reasons else ''}")
            print(f"           granules {s['granules']:,}, listed but missing the exact bbox"
                  f" {s['granules_missing_bbox']:,}, without footprint"
                  f" {s['granules_without_footprint']:,}; FIRMS days in bbox {s['firms_days']:,},"
                  f" of them without a granule {s['firms_days_without_granule']:,}")
            if s["zero_ranges"]:
                runs("zero", s["zero_ranges"])
            if s["unknown_ranges"]:
                runs("unknown", s["unknown_ranges"])

    print("\nS-NPP days inside the NASA-announced 2026 outages: zero / unknown / window length")
    print("  " + f"{'outage':<24}" + "".join(f"{rid:>14}" for rid in region_ids))
    for o in report["snpp_outages_2026"]:
        cells = "".join(f"{o['zero_days'][rid]:>6} /{o['unknown_days'][rid]:>2} /{o['days']:>2}"
                        for rid in region_ids)
        print(f"  {o['start']}..{o['end']}  {cells}")


def add_arguments(parser):
    parser.add_argument("--until", type=date.fromisoformat, metavar="YYYY-MM-DD",
                        help="last NOAA-20 day written (default: today, UTC)")


def run(args):
    until = args.until or datetime.now(UTC).date()
    cfg = config.load_config()
    con = db.connect()
    try:
        rows, report = build(con, cfg, until)
        with con:
            db.recreate(con, DDL)
            con.executemany("INSERT INTO coverage_daily VALUES (?, ?, ?, ?)", rows)
            db.put_artifact("coverage:report", report, con)
    finally:
        con.close()
    print_report(report)
    return 0
