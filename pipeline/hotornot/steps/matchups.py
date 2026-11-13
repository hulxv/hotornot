"""Aqua MODIS against S-NPP matchups in the calibration years: the `matchups` table for P08.

Candidates are S-NPP SP vegetation hotspots (fire_type 0) inside a region's exact bbox. A
candidate is covered when a MYD14 granule footprint (great-circle edges) contains it and the
granule's [time_start, time_end] comes within `window` minutes of the VIIRS acquisition time.
Uncovered candidates get no row. Each Aqua vegetation hotspot of the covering overpass whose
pixel, grown by `tol`, contains m covered S-NPP points gives each of them 1/m, and a point's
label is min(1, sum of its shares). Covered S-NPP points in the 0.5° buffer take their shares
too, so a MODIS pixel on the bbox edge is not credited wholly to in-box points, but they get no
row.

The covering overpass is the covering granule's span widened by one granule on each side,
which also catches a detection that MODIS reported from the neighbouring granule. Measuring the
label window from the VIIRS time instead would drop real detections whenever the granule lies
near the coverage window's edge.

Work goes by region and year. Each region-year commits its rows with its entry in
`matchups:report`, and a rerun skips region-years whose inputs and parameters are unchanged.
"""
import argparse
import math
import time
from bisect import bisect_left, bisect_right
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta

from hotornot import config, db, geo

NAME = "matchups"
HELP = "Label S-NPP hotspots by Aqua MODIS detection on near-simultaneous overpasses, 2012-2019."

# Bump when a code change alters rows, so that stored region-years are redone.
METHOD = 2
WINDOW_MIN = 15.0
TOL = 1.5
SWEEP = (1.0, 1.5, 2.0)
# Factor-of-two VIIRS FRP bins in MW: below 0.5, 0.5 to 1, ..., 128 to 256, and above 256.
FRP_EDGES = (0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256)
# Bins with fewer covered candidates are left out of the "rises with FRP" check.
MIN_BIN_ROWS = 30

AQUA_INCLINATION_DEG = 98.2
# Aqua's orbital period over the sidereal day: how far the Earth turns under one orbit.
EARTH_TURN_PER_ORBIT = 98.8 / 1436.07
MYD14_MINUTES = 5.0
GRID_CELL_KM = 5.0
WRITE_BATCH = 20_000
DAY = timedelta(days=1)
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)

DDL = """
CREATE TABLE IF NOT EXISTS matchups (
    hotspot_id    TEXT PRIMARY KEY,
    granule_id    TEXT NOT NULL,
    dt_minutes    REAL NOT NULL,  -- VIIRS acquisition time minus the MYD14 granule's mid time
    label         REAL NOT NULL,
    modis_matches INTEGER NOT NULL
) WITHOUT ROWID"""

POOL_SQL = """
SELECT hotspot_id, acq_utc, lat, lon, in_box, frp_mw FROM hotspots
WHERE region_id = ? AND satellite = 'S-NPP' AND acq_date BETWEEN ? AND ?
  AND processing = 'SP' AND fire_type = 0"""
AQUA_SQL = """
SELECT acq_utc, lat, lon, scan_km, track_km, daynight, in_box, acq_date FROM hotspots
WHERE region_id = ? AND satellite = 'Aqua' AND acq_date BETWEEN ? AND ? AND fire_type = 0"""


class HotspotsNotReady(RuntimeError):
    pass


def minutes(text):
    """Minutes since 1970 of an ISO UTC time such as `2015-06-01T10:33Z`."""
    return (datetime.fromisoformat(text) - EPOCH).total_seconds() / 60


class Granule:
    __slots__ = ("granule_id", "start", "end", "footprint", "_rings", "_bbox")

    def __init__(self, granule_id, start, end, footprint):
        self.granule_id, self.start, self.end, self.footprint = granule_id, start, end, footprint
        self._rings = self._bbox = None

    @property
    def mid(self):
        return (self.start + self.end) / 2

    def gap(self, t):
        return max(self.start - t, t - self.end, 0.0)

    def contains(self, lon, lat):
        if self.footprint is None:
            return False
        if self._rings is None:
            self._rings = geo.footprint_rings(self.footprint)
            self._bbox = geo.bbox_of(self._rings)
        west, south, east, north = self._bbox
        return (west <= lon <= east and south <= lat <= north
                and geo.point_in_polygon(lon, lat, self._rings))


def load_granules(con, region_id, first, last):
    """MYD14 granules of the region starting from `first` to before `last` (ISO times)."""
    rows = con.execute(
        "SELECT granule_id, time_start, time_end, footprint FROM cmr_granules "
        "WHERE short_name = 'MYD14' AND region_id = ? AND time_start >= ? AND time_start < ? "
        "ORDER BY time_start", (region_id, first, last)).fetchall()
    out = []
    for granule_id, time_start, time_end, footprint in rows:
        start = minutes(time_start)
        end = minutes(time_end) if time_end else start + MYD14_MINUTES
        out.append(Granule(granule_id, start, end, footprint))
    return out


def cover(points, granules, window):
    """For each point (t, lat, lon), (granule, dt) for the closest-in-time granule whose span lies
    within `window` minutes of t and whose footprint contains the point, or None."""
    starts = [g.start for g in granules]
    longest = max((g.end - g.start for g in granules), default=0.0)
    by_time = defaultdict(list)
    for i, p in enumerate(points):
        by_time[p[0]].append(i)
    out = [None] * len(points)
    for t, members in by_time.items():
        lo = bisect_left(starts, t - window - longest)
        hi = bisect_right(starts, t + window)
        near = sorted((g for g in granules[lo:hi] if g.gap(t) <= window),
                      key=lambda g: abs(t - g.mid))
        if not near:
            continue
        for i in members:
            _, lat, lon = points[i]
            for g in near:
                if g.contains(lon, lat):
                    out[i] = (g, t - g.mid)
                    break
    return out


def track_direction(lat, ascending):
    """Unit (east, north) vector of Aqua's ground track at `lat`: the orbit's azimuth from its
    inclination, less the Earth's eastward turn under it. Aqua flies north on its day side."""
    cos_lat = math.cos(math.radians(lat))
    sin_az = max(-1.0, min(1.0, math.cos(math.radians(AQUA_INCLINATION_DEG)) / cos_lat))
    north = math.sqrt(1 - sin_az * sin_az) * (1 if ascending else -1)
    east = sin_az - EARTH_TURN_PER_ORBIT * cos_lat
    norm = math.hypot(east, north)
    return east / norm, north / norm


def label(points, found, aqua, tols):
    """{tol: (labels, matches, matched)}: per point the label and the number of Aqua hotspots it
    matched (0 for uncovered points), and the indices of Aqua hotspots matched at all.

    `points` are (t, lat, lon), `found` is the output of `cover`, and `aqua` are
    (t, lat, lon, scan_km, track_km, daynight).
    """
    pixels = []
    buckets = {}
    for j, (t, lat, lon, scan, track, daynight) in enumerate(aqua):
        east, north = track_direction(lat, daynight == "D")
        pixels.append((t, lat, lon, 0.5 * scan, 0.5 * track, east, north))
        buckets.setdefault(int(t // 60), geo.GridIndex(GRID_CELL_KM)).add(lat, lon, j)
    # The haversine search radius covers the grown pixel's half-diagonal in local km.
    reach = 1.01 * max(tols) * max((math.hypot(p[3], p[4]) for p in pixels), default=0.0)

    hits = {tol: defaultdict(list) for tol in tols}
    for i, (_, lat, lon) in enumerate(points):
        if found[i] is None:
            continue
        granule = found[i][0]
        lo, hi = granule.start - MYD14_MINUTES, granule.end + MYD14_MINUTES
        for hour in range(int(lo // 60), int(hi // 60) + 1):
            index = buckets.get(hour)
            if index is None:
                continue
            for _, j in index.near(lat, lon, reach):
                tj, latj, lonj, half_scan, half_track, east, north = pixels[j]
                if not lo <= tj <= hi:
                    continue
                x, y = geo.local_km(latj, lonj, lat, lon)
                along_track = abs(x * east + y * north)
                along_scan = abs(x * north - y * east)
                for tol in tols:
                    if along_scan <= half_scan * tol and along_track <= half_track * tol:
                        hits[tol][j].append(i)

    out = {}
    for tol in tols:
        share = [0.0] * len(points)
        count = [0] * len(points)
        for members in hits[tol].values():
            for i in members:
                share[i] += 1 / len(members)
                count[i] += 1
        out[tol] = ([min(1.0, s) for s in share], count, set(hits[tol]))
    return out


def frp_bin(frp):
    return bisect_right(FRP_EDGES, frp)


def _new_stats(tols):
    bins = len(FRP_EDGES) + 1
    return {
        "candidates": 0, "covered": 0, "positive": 0, "label_sum": 0.0,
        "frp": {"covered": [0] * bins, "positive": [0] * bins, "label_sum": [0.0] * bins},
        "frp_missing": 0,
        "sweep": {str(tol): {"positive": 0, "label_sum": 0.0} for tol in tols},
        "aqua_in_box": 0, "aqua_matched": 0,
    }


def _month_span(year, month):
    first = date(year, month, 1)
    last = date(year + month // 12, month % 12 + 1, 1) - DAY
    return first, last


def region_year(con, region_id, year, window, tol, tols):
    """(rows, ids of uncovered candidates, stats) for one region and year. Reads go month by
    month, each with a day on both sides so that shares near month ends see every point."""
    tols = tuple(sorted(set(tols) | {tol}))
    year_first, year_last = date(year, 1, 1), date(year, 12, 31)
    granules = load_granules(con, region_id, (year_first - 2 * DAY).isoformat(),
                             (year_last + 3 * DAY).isoformat())
    stats = _new_stats(tols)
    lo, hi = minutes(f"{year_first}T00:00Z"), minutes(f"{year_last + DAY}T00:00Z")
    stats["granules"] = sum(lo <= g.start < hi for g in granules)
    rows, uncovered = [], []
    for month in range(1, 13):
        first, last = _month_span(year, month)
        span = ((first - DAY).isoformat(), (last + DAY).isoformat())
        first_text, last_text = first.isoformat(), last.isoformat()
        pool = con.execute(POOL_SQL, (region_id, *span)).fetchall()
        aqua_rows = con.execute(AQUA_SQL, (region_id, *span)).fetchall()
        times = {text: minutes(text) for text in {r[1] for r in pool}}
        points = [(times[r[1]], r[2], r[3]) for r in pool]
        aqua = [(minutes(a[0]), a[1], a[2], a[3], a[4], a[5]) for a in aqua_rows]
        found = cover(points, granules, window)
        labels = label(points, found, aqua, tols)
        main_labels, main_counts, main_matched = labels[tol]

        for i, (hotspot_id, acq_utc, _, _, in_box, frp) in enumerate(pool):
            if not in_box or not first_text <= acq_utc[:10] <= last_text:
                continue
            stats["candidates"] += 1
            if found[i] is None:
                uncovered.append(hotspot_id)
                continue
            granule, dt = found[i]
            value = main_labels[i]
            rows.append((hotspot_id, granule.granule_id, dt, value, main_counts[i]))
            stats["covered"] += 1
            stats["positive"] += value > 0
            stats["label_sum"] += value
            if frp is None:
                stats["frp_missing"] += 1
            else:
                b = frp_bin(frp)
                stats["frp"]["covered"][b] += 1
                stats["frp"]["positive"][b] += value > 0
                stats["frp"]["label_sum"][b] += value
            for t in tols:
                stats["sweep"][str(t)]["positive"] += labels[t][0][i] > 0
                stats["sweep"][str(t)]["label_sum"] += labels[t][0][i]
        for j, a in enumerate(aqua_rows):
            if a[6] and first_text <= a[7] <= last_text:
                stats["aqua_in_box"] += 1
                stats["aqua_matched"] += j in main_matched
    return rows, uncovered, stats


def input_counts(con, region_id, year):
    """Row and granule counts that decide whether a stored region-year is still current. They
    use only indexes, so they are cheap."""
    span = ((date(year, 1, 1) - DAY).isoformat(), date(year + 1, 1, 1).isoformat())
    counts = {}
    for satellite in ("S-NPP", "Aqua"):
        counts[satellite] = con.execute(
            "SELECT COUNT(*) FROM hotspots WHERE region_id = ? AND satellite = ? "
            "AND acq_date BETWEEN ? AND ?", (region_id, satellite, *span)).fetchone()[0]
    counts["MYD14"] = con.execute(
        "SELECT COUNT(*) FROM cmr_granules WHERE short_name = 'MYD14' AND region_id = ? "
        "AND time_start >= ? AND time_start < ?",
        (region_id, (date(year, 1, 1) - 2 * DAY).isoformat(),
         (date(year, 12, 31) + 3 * DAY).isoformat())).fetchone()[0]
    return counts


def normalize_started(con):
    """When the `hotspots` build now in the table started reading raw files, as ISO text."""
    row = con.execute("SELECT json_extract(json, '$.seconds'), created_at FROM artifacts "
                      "WHERE name = 'normalize:report'").fetchone()
    if not row or row[0] is None:
        return None
    end = datetime.fromisoformat(row[1])
    return (end - timedelta(seconds=row[0])).isoformat(timespec="seconds")


def raw_file_status(con, region, years, started):
    """{year: {files, pending, after_normalize, complete}} over the raw files that feed the
    region's S-NPP and Aqua history: complete when every file is finished and was read by the
    `hotspots` build now in the table."""
    status = {y: {"files": 0, "pending": 0, "after_normalize": 0} for y in years}

    def add(year, state, fetched_at):
        if year not in status:
            return
        s = status[year]
        s["files"] += 1
        if state not in ("done", "missing"):
            s["pending"] += 1
        elif started is not None and fetched_at and fetched_at > started:
            s["after_normalize"] += 1

    if region["history"] == "api":
        for key, state, fetched_at in con.execute(
                "SELECT file_key, status, fetched_at FROM raw_files WHERE kind = 'api' "
                "AND (file_key LIKE ? OR file_key LIKE ?)",
                (f"api:MODIS_SP:{region['id']}:%", f"api:VIIRS_SNPP_SP:{region['id']}:%")):
            _, _, _, first, days = key.split(":")
            first = date.fromisoformat(first)
            last = first + (int(days) - 1) * DAY
            for year in range(first.year, last.year + 1):
                add(year, state, fetched_at)
    else:
        for year, state, fetched_at in con.execute(
                "SELECT year, status, fetched_at FROM raw_files WHERE kind = 'country' "
                f"AND source IN ('modis', 'viirs-snpp') AND country IN "
                f"({', '.join('?' * len(region['countries']))})", region["countries"]):
            add(year, state, fetched_at)
    for s in status.values():
        s["complete"] = s["files"] > 0 and not s["pending"] and not s["after_normalize"]
    return status


def hotspots_version(con):
    """The finish time of the `hotspots` build now in the table. `normalize` builds the
    hotspot_id index last, so while that index is missing the table is partial."""
    if not con.execute("SELECT 1 FROM sqlite_master WHERE type = 'index' "
                       "AND name = 'hotspots_hotspot_id'").fetchone():
        raise HotspotsNotReady("hotspots is being rebuilt (index hotspots_hotspot_id is missing); "
                               "rerun matchups after normalize finishes")
    row = con.execute(
        "SELECT created_at FROM artifacts WHERE name = 'normalize:report'").fetchone()
    return row[0] if row else None


def check_hotspots(con, version):
    if hotspots_version(con) != version:
        raise HotspotsNotReady("hotspots was rebuilt while matchups ran; rerun matchups")


def write(con, rows, uncovered, report, version):
    """Replace the region-year's rows in short transactions; the report goes in the last one, so
    an interrupted region-year is redone on the next run."""
    ops = sorted([(r[0], r) for r in rows] + [(h, None) for h in uncovered])
    longest = 0.0
    for k in range(0, max(len(ops), 1), WRITE_BATCH):
        batch = ops[k:k + WRITE_BATCH]
        last = k + WRITE_BATCH >= len(ops)
        check_hotspots(con, version)
        started = time.monotonic()
        with con:
            con.executemany("DELETE FROM matchups WHERE hotspot_id = ?",
                            [(h,) for h, r in batch if r is None])
            con.executemany("INSERT OR REPLACE INTO matchups VALUES (?, ?, ?, ?, ?)",
                            [r for _, r in batch if r is not None])
            if last:
                db.put_artifact("matchups:report", report, con)
        longest = max(longest, time.monotonic() - started)
    return longest


def delete_orphans(con, version):
    """Drop rows whose hotspot is gone after a `normalize` rebuild."""
    check_hotspots(con, version)
    gone = con.execute(
        "SELECT hotspot_id FROM matchups AS m WHERE NOT EXISTS "
        "(SELECT 1 FROM hotspots AS h WHERE h.hotspot_id = m.hotspot_id)").fetchall()
    for k in range(0, len(gone), WRITE_BATCH):
        check_hotspots(con, version)
        with con:
            con.executemany("DELETE FROM matchups WHERE hotspot_id = ?", gone[k:k + WRITE_BATCH])
    return len(gone)


def summarize(entries, params, status, regions, years):
    """Per-region totals over the stored region-years computed with `params`."""
    out = []
    for region in regions:
        rid = region["id"]
        done = [(y, entries[f"{rid}:{y}"]) for y in years
                if entries.get(f"{rid}:{y}", {}).get("params") == params]
        total = _new_stats(params["sweep"])
        for _, e in done:
            for key in ("candidates", "covered", "positive", "label_sum", "frp_missing",
                        "aqua_in_box", "aqua_matched"):
                total[key] += e[key]
            for key in ("covered", "positive", "label_sum"):
                total["frp"][key] = [a + b for a, b in zip(total["frp"][key], e["frp"][key])]
            for t, s in e["sweep"].items():
                total["sweep"][t]["positive"] += s["positive"]
                total["sweep"][t]["label_sum"] += s["label_sum"]
        covered = total["covered"]
        bins = []
        for b, n in enumerate(total["frp"]["covered"]):
            bins.append({
                "frp_lo": FRP_EDGES[b - 1] if b else 0,
                "frp_hi": FRP_EDGES[b] if b < len(FRP_EDGES) else None,
                "covered": n,
                "positive_share": total["frp"]["positive"][b] / n if n else None,
                "mean_label": total["frp"]["label_sum"][b] / n if n else None,
            })
        usable = [x for x in bins if x["covered"] >= MIN_BIN_ROWS]

        def drops(field):
            return [{"frp_lo": [a["frp_lo"], b["frp_lo"]],
                     field: [round(a[field], 4), round(b[field], 4)]}
                    for a, b in zip(usable, usable[1:]) if b[field] <= a[field]]

        label_drops, positive_drops = drops("mean_label"), drops("positive_share")
        out.append({
            "region_id": rid,
            "years_done": [y for y, _ in done],
            "years_inputs_complete": [y for y in years if status[rid][y]["complete"]],
            "candidates": total["candidates"],
            "covered": covered,
            "covered_share": covered / total["candidates"] if total["candidates"] else None,
            "positive": total["positive"],
            "positive_share": total["positive"] / covered if covered else None,
            "mean_label": total["label_sum"] / covered if covered else None,
            "label_sum": total["label_sum"],
            "frp_missing": total["frp_missing"],
            "frp_bins": bins,
            "rises_with_frp": bool(len(usable) >= 2 and not label_drops),
            "frp_drops": label_drops,
            "positive_rises_with_frp": bool(len(usable) >= 2 and not positive_drops),
            "frp_positive_drops": positive_drops,
            "by_tol": {t: {"positive_share": s["positive"] / covered if covered else None,
                           "mean_label": s["label_sum"] / covered if covered else None}
                       for t, s in total["sweep"].items()},
            "aqua_in_box": total["aqua_in_box"],
            "aqua_matched": total["aqua_matched"],
        })
    return out


def calibration_years():
    return list(range(config.CALIBRATION[0].year, config.CALIBRATION[1].year + 1))


def matchups(con, cfg, years=None, region_ids=None, window=WINDOW_MIN, tol=TOL, sweep=SWEEP,
             force=False, log=None):
    """Build or refresh the matchups of `region_ids` (default all) in `years` (default the
    calibration years), and store `matchups:report`, which summarizes every region and
    calibration year done so far with the same parameters. Returns that report."""
    log = log or (lambda msg: print(msg, flush=True))
    started_run = time.monotonic()
    all_years = calibration_years()
    years = sorted(years or all_years)
    region_ids = region_ids or [r["id"] for r in cfg["regions"]]
    version = hotspots_version(con)
    with con:
        con.execute(DDL)
    params = {"method": METHOD, "window_min": float(window), "tol": float(tol),
              "sweep": sorted({float(t) for t in sweep} | {float(tol)})}
    old = db.get_artifact("matchups:report", con) or {}
    entries = dict(old.get("region_years", {}))
    started = normalize_started(con)
    status = {r["id"]: raw_file_status(con, r, all_years, started) for r in cfg["regions"]}

    def report():
        return {"params": params, "hotspots_version": version, "normalize_started": started,
                "inputs": status, "region_years": entries,
                "regions": summarize(entries, params, status, cfg["regions"], all_years)}

    for region in cfg["regions"]:
        rid = region["id"]
        if rid not in region_ids:
            continue
        for year in years:
            key = f"{rid}:{year}"
            check_hotspots(con, version)
            counts = input_counts(con, rid, year)
            stored = entries.get(key)
            if (not force and stored and stored.get("params") == params
                    and stored.get("inputs") == counts):
                log(f"{key}: unchanged, skipped ({stored['covered']:,} rows)")
                continue
            t0 = time.monotonic()
            rows, uncovered, stats = region_year(con, rid, year, window, tol, params["sweep"])
            compute_s = time.monotonic() - t0
            entries[key] = {"params": params, "inputs": counts, **stats,
                            "seconds": round(compute_s, 1),
                            "finished_at": datetime.now(UTC).isoformat(timespec="seconds")}
            longest = write(con, rows, uncovered, report(), version)
            entries[key]["longest_write_s"] = round(longest, 2)
            cov = stats["covered"] / stats["candidates"] if stats["candidates"] else 0
            mean = stats["label_sum"] / stats["covered"] if stats["covered"] else 0
            log(f"{key}: {stats['candidates']:,} candidates, {stats['covered']:,} covered "
                f"({cov:.1%}), {stats['positive']:,} positive, mean label {mean:.3f}; "
                f"{compute_s:.0f} s, longest write {longest:.2f} s")

    orphans = delete_orphans(con, version)
    final = report()
    final["orphans_deleted"] = orphans
    final["seconds"] = round(time.monotonic() - started_run, 1)
    db.put_artifact("matchups:report", final, con)
    return final


def _fmt(x, spec):
    return "-" if x is None else format(x, spec)


def print_report(report):
    p = report["params"]
    print(f"\nmatchups: window {p['window_min']:g} min, tol {p['tol']:g}; this run "
          f"{report['seconds']:.0f} s, {report['orphans_deleted']} orphan rows deleted")
    print("Years: done with these parameters / raw inputs complete. Aqua matched: in-box Aqua "
          "hotspots matched by a covered S-NPP point, of all in-box Aqua hotspots")
    print(f"{'region':<14}{'years':>6}{'candidates':>12}{'covered':>10}{'covered%':>9}"
          f"{'positive%':>10}{'mean label':>11}{'Aqua matched':>18}")
    for r in report["regions"]:
        years = f"{len(r['years_done'])}/{len(r['years_inputs_complete'])}"
        aqua = f"{r['aqua_matched']:,}/{r['aqua_in_box']:,}"
        print(f"{r['region_id']:<14}{years:>6}{r['candidates']:>12,}{r['covered']:>10,}"
              f"{_fmt(r['covered_share'], '.1%'):>9}{_fmt(r['positive_share'], '.1%'):>10}"
              f"{_fmt(r['mean_label'], '.3f'):>11}{aqua:>18}")

    print("\nBy S-NPP FRP (MW) over covered candidates: mean label, then positive share.")
    print(f"Bins with under {MIN_BIN_ROWS} rows, in parentheses, are left out of the trend check.")
    bins = report["regions"][0]["frp_bins"] if report["regions"] else []
    heads = [f"<{b['frp_hi']:g}" if not b["frp_lo"] else
             f">{b['frp_lo']:g}" if b["frp_hi"] is None else f"{b['frp_lo']:g}-{b['frp_hi']:g}"
             for b in bins]
    print(f"{'region':<14}" + "".join(f"{h:>8}" for h in heads) + "  rises")
    for r in report["regions"]:
        for field, rises, name in (("mean_label", "rises_with_frp", r["region_id"]),
                                   ("positive_share", "positive_rises_with_frp", "  positive")):
            cells = []
            for b in r["frp_bins"]:
                v = _fmt(b[field], ".3f")
                cells.append(f"({v})" if b[field] is not None and b["covered"] < MIN_BIN_ROWS
                             else v)
            print(f"{name:<14}" + "".join(f"{c:>8}" for c in cells)
                  + f"  {'yes' if r[rises] else 'NO'}")
        print(f"{'  covered':<14}" + "".join(f"{b['covered']:>8,}" for b in r["frp_bins"]))

    print("\nPositive share / mean label by tol")
    tols = list(report["regions"][0]["by_tol"]) if report["regions"] else []
    print(f"{'region':<14}" + "".join(f"{'tol ' + t:>18}" for t in tols))
    for r in report["regions"]:
        cells = [f"{_fmt(r['by_tol'][t]['positive_share'], '.1%')} / "
                 f"{_fmt(r['by_tol'][t]['mean_label'], '.3f')}" for t in tols]
        print(f"{r['region_id']:<14}" + "".join(f"{c:>18}" for c in cells))

    incomplete = [f"{rid}:{y} ({s['pending']} pending, {s['after_normalize']} newer than hotspots"
                  f"{', no files' if not s['files'] else ''})"
                  for rid, years in report["inputs"].items() for y, s in years.items()
                  if not s["complete"]]
    if incomplete:
        print("\nRegion-years whose raw S-NPP or MODIS files are not all in hotspots yet:")
        for line in incomplete:
            print(f"  {line}")


def _years(text):
    allowed = calibration_years()
    years = set()
    for part in text.split(","):
        a, _, b = part.partition("-")
        years.update(range(int(a), int(b or a) + 1))
    if not years or not years <= set(allowed):
        raise argparse.ArgumentTypeError(f"years must lie in {allowed[0]}-{allowed[-1]}")
    return sorted(years)


def add_arguments(parser):
    allowed = calibration_years()
    parser.add_argument("--regions", help="comma-separated region ids (default: all)")
    parser.add_argument("--years", type=_years,
                        help=f"years such as 2012-2014 or 2015,2017 "
                             f"(default {allowed[0]}-{allowed[-1]})")
    parser.add_argument("--window", type=float, default=WINDOW_MIN,
                        help="largest gap in minutes between the VIIRS time and the span of a "
                             f"covering MYD14 granule (default {WINDOW_MIN:g})")
    parser.add_argument("--tol", type=float, default=TOL,
                        help=f"MODIS pixel growth factor for the label (default {TOL:g})")
    parser.add_argument("--force", action="store_true",
                        help="redo region-years whose inputs and parameters are unchanged")


def run(args):
    cfg = config.load_config()
    region_ids = [r["id"] for r in config.regions(args.regions, cfg)]
    con = db.connect()
    try:
        report = matchups(con, cfg, args.years, region_ids, window=args.window, tol=args.tol,
                          force=args.force)
    except HotspotsNotReady as e:
        print(f"matchups: {e}")
        return 1
    finally:
        con.close()
    print_report(report)
    return 0
