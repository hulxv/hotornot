import contextlib
import hashlib
import io
import itertools
import math
import os
import random
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from unittest import mock

from hotornot import cli, db, geo, modeling
from hotornot.steps import coverage, matchups, model, normalize, series, static_mask

CFG = {
    "regions": [{"id": "delta", "history": "country_files"},
                {"id": "calif", "history": "api"}],
    "firms_api": {"NOAA-20": {"start": "2023-01-01"}},
    "firms_country": {"viirs-jpss1": [2018, 2025]},
}
KM = 1 / geo.KM_PER_DEG
# Matchup labels in the fixture are exactly sigmoid(TRUE . terms), so the fit must give back
# these raw coefficients: intercept, then modeling.TERMS in order.
TRUE = (-2.0, 0.9, -1.5, 0.4, -0.6, 0.3, -0.2)


def sigmoid(x):
    return 1 / (1 + math.exp(-x))


class Clusters(unittest.TestCase):
    def test_radius_and_window(self):
        points = [(0, 30.0, 31.0), (0, 30 + 0.9 * KM, 31.0), (0, 30 + 1.8 * KM, 31.0),
                  (10, 30.0, 31.0 + 0.5 * KM / math.cos(math.radians(30))),
                  (20, 30.0, 31.0 + 0.5 * KM / math.cos(math.radians(30))),
                  (31, 30.0, 31.0)]
        # The 10-minute window is inclusive and pairwise: 0 and 20 are chained through 10 but
        # are not neighbours.
        self.assertEqual(modeling.cluster_sizes(points), [3, 3, 2, 3, 2, 1])
        self.assertEqual(modeling.cluster_sizes(list(reversed(points))), [1, 2, 3, 2, 3, 3])

    def test_longitude_is_scaled_by_latitude(self):
        east = KM / math.cos(math.radians(40))
        self.assertEqual(modeling.cluster_sizes([(0, 40.0, 10.0), (0, 40.0, 10 + 0.98 * east)]),
                         [2, 2])
        self.assertEqual(modeling.cluster_sizes([(0, 40.0, 10.0), (0, 40.0, 10 + 1.02 * east)]),
                         [1, 1])
        self.assertEqual(modeling.cluster_sizes([(0, -40.0, 10.0), (0, -40.0, 10 + 0.98 * east)]),
                         [2, 2])

    def test_dense_cluster(self):
        points = [(5, 30 + i * 0.4 * KM, 31.0) for i in range(4)]
        self.assertEqual(modeling.cluster_sizes(points), [3, 4, 4, 3])


class Fit(unittest.TestCase):
    def test_closed_form_with_fractional_labels(self):
        # One binary feature: the MLE intercept is the logit of the mean label where x = 0, and
        # the slope is the difference of the two logits.
        x = [0.0] * 4 + [1.0] * 4
        y = [0.0, 0.25, 0.5, 0.25, 1.0, 0.5, 0.75, 0.75]
        index, targets, weights = modeling.doubled(y)
        beta, info = modeling.logistic_irls([[x[i] for i in index]], targets, weights)
        logit = lambda p: math.log(p / (1 - p))
        self.assertTrue(info["converged"])
        self.assertAlmostEqual(beta[0], logit(0.25), places=9)
        self.assertAlmostEqual(beta[1], logit(0.75) - logit(0.25), places=9)

    def test_doubling_matches_replicated_rows(self):
        rng = random.Random(3)
        x1 = [rng.gauss(0, 1) for _ in range(300)]
        x2 = [float(rng.random() < 0.4) for _ in range(300)]
        y = [rng.choice((0.0, 0.25, 0.5, 1.0)) for _ in range(300)]
        index, targets, weights = modeling.doubled(y)
        a, _ = modeling.logistic_irls([[x1[i] for i in index], [x2[i] for i in index]],
                                      targets, weights)
        rx1, rx2, ry = [], [], []
        for i in range(300):
            for k in range(4):
                rx1.append(x1[i])
                rx2.append(x2[i])
                ry.append(1.0 if k < round(4 * y[i]) else 0.0)
        b, _ = modeling.logistic_irls([rx1, rx2], ry, [1.0] * len(ry))
        for u, v in zip(a, b):
            self.assertAlmostEqual(u, v, places=8)

    def test_doubled_rows(self):
        self.assertEqual(modeling.doubled([0.0, 1.0, 0.25]),
                         ([0, 1, 2, 2], [0.0, 1.0, 1.0, 0.0], [1.0, 1.0, 0.25, 0.75]))

    def test_recovers_coefficients(self):
        rng = random.Random(11)
        x = [rng.gauss(0, 1) for _ in range(20_000)]
        y = [float(rng.random() < sigmoid(-1 + 2 * v)) for v in x]
        beta, _ = modeling.logistic_irls([x], y, [1.0] * len(y))
        self.assertAlmostEqual(beta[0], -1, delta=0.08)
        self.assertAlmostEqual(beta[1], 2, delta=0.1)

    def test_solve(self):
        x = modeling.solve([[0.0, 2.0, 1.0], [1.0, 1.0, 0.0], [3.0, 0.0, 1.0]], [5.0, 3.0, 4.0])
        for u, v in zip(x, [1.0, 2.0, 1.0]):
            self.assertAlmostEqual(u, v)
        with self.assertRaises(ValueError):
            modeling.solve([[1.0, 2.0], [2.0, 4.0]], [1.0, 2.0])

    def test_allocate(self):
        self.assertEqual(modeling.allocate({"a": 50, "b": 30, "c": 20}, 10),
                         {"a": 5, "b": 3, "c": 2})
        self.assertEqual(modeling.allocate({"a": 1, "b": 1, "c": 1}, 2), {"a": 1, "b": 1, "c": 0})
        self.assertEqual(modeling.allocate({"a": 7, "b": 2}, 100), {"a": 7, "b": 2})
        out = modeling.allocate({("r", y): 1000 + 37 * y for y in range(8)}, 999)
        self.assertEqual(sum(out.values()), 999)

    def test_features(self):
        self.assertAlmostEqual(modeling.log_frp(-1.52), math.log(0.1))
        self.assertAlmostEqual(modeling.log_frp(0.0), math.log(0.1))
        self.assertAlmostEqual(modeling.log_frp(12.65), math.log(12.65))
        grid = modeling.frp_grid()
        self.assertEqual((len(grid), grid[0], grid[10], grid[20], grid[-1]),
                         (41, 0.1, 1.0, 10.0, 1000.0))


class Step(unittest.TestCase):
    land = False

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = mock.patch.dict(os.environ, {"HOTORNOT_DB": str(Path(tmp.name) / "t.sqlite")})
        env.start()
        self.addCleanup(env.stop)
        patch = mock.patch.object(model.config, "load_config", return_value=CFG)
        patch.start()
        self.addCleanup(patch.stop)
        self.con = db.connect()
        self.addCleanup(self.con.close)
        with self.con:
            db.recreate(self.con, normalize.DDL)
            db.recreate(self.con, coverage.DDL)
            db.recreate(self.con, static_mask.DDL)
            self.con.execute(matchups.DDL)
            if self.land:
                self.con.execute("CREATE TABLE land_cover (hotspot_id TEXT PRIMARY KEY,"
                                 " igbp INTEGER, class7 TEXT) WITHOUT ROWID")
        self.ids = itertools.count()
        self.expected = {}
        self.fixture()
        with self.con:
            for ddl in normalize.INDEXES_AFTER_LOAD.values():
                self.con.execute(ddl)

    def add(self, region, satellite, utc, lat=30.6, lon=31.2, frp=1.5, scan=0.4, track=0.4,
            daynight="D", fire_type=0, processing="SP", in_box=1, masked=False, n=1):
        ids = []
        for _ in range(n):
            hid = hashlib.sha1(str(next(self.ids)).encode()).hexdigest()[:16]
            sensor = "MODIS" if satellite in ("Terra", "Aqua") else "VIIRS_375"
            day = utc[:10]
            with self.con:
                self.con.execute(
                    f"INSERT INTO hotspots VALUES ({', '.join('?' * len(normalize.COLUMNS))})",
                    (hid, region, in_box, satellite, sensor, utc, day, int(day[:4] + day[5:7]),
                     lat, lon, daynight, frp, scan, track, "n",
                     None if processing == "NRT" else fire_type, processing, 17370624,
                     "n30e031", 1))
                if masked:
                    self.con.execute("INSERT INTO static_mask VALUES (?, 'persistent')", (hid,))
            ids.append(hid)
        return ids

    def viirs(self, region, satellite, utc, cluster=1, **kw):
        """A vegetation VIIRS row whose features are known, kept in self.expected."""
        ids = self.add(region, satellite, utc, **kw)
        for hid in ids:
            self.expected[hid] = (region, satellite, utc[:10], kw.get("in_box", 1), (
                modeling.log_frp(kw.get("frp", 1.5)), kw.get("scan", 0.4) * kw.get("track", 0.4),
                int(kw.get("daynight", "D") == "N"), cluster))
        return ids

    def cover(self, region, satellite, granules, *days):
        with self.con:
            self.con.executemany("INSERT OR REPLACE INTO coverage_daily VALUES (?, ?, ?, ?)",
                                 [(region, d, satellite, granules) for d in days])

    def fixture(self):
        rng = random.Random(7)
        self.labels = {}
        self.classes = {}
        for f in range(120):
            size = rng.choice((1, 1, 2, 3))
            night = rng.random() < 0.4
            scan, track = rng.choice(((0.32, 0.36), (0.39, 0.36), (0.46, 0.39), (0.55, 0.5),
                                      (0.8, 0.78)))
            lat, lon = 30 + (f // 20) * 0.05, 31 + (f % 20) * 0.05
            for i in range(size):
                frp = round(10 ** rng.uniform(-1.2, 2.5), 2)
                hid, = self.viirs("delta", "S-NPP", "2015-03-10T23:30Z" if night
                                  else "2015-03-10T11:30Z", cluster=size, lat=lat + i * 0.3 * KM,
                                  lon=lon, frp=frp, scan=scan, track=track,
                                  daynight="N" if night else "D")
                x = self.expected[hid][4]
                lc = math.log(x[3])
                self.labels[hid] = sigmoid(sum(map(math.prod, zip(TRUE, (
                    1, x[0], x[1], x[2], lc, x[0] * x[2], x[0] * lc)))))
                self.classes[hid] = ("cropland", "forest", None)[f % 3]
        with self.con:
            self.con.executemany(
                "INSERT INTO matchups VALUES (?, 'MYD14.A2015069.1130.061.x', 1.0, ?, 1)",
                list(self.labels.items()))
            self.con.execute("INSERT INTO matchups VALUES ('ffffffffffffff00', 'g', 0, 1, 1)")
            if self.land:
                self.con.executemany(
                    "INSERT INTO land_cover VALUES (?, 12, ?)",
                    [(h, c) for h, c in self.classes.items() if c is not None])

        add, viirs, cover = self.add, self.viirs, self.cover
        add("delta", "Aqua", "2015-03-10T11:35Z", n=60)
        add("delta", "Aqua", "2015-03-10T11:35Z", in_box=0, n=5)
        add("delta", "Aqua", "2015-03-11T11:35Z", fire_type=2, n=4)
        viirs("delta", "S-NPP", "2015-03-11T11:30Z", lat=29.0, frp=-1.52, in_box=0)
        add("delta", "S-NPP", "2015-03-11T11:30Z", lat=29.0, fire_type=2)
        cover("delta", "S-NPP", 0, "2014-03-07")
        add("delta", "Terra", "2014-03-07T08:30Z", n=6)
        add("delta", "Terra", "2016-07-05T08:30Z", n=20)
        viirs("delta", "S-NPP", "2016-07-05T11:30Z", lat=29.5, frp=20.0)
        viirs("delta", "S-NPP", "2016-07-31T23:58Z", cluster=2, lat=29.0, frp=3.0,
              daynight="N")
        viirs("delta", "S-NPP", "2016-08-01T00:03Z", cluster=2, lat=29.0 + 0.5 * KM, frp=4.0,
              daynight="N")

        cover("delta", "S-NPP", 4, *(f"2021-09-{d:02d}" for d in range(1, 31)))
        cover("delta", "S-NPP", 0, "2021-09-20")
        cover("delta", "NOAA-20", 3, "2021-09-10", "2021-09-20")
        for i in range(60):
            viirs("delta", "S-NPP", "2021-09-10T11:30Z", lat=31 + i * 0.05, frp=2.0 + i)
        for i in range(40):
            viirs("delta", "NOAA-20", "2021-09-10T10:40Z", lat=31 + i * 0.05, frp=1.0 + i)
        self.gapfill = viirs("delta", "NOAA-20", "2021-09-20T10:40Z", frp=8.0)
        self.n20 = viirs("delta", "NOAA-20", "2026-11-02T10:40Z", frp=8.0, processing="NRT")
        add("delta", "NOAA-20", "2026-11-03T10:40Z", processing="NRT", masked=True)
        add("delta", "Terra", "2026-11-03T08:30Z", processing="NRT", masked=True)
        add("delta", "Terra", "2026-11-03T08:30Z", processing="NRT")

        add("calif", "Aqua", "2015-05-05T21:00Z", lat=38.0, lon=-121.0, n=50)
        for i in range(25):
            viirs("calif", "S-NPP", "2015-05-05T21:00Z", lat=38 + i * 0.05, lon=-121.0,
                  frp=5.0)
        for i in range(10):
            viirs("calif", "S-NPP", "2023-05-05T21:00Z", lat=38 + i * 0.05, lon=-121.0,
                  frp=5.0)
            viirs("calif", "NOAA-20", "2023-05-05T20:10Z", lat=38 + i * 0.05, lon=-121.0,
                  frp=10.0)

    def run_step(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            status = cli.main(["model", *args])
        self.assertEqual(status, 0, out.getvalue())
        return out.getvalue()

    def shares(self):
        """s for every viirs_features row, recomputed from the stored raw coefficients."""
        info = db.get_artifact("model:model_v1", self.con)
        raw = info["raw_coefficients"]
        out = {}
        for hid, lf, area, night, size, land in self.con.execute(
                "SELECT * FROM viirs_features"):
            lc = math.log(size)
            eta = (raw["intercept"] + raw["log_frp"] * lf + raw["pixel_area"] * area
                   + raw["is_night"] * night + raw["log_cluster_size"] * lc
                   + raw["log_frp*is_night"] * lf * night
                   + raw["log_frp*log_cluster_size"] * lf * lc + raw.get(f"land:{land}", 0.0))
            out[hid] = sigmoid(eta)
        return out

    def test_features_k_weights(self):
        with self.con:
            self.con.execute(series.WEIGHTS_DDL)
            self.con.execute("INSERT INTO weights VALUES (?, 'ratio_v1', 0.25)", (self.n20[0],))
            self.con.execute("INSERT INTO weights VALUES ('ffffffffffffffff', 'model_v1', 1)")
            db.recreate(self.con, model.FEATURES_DDL)
            self.con.execute("INSERT INTO viirs_features VALUES"
                             " ('0000000000000000', 0, 0, 0, 1, 'unknown')")
        output = self.run_step()
        self.assertIn("log_frp", output)
        first = self.check_tables()
        self.run_step()
        self.assertEqual(self.check_tables(), first)

    def check_tables(self):
        con = self.con
        features = {h: rest for h, *rest in con.execute("SELECT * FROM viirs_features")}
        self.assertEqual(set(features), set(self.expected))
        for hid, (region, satellite, day, in_box, x) in self.expected.items():
            lf, area, night, size, land = features[hid]
            self.assertAlmostEqual(lf, x[0], places=12)
            self.assertAlmostEqual(area, x[1], places=12)
            self.assertEqual((night, size), (x[2], x[3]), hid)
            self.assertEqual(land, (self.classes.get(hid) if self.land else None) or "unknown")

        info = db.get_artifact("model:model_v1", con)
        raw = info["raw_coefficients"]
        for name, value in zip(("intercept",) + modeling.NUMERIC, TRUE):
            self.assertAlmostEqual(raw[name], value, places=6, msg=name)
        self.assertGreater(info["coefficients"]["log_frp"], 0)
        rows = info["training_rows"]
        self.assertEqual((rows["matchups"], rows["sampled"]), (len(self.labels),) * 2)
        self.assertEqual(set(info["scaler"]["mean"]), set(modeling.NUMERIC))
        if self.land:
            seen = Counter(self.classes[h] or "unknown" for h in self.labels)
            reference = min(seen, key=lambda c: (-seen[c], c))
            self.assertEqual(info["land_reference"], reference)
            one_hot = [f"land:{c}" for c in sorted(seen) if c != reference]
            self.assertEqual([f for f in info["features"] if f.startswith("land:")], one_hot)
            for c in one_hot:
                self.assertAlmostEqual(raw[c], 0.0, places=6)
        else:
            self.assertEqual(info["features"], list(modeling.NUMERIC))

        curve = db.get_artifact("model:detection_curve", con)
        self.assertEqual(len(curve["frp_mw"]), 41)
        self.assertEqual([c["land_class"] for c in curve["curves"]],
                         ["all", "cropland", "forest", "unknown"] if self.land
                         else ["all", "unknown"])
        for c in curve["curves"]:
            self.assertEqual(len(c["p"]), 41)
            self.assertEqual(c["p"], sorted(c["p"]))
            self.assertTrue(0 < c["p"][0] < c["p"][-1] < 1)

        s = self.shares()

        def total(region, satellite, days, in_box=1):
            return sum(s[h] for h, (r, sat, d, box, _) in self.expected.items()
                       if r == region and sat == satellite and d in days and box == in_box)

        k = {(r, m, sat): (v, level) for r, m, sat, v, level in
             con.execute("SELECT * FROM k_factors")}
        self.assertEqual(len(k), 48)
        march = total("delta", "S-NPP", {"2015-03-10", "2015-03-11"})
        self.assertAlmostEqual(k["delta", 3, "S-NPP"][0], 60 / march)
        self.assertEqual(k["delta", 3, "S-NPP"][1], "region_month")
        year = march + total("delta", "S-NPP", {"2016-07-05", "2016-07-31", "2016-08-01"})
        self.assertAlmostEqual(k["delta", 7, "S-NPP"][0], 80 / year)
        self.assertEqual(k["delta", 7, "S-NPP"][1], "region_year")
        self.assertEqual(k["delta", 2, "S-NPP"][1], "pooled_3month")
        transfer = (total("delta", "S-NPP", {"2021-09-10"})
                    / total("delta", "NOAA-20", {"2021-09-10"}))
        self.assertAlmostEqual(k["delta", 9, "NOAA-20"][0], 80 / year * transfer)
        self.assertEqual(k["delta", 9, "NOAA-20"][1], "region_month")
        self.assertEqual(k["delta", 1, "NOAA-20"][1], "region_year")
        calif = total("calif", "S-NPP", {"2015-05-05"})
        self.assertAlmostEqual(k["calif", 5, "S-NPP"][0], 50 / calif)
        self.assertAlmostEqual(k["calif", 5, "NOAA-20"][0], 50 / calif * (
            total("calif", "S-NPP", {"2023-05-05"}) / total("calif", "NOAA-20", {"2023-05-05"})))

        weights = dict(con.execute("SELECT hotspot_id, weight FROM weights"
                                   " WHERE method = 'model_v1'"))
        self.assertEqual(set(weights), set(self.expected))
        for hid, (region, satellite, day, _, _) in self.expected.items():
            self.assertAlmostEqual(weights[hid], s[hid] * k[region, int(day[5:7]), satellite][0],
                                   places=12)
        self.assertEqual(con.execute("SELECT * FROM weights WHERE method = 'ratio_v1'")
                         .fetchall(), [(self.n20[0], "ratio_v1", 0.25)])

        report = db.get_artifact("model:report", con)
        self.assertEqual(report["rows"], len(self.expected))
        self.assertEqual(report["load"]["matchups_missing"], 1)
        annual = {r["year"]: r for r in report["annual"]["delta"]}
        self.assertEqual(annual[2015]["modis"], 60)
        self.assertAlmostEqual(annual[2015]["model"], 60, places=2)
        self.assertAlmostEqual(annual[2016]["model"], 80 * (year - march) / year, places=2)
        self.assertEqual(annual[2026]["modis"], 1)
        self.assertEqual(annual[2021]["viirs_raw"], 61)
        cal = [c for c in report["checks"]["years"] if c["region_id"] == "delta"]
        self.assertEqual([c["year"] for c in cal], [2014, 2015, 2016])
        self.assertEqual([c["model_ok"] for c in cal], [False, True, False])
        return (sorted(features.items()), sorted(weights.items()), sorted(k.items()), curve)

    def test_dry_run_writes_nothing(self):
        output = self.run_step("--dry-run")
        self.assertIn("dry run", output)
        self.assertIsNone(db.get_artifact("model:model_v1", self.con))
        self.assertIsNone(self.con.execute("SELECT 1 FROM sqlite_master"
                                           " WHERE name = 'viirs_features'").fetchone())

    def test_waits_for_normalize(self):
        with self.con:
            self.con.execute("DROP INDEX hotspots_hotspot_id")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(cli.main(["model"]), 1)
        self.assertIn("rerun model after normalize", out.getvalue())

    def test_step_is_discovered(self):
        self.assertIs(cli.discover_steps()["model"], model)


class StepWithLandCover(Step):
    land = True

    test_dry_run_writes_nothing = None
    test_waits_for_normalize = None
    test_step_is_discovered = None


if __name__ == "__main__":
    unittest.main()
