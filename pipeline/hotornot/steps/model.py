"""model_v1: `viirs_features`, `k_factors`, the `model_v1` weights and the model artifacts.

The features, the fit and k come from `hotornot.modeling`. `viirs_features` and the weights are
rewritten one hotspot_id range at a time, each in one short transaction, so both stay complete
while the step runs and a rerun leaves no stale rows. `ratio_v1` weights are never touched.
"""
import argparse
import calendar
import resource
import sys
import time
from collections import defaultdict

from hotornot import config, db, modeling
from hotornot.steps import series
from hotornot.steps.matchups import HotspotsNotReady, check_hotspots, hotspots_version
from hotornot.steps.normalize import _wait_for_checkpoint

NAME = "model"
HELP = ("Fit model_v1 (weight = detection share s x coverage factor k) on 2012-2019; write "
        "viirs_features, k_factors and model_v1 weights; print the coefficients.")

METHOD = modeling.METHOD
CHECK_TOLERANCE = series.CHECK_TOLERANCE
FEATURES_COLUMNS = ["hotspot_id", "log_frp", "pixel_area", "is_night", "cluster_size",
                    "land_class"]
FEATURES_DDL = """
CREATE TABLE viirs_features (
    hotspot_id   TEXT PRIMARY KEY,
    log_frp      REAL NOT NULL,     -- ln(max(frp_mw, 0.1))
    pixel_area   REAL NOT NULL,     -- scan_km x track_km, km2
    is_night     INTEGER NOT NULL,
    cluster_size INTEGER NOT NULL,  -- vegetation hotspots of the satellite within 1 km and
                                    -- 10 minutes, the row itself included
    land_class   TEXT NOT NULL
) WITHOUT ROWID;
"""
K_DDL = """
CREATE TABLE k_factors (
    region_id TEXT NOT NULL,
    month     INTEGER NOT NULL,
    satellite TEXT NOT NULL,
    k         REAL NOT NULL,
    level     TEXT NOT NULL,
    PRIMARY KEY (region_id, month, satellite)
);
"""
INPUTS = ("normalize", "static_mask", "coverage", "matchups", "series")


def ensure_tables(con):
    with con:
        if [r[1] for r in con.execute("PRAGMA table_info(viirs_features)")] != FEATURES_COLUMNS:
            db.recreate(con, FEATURES_DDL)
        columns = [r[1] for r in con.execute("PRAGMA table_info(weights)")]
        if not columns:
            con.execute(series.WEIGHTS_DDL)
        elif columns != series.WEIGHTS_COLUMNS:
            raise RuntimeError(f"weights has columns {columns}, expected "
                               f"{series.WEIGHTS_COLUMNS}")


def write(con, rows, model, version, artifacts, log=print):
    """Rewrite viirs_features and the model_v1 weights range by range, then k_factors and the
    artifacts in one last transaction. Returns (rows written, longest write in s)."""
    ensure_tables(con)
    score = model.scorer(rows.classes)
    kt = modeling.weight_table(rows, model)
    month, classes = modeling.MONTH, rows.classes
    written, longest = 0, 0.0
    for b in range(256):
        features, weights = [], []
        for rec in modeling.RECORD.iter_unpack(rows.buckets[b]):
            hid = rec[0].hex()
            features.append((hid, rec[5], rec[6], rec[7], rec[8], classes[rec[9]]))
            weights.append((hid, METHOD, score(rec) * kt[rec[1], month[rec[4]], rec[2]]))
        where, params = series.id_range(b)
        _wait_for_checkpoint(con, log)
        check_hotspots(con, version)
        t0 = time.monotonic()
        with con:
            con.execute(f"DELETE FROM viirs_features WHERE {where}", params)
            con.executemany("INSERT INTO viirs_features VALUES (?, ?, ?, ?, ?, ?)", features)
            con.execute(f"DELETE FROM weights WHERE method = ? AND {where}", [METHOD, *params])
            con.executemany("INSERT INTO weights VALUES (?, ?, ?)", weights)
        longest = max(longest, time.monotonic() - t0)
        written += len(features)
    check_hotspots(con, version)
    with con:
        db.recreate(con, K_DDL)
        con.executemany("INSERT INTO k_factors VALUES (?, ?, ?, ?, ?)", k_rows(model))
        for name, value in artifacts.items():
            db.put_artifact(name, value, con)
    return written, longest


def k_rows(model):
    return [(rid, m, s, v[0], v[1]) for (rid, m, s), v in sorted(model.k.items())]


def input_versions(con):
    """When each input step last wrote its report; inputs older than normalize are `stale`."""
    created = dict(con.execute(
        f"SELECT name, created_at FROM artifacts WHERE name IN ({', '.join('?' * len(INPUTS))})",
        [f"{n}:report" for n in INPUTS]))
    out = {n: created.get(f"{n}:report") for n in INPUTS}
    base = out["normalize"]
    out["stale"] = [n for n in INPUTS[1:] if base and (out[n] is None or out[n] < base)]
    return out


def _error(value, modis):
    return (value - modis) / modis if modis else None


def make_report(con, rows, model):
    series_report = db.get_artifact("series:report", con) or {}
    ratio = {rid: {r["year"]: r for r in table}
             for rid, table in series_report.get("annual", {}).items()}
    tables = {"modis": modeling.modis_by_month(rows),
              "modis_viirs_days": modeling.modis_on_series_days(rows),
              "viirs_raw": modeling.counts_by_month(rows),
              "model": modeling.weighted_sums(rows, model)}
    train = set(model.info["train_years"])
    annual, checks = {}, []
    for rid in rows.regions:
        years = defaultdict(lambda: dict.fromkeys(tables, 0))
        for name, table in tables.items():
            for (r, ym), v in table.items():
                if r == rid:
                    years[ym // 100][name] += v
        out = []
        for year in sorted(years):
            y = years[year]
            ratio_row = ratio.get(rid, {}).get(year, {})
            row = {"year": year, "modis": y["modis"], "modis_viirs_days": y["modis_viirs_days"],
                   "viirs_raw": y["viirs_raw"], "ratio": ratio_row.get("harmonized"),
                   "model": round(y["model"], 3), "ratio_error": ratio_row.get("error"),
                   "model_error": _error(y["model"], y["modis"]),
                   "ratio_error_viirs_days": _error(ratio_row.get("harmonized") or 0,
                                                    y["modis_viirs_days"]),
                   "model_error_viirs_days": _error(y["model"], y["modis_viirs_days"])}
            if ratio_row and ratio_row.get("modis") != y["modis"]:
                row["ratio_modis"] = ratio_row.get("modis")
            out.append(row)
            if year in train:
                checks.append({"region_id": rid, "year": year,
                               "model_ok": _ok(row["model_error"]),
                               "ratio_ok": _ok(row["ratio_error"]),
                               "model_ok_viirs_days": _ok(row["model_error_viirs_days"]),
                               "ratio_ok_viirs_days": _ok(row["ratio_error_viirs_days"])})
        annual[rid] = out
    totals = {}
    for rid, table in annual.items():
        cal = [r for r in table if r["year"] in train]
        totals[rid] = {"model": _error(sum(r["model"] for r in cal), sum(r["modis"] for r in cal)),
                       "ratio": _error(sum(r["ratio"] or 0 for r in cal),
                                       sum(r["modis"] for r in cal))}
    return {
        "method": METHOD,
        "rows": len(rows),
        "ratio_v1_weights": series_report.get("weights"),
        "load": rows.stats,
        "k": [{"region_id": r, "month": m, "satellite": s, "k": k, "level": lv}
              for r, m, s, k, lv in k_rows(model)],
        "annual": annual,
        "checks": {"tolerance": CHECK_TOLERANCE, "years": checks, "totals": totals},
        "inputs": input_versions(con),
    }


def _ok(err):
    return err is not None and abs(err) <= CHECK_TOLERANCE


def peak_rss_mb():
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(rss / 2 ** 20 if sys.platform == "darwin" else rss / 2 ** 10)


def _pct(x):
    return "-" if x is None else f"{x:+.1%}"


def print_report(report, model_info):
    load = report["load"]
    print(f"\nmodel_v1: {report['rows']:,} vegetation VIIRS rows (ratio_v1 weights:"
          f" {report['ratio_v1_weights'] or 0:,}); land classes: {', '.join(load['classes'])}"
          f"{'' if load['land_cover'] else ' (no land_cover table)'}")
    if report["inputs"]["stale"]:
        print(f"WARNING: {', '.join(report['inputs']['stale'])} ran before the last normalize;"
              " rerun them, then this step")
    if load.get("matchups_missing"):
        print(f"WARNING: {load['matchups_missing']:,} matchups have no vegetation VIIRS row"
              " (stale matchups table)")

    tr, fit = model_info["training_rows"], model_info["fit"]
    years = model_info["train_years"]
    print(f"\nfit on {years[0]}-{years[-1]}: {tr['sampled']:,} of {tr['in_train_years']:,}"
          f" matchups (cap {tr['cap']:,}, seed {tr['seed']}, stratified by region and year),"
          f" {tr['positive']:,} with label > 0, label sum {tr['label_sum']:,.1f};"
          f" {tr['doubled_rows']:,} doubled rows")
    print(f"IRLS: {fit['iterations']} iterations, converged {fit['converged']},"
          f" deviance {fit['deviance']:,.1f} (null {fit['null_deviance']:,.1f}),"
          f" {fit['seconds']} s")
    print(f"\n{'feature':<22} {'coef (std)':>11} {'per unit':>10} {'mean':>9} {'sd':>9}")
    print(f"{'intercept':<22} {model_info['intercept']:>11.4f}"
          f" {model_info['raw_coefficients']['intercept']:>10.4f}")
    for name in model_info["features"]:
        mean = model_info["scaler"]["mean"].get(name)
        sd = model_info["scaler"]["sd"].get(name)
        print(f"{name:<22} {model_info['coefficients'][name]:>11.4f}"
              f" {model_info['raw_coefficients'][name]:>10.4f}"
              + (f" {mean:>9.4f} {sd:>9.4f}" if mean is not None else ""))
    if model_info.get("land_reference"):
        print(f"land class reference: {model_info['land_reference']}")

    print("\nk (MODIS-equivalent hotspots per unit of detection share); level m = region_month,"
          " p = pooled_3month, y = region_year")
    print(f"{'region':<13} {'satellite':<9}" + "".join(f" {calendar.month_abbr[m]:>7}"
                                                        for m in range(1, 13)))
    by_key = defaultdict(dict)
    for k in report["k"]:
        by_key[k["region_id"], k["satellite"]][k["month"]] = k
    for (rid, satellite), months in sorted(by_key.items()):
        print(f"{rid:<13} {satellite:<9}" + "".join(
            f" {months[m]['k']:>6.3f}{series.LEVEL_CODES[months[m]['level']]}"
            for m in range(1, 13)))

    print("\nannual in-box totals: MODIS vegetation count against harmonized VIIRS (in-series"
          " rows).\n'err' compares with all MODIS rows, as series:report does; 'on VIIRS days'"
          " only with\nMODIS rows on days the series VIIRS satellite observed. 'noise' is"
          " 1/sqrt(MODIS), the Poisson\nscatter of the MODIS count itself.")
    for rid, table in report["annual"].items():
        print(f"\n{rid}\n{'':<6} {'':>9} {'MODIS on':>9} {'':>10} {'':>10} {'':>10}"
              f" {'':>9} {'':>9} {'on VIIRS days':>19}"
              f"\n{'year':<6} {'MODIS':>9} {'VIIRS d.':>9} {'VIIRS raw':>10} {'ratio_v1':>10}"
              f" {'model_v1':>10} {'ratio err':>9} {'model err':>9} {'ratio':>9} {'model':>9}"
              f" {'noise':>6}")
        for r in table:
            ratio = "-" if r["ratio"] is None else f"{r['ratio']:,.1f}"
            noise = f"{r['modis'] ** -0.5:.1%}" if r["modis"] else "-"
            print(f"{r['year']:<6} {r['modis']:>9,} {r['modis_viirs_days']:>9,}"
                  f" {r['viirs_raw']:>10,} {ratio:>10} {r['model']:>10,.1f}"
                  f" {_pct(r['ratio_error']):>9} {_pct(r['model_error']):>9}"
                  f" {_pct(r['ratio_error_viirs_days']):>9}"
                  f" {_pct(r['model_error_viirs_days']):>9} {noise:>6}")

    checks = report["checks"]
    span = f"{years[0]}-{years[-1]}"
    n = len(checks["years"])
    for suffix, label in (("", "MODIS"), ("_viirs_days", "MODIS on VIIRS days")):
        for method in ("model", "ratio"):
            bad = [c for c in checks["years"] if not c[f"{method}_ok{suffix}"]]
            print(f"{span} single years within {checks['tolerance']:.0%} of {label}, {method}:"
                  f" {n - len(bad)} of {n}" + ("; outside: " + ", ".join(
                      f"{c['region_id']} {c['year']}" for c in bad) if bad else ""))
    print(f"{span} totals against MODIS: " + ", ".join(
        f"{rid} model {_pct(t['model'])} ratio {_pct(t['ratio'])}"
        for rid, t in checks["totals"].items()))


def _years(text):
    years = set()
    for part in text.split(","):
        a, _, b = part.partition("-")
        years.update(range(int(a), int(b or a) + 1))
    first = config.VIIRS_SERIES_START.year
    if not years or min(years) < first:
        raise argparse.ArgumentTypeError(f"years must be {first} or later")
    return sorted(years)


def add_arguments(parser):
    cal = f"{config.CALIBRATION[0].year}-{config.CALIBRATION[1].year}"
    parser.add_argument("--years", type=_years, default=_years(cal),
                        help=f"training years such as 2012-2019 or 2014,2016 (default {cal})")
    parser.add_argument("--cap", type=int, default=modeling.SAMPLE_CAP,
                        help=f"most matchups in the fit sample (default {modeling.SAMPLE_CAP:,})")
    parser.add_argument("--seed", type=int, default=modeling.SEED,
                        help=f"sample seed (default {modeling.SEED})")
    parser.add_argument("--dry-run", action="store_true",
                        help="fit and print without writing anything")


def run(args):
    started = time.monotonic()
    cfg = config.load_config()
    con = db.connect()
    try:
        version = hotspots_version(con)
        rows = modeling.load(con, cfg, log=lambda line: print(line, flush=True))
        check_hotspots(con, version)
        model = modeling.fit(rows, args.years, args.cap, args.seed)
        report = make_report(con, rows, model)
        curve = modeling.detection_curve(model)
        info = model.as_dict()
        info["detection_curve"] = {"cluster_size": 1, "rows_averaged": len(model.curve_rows)}
        report["seconds"] = {"load": rows.stats["seconds"], "fit": info["fit"]["seconds"],
                             "scoring": info["scoring_seconds"]}
        if args.dry_run:
            print("dry run: nothing written")
        else:
            t0 = time.monotonic()
            written, longest = write(con, rows, model, version, {
                "model:model_v1": info, "model:detection_curve": curve})
            report["seconds"]["write"] = round(time.monotonic() - t0, 1)
            report["peak_rss_mb"] = peak_rss_mb()
            db.put_artifact("model:report", report, con)
            print(f"wrote {written:,} viirs_features rows and {written:,} {METHOD} weights in 256"
                  f" transactions, longest {longest:.2f} s; {len(model.k)} k factors")
    except HotspotsNotReady:
        print("model: hotspots is being rebuilt, or was rebuilt while this step ran;"
              " rerun model after normalize finishes")
        return 1
    finally:
        con.close()
    print_report(report, info)
    print(f"\ntime: load {report['seconds']['load']} s, fit {report['seconds']['fit']} s,"
          f" scoring {report['seconds']['scoring']} s, write {report['seconds'].get('write')} s,"
          f" total {time.monotonic() - started:.0f} s; peak RSS {peak_rss_mb()} MB")
    return 0
