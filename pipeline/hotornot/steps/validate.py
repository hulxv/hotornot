"""validate: seam tests of ratio_v1 and model_v1 against MODIS, and the choice between them.

Leave-two-years-out folds within 2012-2019 refit both methods without the fold and predict its
months; the 2020-2025 block is predicted by the 2012-2019 fit. One `modeling.load` feeds every
refit, done in memory: the ratio factors with `series.fit_factors` (the P06 rule) and the model
with `modeling.fit`. Only the `validation:*` artifacts are written; `ratio_factors`, `k_factors`
and `weights` stay as shipped.

MODIS, the truth, counts in-box vegetation rows on days the series VIIRS satellite observed,
the days both methods are calibrated on. That leaves out S-NPP outages and 2012-01-01 to 01-19,
before S-NPP data.
"""
import math
import sqlite3
import time
from collections import Counter, defaultdict
from types import SimpleNamespace

from hotornot import config, db, modeling
from hotornot.steps import series
from hotornot.steps.matchups import HotspotsNotReady, check_hotspots, hotspots_version
from hotornot.steps.model import peak_rss_mb

NAME = "validate"
HELP = ("Seam tests of ratio_v1 and model_v1 against MODIS (leave-two-years-out 2012-2019, the "
        "2020-2025 block), the NOAA-20 seam test and the drift check; print the scorecard and "
        "the decision.")

CAL_YEARS = tuple(range(config.CALIBRATION[0].year, config.CALIBRATION[1].year + 1))
FOLDS = tuple(CAL_YEARS[i:i + 2] for i in range(0, len(CAL_YEARS), 2))
BLOCK = tuple(range(config.CALIBRATION[1].year + 1, config.BASELINE[1].year + 1))
YEARS = CAL_YEARS + BLOCK
ANNUAL_LIMIT_PCT = 15.0
MIN_R = 0.9
MIN_REGIONS = 3
METHODS = (("raw", "viirs_raw"), ("ratio", "ratio"), ("model", "model"))
N20_ROLES = frozenset(r for r, s in modeling.VIIRS_ROLES.items() if s == "NOAA-20")
SHIPS = {"ratio_v1": "ratio", "model_v1": "model"}


def span(years):
    return f"{years[0]}-{years[-1]}"


def annual_error_pct(predicted, truth):
    """Mean of |predicted - truth| / truth in percent over the years of `truth` (year -> total).
    A year whose truth is 0 has no relative error and is skipped."""
    errors = [abs(predicted.get(y, 0.0) - t) / t * 100 for y, t in truth.items() if t]
    return sum(errors) / len(errors) if errors else None


def pearson(xs, ys):
    """Pearson r, or None with fewer than 2 values or when either side is constant."""
    n = len(xs)
    if n < 2:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx == 0 or syy == 0:
        return None
    return sxy / math.sqrt(sxx * syy)


def score(months, key, truth):
    """(mean absolute annual error in percent, Pearson r of monthly values) of field `key`
    against field `truth` over `months`, a list of dicts with `ym`."""
    predicted, actual = Counter(), Counter()
    for m in months:
        predicted[m["ym"] // 100] += m[key]
        actual[m["ym"] // 100] += m[truth]
    return (annual_error_pct(predicted, actual),
            pearson([m[key] for m in months], [m[truth] for m in months]))


def region_scores(region_id, months):
    errors, rs = {}, {}
    for method, key in METHODS:
        errors[method], rs[method] = score(months, key, "modis")
    return {"region_id": region_id, "annual_error_pct": errors, "monthly_r": rs}


def passes(scores):
    error, r = scores["annual_error_pct"]["model"], scores["monthly_r"]["model"]
    return error is not None and r is not None and error <= ANNUAL_LIMIT_PCT and r >= MIN_R


def mean_error(scores, method):
    values = [s["annual_error_pct"][method] for s in scores]
    return None if not values or None in values else sum(values) / len(values)


def decide(lyo):
    """The RFC rule on the leave-two-years-out scores (one entry per region): model_v1 ships
    when it passes both limits in at least MIN_REGIONS regions and its annual error, averaged
    over the regions, is below the ratio's."""
    passing = [s["region_id"] for s in lyo if passes(s)]
    model, ratio = mean_error(lyo, "model"), mean_error(lyo, "ratio")
    ships = (len(passing) >= MIN_REGIONS and model is not None and ratio is not None
             and model < ratio)
    return {"method": "model_v1" if ships else "ratio_v1", "passed_regions": len(passing),
            "passing": passing, "mean_annual_error_pct": {"ratio": ratio, "model": model}}


def rule_text(n_regions, block):
    worse = sum(1 for s in block if s["annual_error_pct"]["model"] is not None
                and s["annual_error_pct"]["model"] > s["annual_error_pct"]["ratio"])
    return (
        f"model_v1 ships when, on the {span(CAL_YEARS)} leave-two-years-out folds, its mean"
        f" absolute annual error against MODIS is at most {ANNUAL_LIMIT_PCT:g}% and the Pearson"
        f" r of its monthly totals is at least {MIN_R:g} in at least {MIN_REGIONS} of the"
        f" {n_regions} regions, and its annual error averaged over the regions is lower than"
        " ratio_v1's; otherwise ratio_v1 ships. MODIS is counted on days the series VIIRS"
        " satellite observed. The model's two FRP interaction terms were chosen on these same"
        " folds, so its fold errors are slightly optimistic. On the"
        f" {span(BLOCK)} block, fitted on {span(CAL_YEARS)}, where MODIS orbit drift may bias"
        f" the truth, the model's annual error is higher than ratio_v1's in {worse} of"
        f" {len(block)} regions.")


def weighted_monthly(rows, amounts, factors, roles, days=None):
    """{(region_id, ym): sum of amount × factor} over the in-box entries of `amounts` (keyed
    like `rows.counts` and `model.sums`) whose role is in `roles` and, given `days`
    ({region index: set of days}), whose day is listed. `factors` is keyed like
    `modeling.weight_table`."""
    year, month = modeling.YEAR, modeling.MONTH
    out = defaultdict(float)
    for (ri, role, box, d), v in amounts.items():
        if box == 1 and role in roles and (days is None or d in days[ri]):
            out[rows.regions[ri], year[d] * 100 + month[d]] += v * factors[ri, month[d], role]
    return dict(out)


def factor_table(rows, factors):
    """`modeling.weight_table` for ratio factors {(region_id, month, satellite): (r, level)}."""
    return modeling.weight_table(rows, SimpleNamespace(k=factors))


def ratio_fit(rows, years):
    """ratio_v1 refitted by the P06 rule with the S-NPP ratio on `years` only:
    {(region_id, month, satellite): (factor, level)}."""
    veg, present = defaultdict(Counter), defaultdict(set)
    for (ri, role, box, d), n in rows.counts.items():
        satellite = modeling.VIIRS_ROLES[role]
        present[ri].add(satellite)
        if box:
            veg[rows.regions[ri], satellite][modeling.ISO[d]] += n
    # rows.modis holds Terra and Aqua together; fit_factors adds the two.
    for rid, days in rows.modis.items():
        veg[rid, "Terra"].update(days)
    coverage = rows.coverage()
    out = {}
    for ri, region in enumerate(rows.cfg["regions"]):
        factors, _ = series.fit_factors(region, rows.cfg, veg, coverage, present[ri], set(years))
        out.update({(region["id"], m, s): v for (m, s), v in factors.items()})
    return out


def refit(rows, years, fit, cap):
    """Monthly in-series in-box sums of both methods fitted on `years`, with the two fits."""
    ratio = ratio_fit(rows, years)
    model = fit(rows, list(years), cap)
    sums = {"ratio": weighted_monthly(rows, rows.counts, factor_table(rows, ratio),
                                      modeling.IN_SERIES_ROLES),
            "model": weighted_monthly(rows, model.sums, modeling.weight_table(rows, model),
                                      modeling.IN_SERIES_ROLES)}
    return sums, ratio, model


def both_observed_days(rows):
    """{region index: days} of N20_TRANSFER, from the region's first NOAA-20 data, on which
    both VIIRS satellites observed the region."""
    coverage = rows.coverage()
    last = modeling.day_of(config.N20_TRANSFER[1].isoformat())
    out = {}
    for ri, region in enumerate(rows.cfg["regions"]):
        rid = region["id"]
        first = modeling.day_of(max(config.N20_TRANSFER[0].isoformat(),
                                    series.n20_data_start(region, rows.cfg)))
        out[ri] = {d for d in range(first, last + 1)
                   if coverage.observed(rid, "S-NPP", modeling.ISO[d])
                   and coverage.observed(rid, "NOAA-20", modeling.ISO[d])}
    return out


def months_between(first_ym, last_ym):
    first, last = (f"{ym // 100}-{ym % 100:02d}-01" for ym in (first_ym, last_ym))
    return [y * 100 + m for y, m, _, _ in series.month_starts(first, last)]


def n20_seam(rows, amounts, factors, days):
    """{region_id: [{ym, snpp, n20}]}: harmonized in-box S-NPP and NOAA-20 on the days both
    observed, from the month of the first such day to the end of N20_TRANSFER."""
    snpp = weighted_monthly(rows, amounts, factors, {modeling.SNPP}, days)
    n20 = weighted_monthly(rows, amounts, factors, N20_ROLES, days)
    last = config.N20_TRANSFER[1].year * 100 + config.N20_TRANSFER[1].month
    out = {}
    for ri, rid in enumerate(rows.regions):
        if not days[ri]:
            out[rid] = []
            continue
        first = min(days[ri])
        out[rid] = [{"ym": ym, "snpp": snpp.get((rid, ym), 0.0), "n20": n20.get((rid, ym), 0.0)}
                    for ym in months_between(modeling.YEAR[first] * 100 + modeling.MONTH[first],
                                             last)]
    return out


def drift(rows, years):
    """Yearly in-box vegetation MODIS (Terra plus Aqua) rows per S-NPP row, both counted on
    days S-NPP observed, the basis of the S-NPP ratio factor."""
    coverage = rows.coverage()
    out = []
    for ri, rid in enumerate(rows.regions):
        modis, snpp = Counter(), Counter()
        for day, n in rows.modis.get(rid, {}).items():
            if coverage.observed(rid, "S-NPP", day):
                modis[int(day[:4])] += n
        for (r, role, box, d), n in rows.counts.items():
            if (r == ri and role == modeling.SNPP and box
                    and coverage.observed(rid, "S-NPP", modeling.ISO[d])):
                snpp[modeling.YEAR[d]] += n
        out += [{"region_id": rid, "year": y,
                 "modis_snpp_ratio": round(modis[y] / snpp[y], 4) if snpp[y] else None}
                for y in years]
    return out


def _round(x, digits):
    return None if x is None else round(x, digits)


def rounded(scores):
    return {"region_id": scores["region_id"],
            "annual_error_pct": {m: _round(v, 2) for m, v in scores["annual_error_pct"].items()},
            "monthly_r": {m: _round(v, 4) for m, v in scores["monthly_r"].items()}}


def validate(rows, fit=modeling.fit, cap=modeling.SAMPLE_CAP, log=print):
    """Every fold, score and artifact. `fit(rows, years, cap)` returns an object with `sums` and
    `k` as `modeling.fit` does."""
    started = time.monotonic()
    modis = modeling.modis_on_series_days(rows)
    raw = modeling.counts_by_month(rows)
    predicted = {"ratio": {}, "model": {}}
    fold_of = {}

    def keep(sums, train, target):
        for method, table in sums.items():
            predicted[method].update({key: v for key, v in table.items()
                                      if key[1] // 100 in target})
        fold_of.update(dict.fromkeys(target, span(target)))
        log(f"fitted on {', '.join(map(str, train))}; predicted {span(target)}"
            f" ({time.monotonic() - started:.0f} s)")

    for held in FOLDS:
        train = [y for y in CAL_YEARS if y not in held]
        keep(refit(rows, train, fit, cap)[0], train, held)
    sums, ratio, model = refit(rows, CAL_YEARS, fit, cap)
    keep(sums, CAL_YEARS, BLOCK)

    months = {}
    for rid in rows.regions:
        months[rid] = [{"ym": ym, "modis": modis.get((rid, ym), 0),
                        "viirs_raw": raw.get((rid, ym), 0),
                        "ratio": predicted["ratio"].get((rid, ym), 0.0),
                        "model": predicted["model"].get((rid, ym), 0.0),
                        "fold": fold_of[ym // 100]}
                       for ym in months_between(YEARS[0] * 100 + 1, YEARS[-1] * 100 + 12)]
    lyo = [region_scores(rid, [m for m in months[rid] if m["ym"] // 100 in CAL_YEARS])
           for rid in rows.regions]
    block = [region_scores(rid, [m for m in months[rid] if m["ym"] // 100 in BLOCK])
             for rid in rows.regions]
    decision = decide(lyo)
    decision["rule"] = rule_text(len(rows.regions), block)

    days = both_observed_days(rows)
    n20 = {"ratio": n20_seam(rows, rows.counts, factor_table(rows, ratio), days),
           "model": n20_seam(rows, model.sums, modeling.weight_table(rows, model), days)}
    n20_scores = {method: {rid: score(table, "n20", "snpp") for rid, table in by_region.items()
                           if table}
                  for method, by_region in n20.items()}
    shipped = SHIPS[decision["method"]]

    summary = {
        "decision": {k: decision[k] for k in ("method", "passed_regions", "rule")},
        "lyo_2012_2019": [rounded(s) for s in lyo],
        "block_2020_2025": [rounded(s) for s in block],
        "n20_seam": [{"region_id": rid, "annual_error_pct": _round(e, 2), "monthly_r": _round(r, 4)}
                     for rid, (e, r) in n20_scores[shipped].items()],
        "drift": drift(rows, YEARS),
    }
    regions = {rid: {
        "months": [{**m, "ratio": round(m["ratio"], 3), "model": round(m["model"], 3)}
                   for m in months[rid]],
        "n20": [{"ym": m["ym"], "snpp": round(m["snpp"], 3), "n20": round(m["n20"], 3)}
                for m in n20[shipped][rid]]} for rid in rows.regions}
    return {"summary": summary, "regions": regions,
            "decision": {**decision, "n20_method": shipped},
            "n20_scores": n20_scores, "ratio_full": ratio, "k_full": model.k,
            "seconds": round(time.monotonic() - started, 1)}


def read_factors(con, table, column):
    try:
        return {(r, m, s): (v, level) for r, m, s, v, level in con.execute(
            f"SELECT region_id, month, satellite, {column}, level FROM {table}")}
    except sqlite3.OperationalError:
        return None


def compare(fitted, shipped):
    """(largest relative difference, keys missing on either side or with another level)."""
    if shipped is None:
        return None, len(fitted)
    worst, mismatched = 0.0, len(set(shipped) - set(fitted))
    for key, (value, level) in fitted.items():
        other = shipped.get(key)
        if other is None or other[1] != level:
            mismatched += 1
        else:
            worst = max(worst, abs(value - other[0]) / abs(other[0]))
    return worst, mismatched


def write(con, result):
    """Replace every `validation:*` artifact in one transaction."""
    with con:
        con.execute("BEGIN")
        con.execute("DELETE FROM artifacts WHERE name LIKE 'validation:%'")
        db.put_artifact("validation:summary", result["summary"], con)
        db.put_artifact("validation:decision", result["decision"], con)
        for rid, value in result["regions"].items():
            db.put_artifact(f"validation:{rid}", value, con)


def _pct(x):
    return "-" if x is None else f"{x:.1f}%"


def _r(x):
    return "-" if x is None else f"{x:.3f}"


def _signed(x):
    return "-" if x is None else f"{x:+.1f}%"


def print_scorecard(result):
    summary, decision = result["summary"], result["decision"]
    print("\nannual err = mean absolute annual total error against MODIS; r = Pearson r of"
          " monthly totals.\nMODIS counts in-box vegetation rows on days the series VIIRS"
          " satellite observed.")
    sections = ((f"leave-two-years-out {span(CAL_YEARS)} (folds "
                 + ", ".join(span(f) for f in FOLDS) + ")", "lyo_2012_2019"),
                (f"{span(BLOCK)} block, fitted on {span(CAL_YEARS)} (MODIS orbit drift may bias it)",
                 "block_2020_2025"))
    passing = set(decision["passing"])
    for title, key in sections:
        print(f"\n{title}\n{'region':<13} {'raw err':>8} {'ratio err':>9} {'model err':>9}"
              f" {'raw r':>6} {'ratio r':>7} {'model r':>7}"
              + (" model passes" if key == "lyo_2012_2019" else ""))
        for s in summary[key]:
            e, r = s["annual_error_pct"], s["monthly_r"]
            print(f"{s['region_id']:<13} {_pct(e['raw']):>8} {_pct(e['ratio']):>9}"
                  f" {_pct(e['model']):>9} {_r(r['raw']):>6} {_r(r['ratio']):>7}"
                  f" {_r(r['model']):>7}"
                  + (f" {'yes' if s['region_id'] in passing else 'no':>12}"
                     if key == "lyo_2012_2019" else ""))

    print("\nannual totals (2012-2019: each year predicted by the fold that held it out)")
    for rid, value in result["regions"].items():
        print(f"\n{rid}\n{'year':<6} {'fold':<10} {'MODIS':>8} {'VIIRS raw':>10} {'ratio':>10}"
              f" {'model':>10} {'ratio err':>9} {'model err':>9}")
        years = defaultdict(Counter)
        for m in value["months"]:
            years[m["ym"] // 100, m["fold"]].update(
                {k: m[k] for k in ("modis", "viirs_raw", "ratio", "model")})
        for (year, fold), t in sorted(years.items()):
            err = {k: (t[k] - t["modis"]) / t["modis"] * 100 if t["modis"] else None
                   for k in ("ratio", "model")}
            print(f"{year:<6} {fold:<10} {t['modis']:>8,} {t['viirs_raw']:>10,}"
                  f" {t['ratio']:>10,.1f} {t['model']:>10,.1f}"
                  f" {_signed(err['ratio']):>9} {_signed(err['model']):>9}")

    first = {rid: v["n20"][0]["ym"] for rid, v in result["regions"].items() if v["n20"]}
    print(f"\nNOAA-20 seam: harmonized NOAA-20 against harmonized S-NPP on days both observed,"
          f" to {config.N20_TRANSFER[1].isoformat()[:7]}; the artifact uses"
          f" {decision['method']}\n{'region':<13} {'from':>7} {'ratio err':>9} {'ratio r':>7}"
          f" {'model err':>9} {'model r':>7}")
    scores = result["n20_scores"]
    for rid in result["regions"]:
        if rid not in first:
            print(f"{rid:<13} no NOAA-20 data")
            continue
        (re, rr), (me, mr) = scores["ratio"][rid], scores["model"][rid]
        print(f"{rid:<13} {first[rid] // 100}-{first[rid] % 100:02d} {_pct(re):>9} {_r(rr):>7}"
              f" {_pct(me):>9} {_r(mr):>7}")

    print("\ndrift: yearly MODIS / S-NPP vegetation rows (in box, days S-NPP observed)\n"
          f"{'region':<13}" + "".join(f" {y:>5}" for y in YEARS))
    by_region = defaultdict(dict)
    for d in summary["drift"]:
        by_region[d["region_id"]][d["year"]] = d["modis_snpp_ratio"]
    for rid, values in by_region.items():
        print(f"{rid:<13}" + "".join(f" {_r(values.get(y)):>5}" for y in YEARS))

    mean = decision["mean_annual_error_pct"]
    print(f"\ndecision: {decision['method']} ships. model_v1 passes both limits in"
          f" {decision['passed_regions']} of {len(summary['lyo_2012_2019'])} regions"
          f" ({', '.join(decision['passing']) or 'none'}); mean annual error {span(CAL_YEARS)}:"
          f" model {_pct(mean['model'])}, ratio {_pct(mean['ratio'])}")
    print(f"rule: {decision['rule']}")


def add_arguments(parser):
    parser.add_argument("--cap", type=int, default=modeling.SAMPLE_CAP,
                        help=f"most matchups in each fold's fit sample"
                             f" (default {modeling.SAMPLE_CAP:,})")
    parser.add_argument("--dry-run", action="store_true",
                        help="validate and print without writing the artifacts")


def run(args):
    started = time.monotonic()
    cfg = config.load_config()
    con = db.connect()
    log = lambda line: print(line, flush=True)
    try:
        version = hotspots_version(con)
        rows = modeling.load(con, cfg, log=log)
        check_hotspots(con, version)
        result = validate(rows, cap=args.cap, log=log)
        checks = {"ratio_factors": compare(result["ratio_full"],
                                           read_factors(con, "ratio_factors", "factor")),
                  "k_factors": compare(result["k_full"], read_factors(con, "k_factors", "k"))}
        check_hotspots(con, version)
        if args.dry_run:
            print("dry run: nothing written")
        else:
            write(con, result)
            print(f"wrote validation:summary, validation:decision and"
                  f" {len(result['regions'])} validation:<region_id> artifacts")
    except HotspotsNotReady:
        print("validate: hotspots is being rebuilt, or was rebuilt while this step ran;"
              " rerun validate after normalize finishes")
        return 1
    finally:
        con.close()
    print_scorecard(result)
    print(f"\n{span(CAL_YEARS)} refit against the shipped tables: " + "; ".join(
        f"{name} {'missing' if worst is None else f'max relative difference {worst:.1e}'}"
        + (f", {bad} factors missing or at another level" if bad else "")
        for name, (worst, bad) in checks.items()))
    print(f"time: load {rows.stats['seconds']} s, folds {result['seconds']} s,"
          f" total {time.monotonic() - started:.0f} s; peak RSS {peak_rss_mb()} MB")
    return 0
