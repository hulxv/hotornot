import json
import os
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from hotornot import cli, db, modeling
from hotornot.steps import series, validate

CFG = {
    "regions": [{"id": "delta", "history": "country_files"},
                {"id": "calif", "history": "api"}],
    "firms_api": {"NOAA-20": {"start": "2023-01-01"}},
    "firms_country": {"viirs-jpss1": [2018, 2025]},
}
SNPP = modeling.SNPP
N20_OVERLAP = series.ROLE_INDEX["n20_overlap"]
CAL = list(range(2012, 2020))


def toy_rows(snpp_per_modis=lambda year: 4):
    """Two days a month, 2012 to 2025. S-NPP has `snpp_per_modis(year)` rows per MODIS row and
    NOAA-20 twice as many as S-NPP, from 2018-04 in delta and 2023-01 in calif."""
    rows = modeling.Rows([r["id"] for r in CFG["regions"]], [modeling.UNKNOWN])
    rows.cfg = CFG
    rows.fill = {rid: set() for rid in rows.regions}
    for ri, region in enumerate(CFG["regions"]):
        rid = region["id"]
        rows.modis[rid] = Counter()
        n20_from = series.n20_data_start(region, CFG)
        for year in range(2012, 2026):
            for month in range(1, 13):
                for day in (1, 15):
                    iso = f"{year}-{month:02d}-{day:02d}"
                    d = modeling.day_of(iso)
                    modis = 10 + month + year % 3 + ri
                    snpp = snpp_per_modis(year) * modis
                    rows.modis[rid][iso] += modis
                    rows.counts[ri, SNPP, 1, d] += snpp
                    rows.counts[ri, SNPP, 0, d] += 7
                    rows.row_days[rid, "S-NPP"].add(iso)
                    if iso >= n20_from:
                        rows.counts[ri, N20_OVERLAP, 1, d] += 2 * snpp
                        rows.row_days[rid, "NOAA-20"].add(iso)
    return rows


def fake_fit(calls):
    """A stand-in for modeling.fit: s = 0.5 for every row, so k = 0.5 (S-NPP) and 0.25
    (NOAA-20) give MODIS back exactly. A fold fit scales k by 1 + (first held-out year % 100) /
    1000, so every prediction shows which fit made it."""
    def fit(rows, years, cap):
        calls.append((list(years), cap))
        held = sorted(set(CAL) - set(years))
        scale = 1 + (held[0] % 100) / 1000 if held else 1.0
        k = {(rid, m, s): (base * scale, "region_month") for rid in rows.regions
             for m in range(1, 13) for s, base in (("S-NPP", 0.5), ("NOAA-20", 0.25))}
        return SimpleNamespace(sums={key: 0.5 * n for key, n in rows.counts.items()}, k=k)
    return fit


def scores(region_id, model_error, model_r, ratio_error=10.0):
    return {"region_id": region_id,
            "annual_error_pct": {"raw": 300.0, "ratio": ratio_error, "model": model_error},
            "monthly_r": {"raw": 0.95, "ratio": 0.95, "model": model_r}}


class Metrics(unittest.TestCase):
    def test_annual_error(self):
        self.assertAlmostEqual(validate.annual_error_pct({2012: 110, 2013: 90, 2014: 100},
                                                         {2012: 100, 2013: 100, 2014: 100}),
                               20 / 3)
        self.assertAlmostEqual(validate.annual_error_pct({2012: 50}, {2012: 100, 2013: 40}),
                               75.0)
        self.assertAlmostEqual(validate.annual_error_pct({2012: 5, 2013: 12}, {2012: 0, 2013: 10}),
                               20.0)
        self.assertIsNone(validate.annual_error_pct({2012: 5}, {2012: 0}))
        self.assertIsNone(validate.annual_error_pct({}, {}))

    def test_pearson(self):
        self.assertAlmostEqual(validate.pearson([1, 2, 3, 4], [1, 3, 2, 4]), 0.8)
        self.assertAlmostEqual(validate.pearson([1, 2, 3], [10, 20, 30]), 1.0)
        self.assertAlmostEqual(validate.pearson([1, 2, 3], [5, 3, 1]), -1.0)
        self.assertIsNone(validate.pearson([1, 2, 3], [4, 4, 4]))
        self.assertIsNone(validate.pearson([1], [2]))

    def test_score_sums_months_into_years(self):
        months = [{"ym": 201201, "p": 30, "t": 10}, {"ym": 201202, "p": 0, "t": 10},
                  {"ym": 201301, "p": 9, "t": 10}, {"ym": 201302, "p": 9, "t": 10}]
        error, r = validate.score(months, "p", "t")
        self.assertAlmostEqual(error, (50 + 10) / 2)
        self.assertIsNone(r)
        months[1]["t"] = 0
        self.assertAlmostEqual(validate.score(months, "p", "t")[1],
                               validate.pearson([30, 0, 9, 9], [10, 0, 10, 10]))


class Decision(unittest.TestCase):
    def test_model_ships_with_three_passing_regions_and_lower_error(self):
        lyo = [scores("a", 5.0, 0.95), scores("b", 8.0, 0.92), scores("c", 15.0, 0.9),
               scores("d", 30.0, 0.95, ratio_error=40.0)]
        d = validate.decide(lyo)
        self.assertEqual((d["method"], d["passed_regions"], d["passing"]),
                         ("model_v1", 3, ["a", "b", "c"]))
        self.assertAlmostEqual(d["mean_annual_error_pct"]["model"], 14.5)
        self.assertAlmostEqual(d["mean_annual_error_pct"]["ratio"], 17.5)

    def test_limits_are_inclusive(self):
        self.assertTrue(validate.passes(scores("a", 15.0, 0.9)))
        self.assertFalse(validate.passes(scores("a", 15.01, 0.95)))
        self.assertFalse(validate.passes(scores("a", 5.0, 0.8999)))
        self.assertFalse(validate.passes(scores("a", None, 0.95)))
        self.assertFalse(validate.passes(scores("a", 5.0, None)))

    def test_two_passing_regions_are_not_enough(self):
        lyo = [scores("a", 5.0, 0.95), scores("b", 5.0, 0.95), scores("c", 16.0, 0.95),
               scores("d", 5.0, 0.85)]
        d = validate.decide(lyo)
        self.assertEqual((d["method"], d["passed_regions"]), ("ratio_v1", 2))

    def test_model_must_beat_the_ratio(self):
        lyo = [scores(r, 6.0, 0.95, ratio_error=5.0) for r in "abcd"]
        self.assertEqual(validate.decide(lyo)["method"], "ratio_v1")
        lyo = [scores(r, 5.0, 0.95, ratio_error=5.0) for r in "abcd"]
        self.assertEqual(validate.decide(lyo)["method"], "ratio_v1")
        lyo[0]["annual_error_pct"]["model"] = 4.9
        self.assertEqual(validate.decide(lyo)["method"], "model_v1")

    def test_no_model(self):
        d = validate.decide([scores(r, None, None) for r in "abcd"])
        self.assertEqual((d["method"], d["passed_regions"]), ("ratio_v1", 0))
        self.assertIsNone(d["mean_annual_error_pct"]["model"])

    def test_rule_text_counts_block_regions_where_the_model_is_worse(self):
        block = [scores("a", 12.0, 0.9, ratio_error=10.0), scores("b", 8.0, 0.9),
                 scores("c", None, None)]
        text = validate.rule_text(4, block)
        self.assertIn("at most 15% and the Pearson r of its monthly totals is at least 0.9"
                      " in at least 3 of the 4 regions", text)
        self.assertIn("higher than ratio_v1's in 1 of 3 regions", text)


class Refits(unittest.TestCase):
    def test_ratio_fit_uses_only_the_training_years(self):
        rows = toy_rows(lambda year: 2 if year in (2012, 2013) else 4)
        held_out = validate.ratio_fit(rows, range(2014, 2020))
        full = validate.ratio_fit(rows, CAL)
        for rid in rows.regions:
            for m in range(1, 13):
                self.assertAlmostEqual(held_out[rid, m, "S-NPP"][0], 0.25)
                self.assertEqual(held_out[rid, m, "S-NPP"][1], "region_month")
                ri = rows.regions.index(rid)
                modis = [10 + m + y % 3 + ri for y in CAL]
                snpp = [(2 if y in (2012, 2013) else 4) * n for y, n in zip(CAL, modis)]
                self.assertAlmostEqual(full[rid, m, "S-NPP"][0], sum(modis) / sum(snpp))
                # The NOAA-20 transfer always spans N20_TRANSFER, whatever the years.
                self.assertAlmostEqual(held_out[rid, m, "NOAA-20"][0], 0.25 * 0.5)

    def test_ratio_fit_matches_the_series_rule(self):
        rows = toy_rows()
        veg = {}
        for (ri, role, box, d), n in rows.counts.items():
            if box:
                key = rows.regions[ri], modeling.VIIRS_ROLES[role]
                veg.setdefault(key, Counter())[modeling.ISO[d]] += n
        for rid in rows.regions:
            veg[rid, "Terra"] = rows.modis[rid]
            veg[rid, "Aqua"] = Counter()
        fitted = validate.ratio_fit(rows, CAL)
        for region in CFG["regions"]:
            factors, _ = series.fit_factors(region, CFG, veg, rows.coverage(),
                                            {"S-NPP", "NOAA-20"})
            self.assertEqual(len(factors), 24)
            for (m, s), value in factors.items():
                self.assertEqual(fitted[region["id"], m, s], value)

    def test_both_observed_days(self):
        rows = toy_rows()
        rows.granules = {("delta", "S-NPP"): {"2019-06-15": 0},
                         ("delta", "NOAA-20"): {"2019-07-01": 0}}
        days = validate.both_observed_days(rows)
        iso = {ri: {modeling.ISO[d] for d in ds} for ri, ds in days.items()}
        self.assertEqual(min(iso[0]), "2018-04-01")
        self.assertEqual(max(iso[0]), "2025-12-15")
        self.assertNotIn("2019-06-15", iso[0])
        self.assertNotIn("2019-07-01", iso[0])
        self.assertIn("2019-06-01", iso[0])
        self.assertEqual(len(iso[0]), 93 * 2 - 2)
        self.assertEqual((min(iso[1]), len(iso[1])), ("2023-01-01", 36 * 2))


class Validate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.calls = []
        cls.rows = toy_rows()
        cls.result = validate.validate(cls.rows, fit=fake_fit(cls.calls), cap=1234,
                                       log=lambda line: None)

    def test_one_fit_per_fold_then_the_full_fit(self):
        self.assertEqual(self.calls, [
            ([2014, 2015, 2016, 2017, 2018, 2019], 1234),
            ([2012, 2013, 2016, 2017, 2018, 2019], 1234),
            ([2012, 2013, 2014, 2015, 2018, 2019], 1234),
            ([2012, 2013, 2014, 2015, 2016, 2017], 1234),
            (CAL, 1234)])

    def test_monthly_rows(self):
        months = self.result["regions"]["delta"]["months"]
        self.assertEqual(len(months), 14 * 12)
        self.assertEqual([m["ym"] for m in months[:13]],
                         list(range(201201, 201213)) + [201301])
        self.assertEqual(months[-1]["ym"], 202512)
        folds = Counter(m["fold"] for m in months)
        self.assertEqual(folds, {"2012-2013": 24, "2014-2015": 24, "2016-2017": 24,
                                 "2018-2019": 24, "2020-2025": 72})
        for m in months:
            self.assertEqual(set(m), {"ym", "modis", "viirs_raw", "ratio", "model", "fold"})
            year, month = divmod(m["ym"], 100)
            modis = 2 * (10 + month + year % 3)
            self.assertEqual((m["modis"], m["viirs_raw"]), (modis, 4 * modis))
            self.assertAlmostEqual(m["ratio"], modis, places=6)
            scale = 1 + (int(m["fold"][:4]) % 100) / 1000 if year < 2020 else 1.0
            self.assertAlmostEqual(m["model"], modis * scale, places=3)
            self.assertTrue(m["fold"][:4] <= str(year) <= m["fold"][5:])

    def test_scores(self):
        summary = self.result["summary"]
        lyo = {s["region_id"]: s for s in summary["lyo_2012_2019"]}
        block = {s["region_id"]: s for s in summary["block_2020_2025"]}
        self.assertEqual(list(lyo), ["delta", "calif"])
        for rid in lyo:
            self.assertEqual(lyo[rid]["annual_error_pct"],
                             {"raw": 300.0, "ratio": 0.0, "model": 1.5})
            self.assertEqual(block[rid]["annual_error_pct"],
                             {"raw": 300.0, "ratio": 0.0, "model": 0.0})
            self.assertEqual(lyo[rid]["monthly_r"]["raw"], 1.0)
            self.assertEqual(lyo[rid]["monthly_r"]["ratio"], 1.0)
            self.assertGreater(lyo[rid]["monthly_r"]["model"], 0.999)

    def test_decision(self):
        decision = self.result["summary"]["decision"]
        self.assertEqual(set(decision), {"method", "passed_regions", "rule"})
        self.assertEqual((decision["method"], decision["passed_regions"]), ("ratio_v1", 2))
        self.assertEqual(self.result["decision"]["n20_method"], "ratio")
        self.assertIn("higher than ratio_v1's in 0 of 2 regions", decision["rule"])

    def test_n20_seam(self):
        regions = self.result["regions"]
        delta, calif = regions["delta"]["n20"], regions["calif"]["n20"]
        self.assertEqual((delta[0]["ym"], delta[-1]["ym"], len(delta)), (201804, 202512, 93))
        self.assertEqual((calif[0]["ym"], calif[-1]["ym"], len(calif)), (202301, 202512, 36))
        for m in delta + calif:
            self.assertEqual(set(m), {"ym", "snpp", "n20"})
            self.assertAlmostEqual(m["snpp"], m["n20"], places=6)
            self.assertGreater(m["snpp"], 0)
        self.assertEqual(self.result["summary"]["n20_seam"],
                         [{"region_id": "delta", "annual_error_pct": 0.0, "monthly_r": 1.0},
                          {"region_id": "calif", "annual_error_pct": 0.0, "monthly_r": 1.0}])

    def test_drift(self):
        drift = self.result["summary"]["drift"]
        self.assertEqual(len(drift), 2 * 14)
        self.assertEqual(drift[0], {"region_id": "delta", "year": 2012, "modis_snpp_ratio": 0.25})
        self.assertEqual({d["modis_snpp_ratio"] for d in drift}, {0.25})

    def test_artifact_shapes(self):
        summary = self.result["summary"]
        self.assertEqual(list(summary), ["decision", "lyo_2012_2019", "block_2020_2025",
                                         "n20_seam", "drift"])
        for key in ("lyo_2012_2019", "block_2020_2025"):
            for s in summary[key]:
                self.assertEqual(set(s), {"region_id", "annual_error_pct", "monthly_r"})
                self.assertEqual(set(s["annual_error_pct"]), {"raw", "ratio", "model"})
        self.assertEqual(set(self.result["regions"]["delta"]), {"months", "n20"})
        json.dumps(self.result["summary"], allow_nan=False)
        json.dumps(self.result["regions"], allow_nan=False)
        json.dumps(self.result["decision"], allow_nan=False)


class Artifacts(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = mock.patch.dict(os.environ, {"HOTORNOT_DB": str(Path(tmp.name) / "t.sqlite")})
        env.start()
        self.addCleanup(env.stop)
        self.con = db.connect()
        self.addCleanup(self.con.close)

    def test_write_replaces_every_validation_artifact(self):
        db.put_artifact("validation:atlantis", {"months": []}, self.con)
        db.put_artifact("model:report", {"kept": True}, self.con)
        result = {"summary": {"s": 1}, "decision": {"method": "ratio_v1"},
                  "regions": {"delta": {"months": [], "n20": []}}}
        validate.write(self.con, result)
        validate.write(self.con, result)
        names = [n for (n,) in self.con.execute("SELECT name FROM artifacts ORDER BY name")]
        self.assertEqual(names, ["model:report", "validation:decision", "validation:delta",
                                 "validation:summary"])
        self.assertEqual(db.get_artifact("validation:decision", self.con), {"method": "ratio_v1"})

    def test_compare_with_shipped_factors(self):
        fitted = {("a", 1, "S-NPP"): (0.2, "region_month"), ("a", 2, "S-NPP"): (0.3, "region_month")}
        with self.con:
            self.con.execute("CREATE TABLE ratio_factors (region_id, month, satellite, factor,"
                             " level)")
            self.con.executemany("INSERT INTO ratio_factors VALUES (?, ?, ?, ?, ?)",
                                 [("a", 1, "S-NPP", 0.25, "region_month"),
                                  ("a", 2, "S-NPP", 0.3, "pooled_3month"),
                                  ("a", 3, "S-NPP", 0.3, "region_month")])
        shipped = validate.read_factors(self.con, "ratio_factors", "factor")
        worst, bad = validate.compare(fitted, shipped)
        self.assertAlmostEqual(worst, 0.2)
        self.assertEqual(bad, 2)
        self.assertIsNone(validate.read_factors(self.con, "k_factors", "k"))
        self.assertEqual(validate.compare(fitted, None), (None, 2))

    def test_step_is_discovered(self):
        self.assertIn("validate", cli.discover_steps())
