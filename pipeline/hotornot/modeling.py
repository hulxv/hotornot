"""The model_v1 detection model: VIIRS features, a logistic fit by IRLS, and the coverage factor k.

A VIIRS hotspot's weight is w = s × k. The detection share s is the modeled matchup label: the
chance that Aqua MODIS reported the fire, shared 1/m among the m VIIRS points in one MODIS
pixel. The coverage factor k scales the shares to the Terra plus Aqua record per region,
calendar month and satellite.

`load` reads every vegetation S-NPP and NOAA-20 hotspot once into a compact in-memory store.
`fit(rows, train_years)` then fits s on a stratified matchup sample and k on the same years,
without touching the database, so validation can refit it fold by fold.
"""
import math
import random
import struct
import time
from array import array
from collections import Counter, defaultdict
from datetime import date
from itertools import repeat
from operator import add, mul, sub

from hotornot import config, geo
from hotornot.steps import series

METHOD = "model_v1"
VIIRS = ("S-NPP", "NOAA-20")
CLUSTER_KM = 1.0
CLUSTER_MINUTES = 10
FRP_FLOOR_MW = 0.1
SAMPLE_CAP = 200_000
SEED = 20120120
MAX_ITERATIONS = 50
TOLERANCE = 1e-9
CURVE_ROWS = 20_000
UNKNOWN = "unknown"

# Model terms and how each comes from a viirs_features row. The two FRP interactions were chosen
# on 2012-2019 leave-two-years-out folds: they cut the Nile Delta's mean annual error from 18 to
# 11.5 percent and change the other regions by under 0.3 points.
TERMS = (
    ("log_frp", "log_frp"),
    ("pixel_area", "pixel_area"),
    ("is_night", "is_night"),
    ("log_cluster_size", "ln(cluster_size)"),
    ("log_frp*is_night", "log_frp * is_night"),
    ("log_frp*log_cluster_size", "log_frp * ln(cluster_size)"),
)
NUMERIC = tuple(name for name, _ in TERMS)

SNPP = series.ROLE_INDEX["snpp"]
VIIRS_ROLES = {series.ROLE_INDEX[r]: s for r, s in series.WEIGHTED.items()}
IN_SERIES_ROLES = frozenset(series.ROLE_INDEX[r] for r in series.WEIGHTED
                            if r in series.IN_SERIES)

# id, region index, role index, in_box, day, log_frp, pixel_area, is_night, cluster_size,
# land class index. Days count from DAY0, so 2 bytes reach the year 2179.
RECORD = struct.Struct("<8sBBBHddBHB")
DAY0 = date(2000, 1, 1).toordinal()
_DAYS = 16_000
ISO = [date.fromordinal(DAY0 + d).isoformat() for d in range(_DAYS)]
YEAR = [int(s[:4]) for s in ISO]
MONTH = [int(s[5:7]) for s in ISO]

VIIRS_SQL = """
SELECT h.hotspot_id, h.acq_utc, h.acq_date, h.lat, h.lon, h.in_box, h.fire_type, h.frp_mw,
       h.scan_km, h.track_km, h.daynight, {land}
FROM hotspots AS h{join}
WHERE h.region_id = ? AND h.satellite = ? AND h.acq_date >= ? AND h.acq_date < ?
ORDER BY h.acq_date"""
LAND_JOIN = " LEFT JOIN land_cover AS lc ON lc.hotspot_id = h.hotspot_id"
MODIS_SQL = """
SELECT acq_date, COUNT(*) FROM hotspots
WHERE region_id = ? AND satellite = ? AND acq_date >= ? AND acq_date < ? AND in_box = 1
  AND (fire_type = 0
       OR (fire_type IS NULL AND hotspot_id NOT IN (SELECT hotspot_id FROM static_mask)))
GROUP BY acq_date"""


def day_of(iso):
    return date.fromisoformat(iso).toordinal() - DAY0


def log_frp(frp_mw):
    return math.log(max(frp_mw or 0.0, FRP_FLOOR_MW))


def numeric_values(log_frp_value, pixel_area, is_night, cluster_size):
    """The values of TERMS for one viirs_features row."""
    log_cluster = math.log(cluster_size)
    return (log_frp_value, pixel_area, is_night, log_cluster, log_frp_value * is_night,
            log_frp_value * log_cluster)


def sigmoid(eta):
    if eta < -500:
        return 0.0
    return 1.0 / (1.0 + math.exp(-eta))


def _group_sizes(ts, lats, lons, radius_km, window):
    """Neighbour counts (each point counts itself) within `radius_km` and `window` minutes."""
    n = len(ts)
    sizes = [1] * n
    if n == 1:
        return sizes
    dlat = radius_km / geo.KM_PER_DEG
    widest = min(max(abs(x) for x in lats) + dlat, 89.0)
    dlon = dlat / math.cos(math.radians(widest))
    cells = defaultdict(list)
    for i in range(n):
        cells[math.floor(lats[i] / dlat), math.floor(lons[i] / dlon)].append(i)
    r2 = radius_km * radius_km
    km = geo.KM_PER_DEG
    for (cy, cx), members in cells.items():
        for oy, ox in ((0, 0), (0, 1), (1, -1), (1, 0), (1, 1)):
            same = oy == 0 and ox == 0
            others = members if same else cells.get((cy + oy, cx + ox))
            if not others:
                continue
            for a, i in enumerate(members):
                ti, lat, lon = ts[i], lats[i], lons[i]
                kx = km * math.cos(math.radians(lat))
                for j in (others[a + 1:] if same else others):
                    if abs(ts[j] - ti) <= window:
                        dy = (lats[j] - lat) * km
                        dx = (lons[j] - lon) * kx
                        if dx * dx + dy * dy <= r2:
                            sizes[i] += 1
                            sizes[j] += 1
    return sizes


def cluster_sizes(points, radius_km=CLUSTER_KM, window=CLUSTER_MINUTES):
    """For each (minutes, lat, lon), the number of points within `radius_km` and `window`
    minutes of it, itself included."""
    order = sorted(range(len(points)), key=lambda i: points[i][0])
    out = [0] * len(points)
    group = []
    for i in order + [None]:
        if group and (i is None or points[i][0] - points[group[-1]][0] > window):
            sizes = _group_sizes([points[g][0] for g in group], [points[g][1] for g in group],
                                 [points[g][2] for g in group], radius_km, window)
            for g, size in zip(group, sizes):
                out[g] = size
            group = []
        if i is not None:
            group.append(i)
    return out


class _Clusters:
    """Streams one region and satellite in time order. A time group (gaps of at most
    CLUSTER_MINUTES) is sized and stored once a row comes more than CLUSTER_MINUTES after it, so
    groups that cross midnight or a month boundary stay whole."""

    def __init__(self, store):
        self.store = store
        self.group = []

    def add_day(self, rows):
        rows.sort(key=lambda r: r[0])
        for row in rows:
            if self.group and row[0] - self.group[-1][0] > CLUSTER_MINUTES:
                self.flush()
            self.group.append(row)

    def flush(self):
        group = self.group
        if not group:
            return
        sizes = _group_sizes([r[0] for r in group], [r[1] for r in group],
                             [r[2] for r in group], CLUSTER_KM, CLUSTER_MINUTES)
        buckets, pack = self.store.buckets, RECORD.pack
        for (_, _, _, raw, rest), size in zip(group, sizes):
            buckets[raw[0]] += pack(raw, *rest[:7], min(size, 65535), rest[7])
        self.group = []


def has_land_cover(con):
    return con.execute("SELECT 1 FROM sqlite_master WHERE type = 'table'"
                       " AND name = 'land_cover'").fetchone() is not None


class Rows:
    """Every vegetation S-NPP and NOAA-20 hotspot (in box and buffer) as RECORD structs in 256
    buckets by the first id byte, each sorted by id, plus what k and the report need."""

    def __init__(self, regions, classes):
        self.regions = regions
        self.classes = classes
        self.buckets = [bytearray() for _ in range(256)]
        self.counts = Counter()
        self.row_days = defaultdict(set)
        self.modis = {}
        self.granules = {}
        self.fill = {}
        self.cfg = None
        self.matchup_bucket = array("B")
        self.matchup_pos = array("I")
        self.matchup_label = array("d")
        self.stats = {}

    def __len__(self):
        return sum(len(b) for b in self.buckets) // RECORD.size

    def records(self):
        for data in self.buckets:
            yield from RECORD.iter_unpack(data)

    def record(self, bucket, pos):
        return RECORD.unpack_from(self.buckets[bucket], pos * RECORD.size)

    def coverage(self):
        return series.Coverage(self.granules, self.row_days)


def load(con, cfg, log=print):
    """Read the vegetation VIIRS rows of every configured region, compute their features and
    index the matchups. Read transactions last one query: a month of one satellite."""
    started = time.monotonic()
    land = has_land_cover(con)
    classes = [UNKNOWN]
    if land:
        classes += sorted({c for (c,) in con.execute(
            "SELECT DISTINCT class7 FROM land_cover WHERE class7 IS NOT NULL")} - {UNKNOWN})
    class_index = {c: i for i, c in enumerate(classes)}
    rows = Rows([r["id"] for r in cfg["regions"]], classes)
    rows.cfg = cfg
    rows.granules, masked = series.read_inputs(con)
    rows.fill = {r["id"]: series.gapfill_days(rows.granules, r, cfg) for r in cfg["regions"]}
    sql = VIIRS_SQL.format(land="lc.class7" if land else "NULL", join=LAND_JOIN if land else "")
    stats = Counter()
    day_cache = {}

    for ri, region in enumerate(cfg["regions"]):
        rid = region["id"]
        fill = rows.fill[rid]
        for satellite in VIIRS:
            lo, hi = con.execute("SELECT MIN(acq_date), MAX(acq_date) FROM hotspots"
                                 " WHERE region_id = ? AND satellite = ?",
                                 (rid, satellite)).fetchone()
            if lo is None:
                continue
            row_days = rows.row_days[rid, satellite]
            clusters = _Clusters(rows)
            kept = 0
            for _, _, start, end in series.month_starts(lo, hi):
                day_rows, current = [], None
                for (hid, acq_utc, acq_date, lat, lon, in_box, fire_type, frp, scan, track,
                     daynight, land_class) in con.execute(sql, (rid, satellite, start, end)):
                    if acq_date != current:
                        clusters.add_day(day_rows)
                        day_rows, current = [], acq_date
                        row_days.add(acq_date)
                    role = series.role_of(satellite, acq_date, fire_type, hid in masked, fill)
                    if role not in series.WEIGHTED:
                        continue
                    raw = bytes.fromhex(hid)
                    if len(raw) != 8 or raw.hex() != hid:
                        raise ValueError(f"hotspot_id {hid!r} is not 16 lowercase hex digits")
                    day = day_cache.get(acq_date)
                    if day is None:
                        day = day_cache[acq_date] = day_of(acq_date)
                    if frp is None:
                        stats["frp_missing"] += 1
                    if scan is None or track is None:
                        stats["pixel_missing"] += 1
                    if daynight not in ("D", "N"):
                        stats["daynight_missing"] += 1
                    role_index = series.ROLE_INDEX[role]
                    rows.counts[ri, role_index, in_box, day] += 1
                    kept += 1
                    t = day * 1440 + int(acq_utc[11:13]) * 60 + int(acq_utc[14:16])
                    day_rows.append((t, lat, lon, raw, (
                        ri, role_index, in_box, day, log_frp(frp), (scan or 0.0) * (track or 0.0),
                        int(daynight == "N"), class_index.get(land_class or UNKNOWN, 0))))
                clusters.add_day(day_rows)
            clusters.flush()
            log(f"{rid} {satellite}: {kept:,} vegetation rows, {time.monotonic() - started:.0f} s")

    for b, data in enumerate(rows.buckets):
        size = RECORD.size
        rows.buckets[b] = bytearray(b"".join(
            sorted(bytes(data[i:i + size]) for i in range(0, len(data), size))))
    rows.modis = modis_daily(con, cfg)
    rows.stats = {"rows": len(rows), "land_cover": land, "classes": classes, **stats}
    index_matchups(con, rows)
    rows.stats["seconds"] = round(time.monotonic() - started, 1)
    return rows


def modis_daily(con, cfg):
    """{region_id: {day: in-box vegetation Terra plus Aqua rows}} from VIIRS_SERIES_START."""
    out = {}
    for region in cfg["regions"]:
        days = Counter()
        for satellite in series.MODIS:
            lo, hi = con.execute("SELECT MIN(acq_date), MAX(acq_date) FROM hotspots"
                                 " WHERE region_id = ? AND satellite = ?",
                                 (region["id"], satellite)).fetchone()
            if hi is None:
                continue
            first = max(int(lo[:4]), config.VIIRS_SERIES_START.year)
            for year in range(first, int(hi[:4]) + 1):
                for day, n in con.execute(MODIS_SQL, (region["id"], satellite, f"{year}-01-01",
                                                      f"{year + 1}-01-01")):
                    days[day] += n
        out[region["id"]] = days
    return out


def index_matchups(con, rows):
    """Point each matchup at its record by merging the id-sorted table with the sorted buckets.
    Matchups without a vegetation VIIRS record (a stale table) are counted and skipped."""
    size = RECORD.size
    pos = [0] * 256
    ends = [len(b) // size for b in rows.buckets]
    missing = 0
    for hid, label in con.execute("SELECT hotspot_id, label FROM matchups ORDER BY hotspot_id"):
        raw = bytes.fromhex(hid)
        b = raw[0]
        data, p, end = rows.buckets[b], pos[b], ends[b]
        while p < end and data[p * size:p * size + 8] < raw:
            p += 1
        pos[b] = p
        if p < end and data[p * size:p * size + 8] == raw:
            rows.matchup_bucket.append(b)
            rows.matchup_pos.append(p)
            rows.matchup_label.append(label)
        else:
            missing += 1
    rows.stats["matchups_missing"] = missing


def allocate(sizes, cap):
    """Proportional allocation of `cap` rows over strata {key: size}, largest remainders first."""
    total = sum(sizes.values())
    if total <= cap:
        return dict(sizes)
    quotas = {k: cap * n / total for k, n in sizes.items()}
    out = {k: math.floor(q) for k, q in quotas.items()}
    by_remainder = sorted(sizes, key=lambda k: (out[k] - quotas[k], k))
    for k in by_remainder[:cap - sum(out.values())]:
        out[k] += 1
    return out


def sample_matchups(rows, train_years, cap=SAMPLE_CAP, seed=SEED):
    """Indices into the matchup arrays: a seeded sample stratified by region and year."""
    years = set(train_years)
    strata = defaultdict(list)
    for i in range(len(rows.matchup_label)):
        rec = rows.record(rows.matchup_bucket[i], rows.matchup_pos[i])
        if YEAR[rec[4]] in years:
            strata[rec[1], YEAR[rec[4]]].append(i)
    quota = allocate({k: len(v) for k, v in strata.items()}, cap)
    rng = random.Random(seed)
    chosen = []
    for key in sorted(strata):
        chosen += rng.sample(strata[key], quota[key])
    by_stratum = [{"region_id": rows.regions[k[0]], "year": k[1], "available": len(strata[k]),
                   "sampled": quota[k]} for k in sorted(strata)]
    return sorted(chosen), by_stratum


def solve(a, b):
    """x with a·x = b, by Gaussian elimination with partial pivoting."""
    n = len(b)
    m = [list(row) + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        if abs(m[p][c]) < 1e-300:
            raise ValueError("singular matrix")
        m[c], m[p] = m[p], m[c]
        for r in range(c + 1, n):
            f = m[r][c] / m[c][c]
            if f:
                m[r] = [x - f * y for x, y in zip(m[r], m[c])]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        x[r] = (m[r][n] - sum(m[r][c] * x[c] for c in range(r + 1, n))) / m[r][r]
    return x


def _linear(beta, columns, n):
    eta = array("d", repeat(beta[0], n))
    for b, col in zip(beta[1:], columns):
        if b:
            eta = array("d", map(add, eta, map(mul, col, repeat(b, n))))
    return eta


def _deviance(eta, targets, weights):
    total = 0.0
    for e, y, w in zip(eta, targets, weights):
        # -log(sigmoid(e)) and -log(1 - sigmoid(e)), stable for large |e|.
        z = -e if y else e
        total += w * (z + math.log1p(math.exp(-z)) if z > 0 else math.log1p(math.exp(z)))
    return 2 * total


def logistic_irls(columns, targets, weights, max_iterations=MAX_ITERATIONS, tol=TOLERANCE):
    """Weighted logistic regression of 0/1 `targets` on `columns` (lists of floats) by
    iteratively reweighted least squares, with step halving. Returns (beta, info); beta[0] is
    the intercept."""
    n, p = len(targets), len(columns) + 1
    total = sum(weights)
    ybar = min(max(sum(map(mul, weights, targets)) / total, 1e-9), 1 - 1e-9)
    beta = [math.log(ybar / (1 - ybar))] + [0.0] * (p - 1)
    eta = _linear(beta, columns, n)
    dev = null_dev = _deviance(eta, targets, weights)
    converged, it = False, 0
    for it in range(1, max_iterations + 1):
        mu = array("d", map(sigmoid, eta))
        w = array("d", (v * m * (1 - m) for v, m in zip(weights, mu)))
        r = array("d", map(mul, weights, map(sub, targets, mu)))
        grad = [sum(r)] + [sum(map(mul, r, c)) for c in columns]
        hess = [[0.0] * p for _ in range(p)]
        hess[0][0] = sum(w)
        for i in range(1, p):
            wc = array("d", map(mul, w, columns[i - 1]))
            hess[0][i] = hess[i][0] = sum(wc)
            for j in range(i, p):
                hess[i][j] = hess[j][i] = sum(map(mul, wc, columns[j - 1]))
        step = solve(hess, grad)
        for _ in range(40):
            trial = [b + s for b, s in zip(beta, step)]
            trial_eta = _linear(trial, columns, n)
            trial_dev = _deviance(trial_eta, targets, weights)
            if trial_dev <= dev * (1 + 1e-12):
                break
            step = [s / 2 for s in step]
        beta, eta, dev = trial, trial_eta, trial_dev
        if max(abs(s) for s in step) < tol:
            converged = True
            break
    return beta, {"iterations": it, "converged": converged, "deviance": dev,
                  "null_deviance": null_dev}


def doubled(labels):
    """The RFC trick for fractional labels: each row enters as a positive with weight y and as
    a negative with weight 1 - y. Copies with weight 0 add nothing and are left out. Returns
    (row index, target, weight) lists."""
    index, targets, weights = [], [], []
    for i, y in enumerate(labels):
        if y > 0:
            index.append(i)
            targets.append(1.0)
            weights.append(y)
        if y < 1:
            index.append(i)
            targets.append(0.0)
            weights.append(1.0 - y)
    return index, targets, weights


class Model:
    """Coefficients on standardized numeric features plus one-hot land classes, and k."""

    def __init__(self, numeric, mean, sd, land_classes, reference, beta):
        self.numeric = list(numeric)
        self.mean, self.sd = list(mean), list(sd)
        self.land_classes = list(land_classes)
        self.reference = reference
        self.intercept = beta[0]
        self.coefficients = beta[1:1 + len(numeric)]
        self.land = dict(zip(land_classes, beta[1 + len(numeric):]))
        self.raw = [c / s for c, s in zip(self.coefficients, self.sd)]
        self.raw_intercept = self.intercept - sum(c * m for c, m in zip(self.raw, self.mean))
        self.k = {}
        self.sums = None
        self.info = {}

    def eta(self, log_frp_value, pixel_area, is_night, cluster_size, land_class=UNKNOWN):
        values = numeric_values(log_frp_value, pixel_area, is_night, cluster_size)
        return (self.raw_intercept + sum(map(mul, self.raw, values))
                + self.land.get(land_class, 0.0))

    def share(self, log_frp_value, pixel_area, is_night, cluster_size, land_class=UNKNOWN):
        return sigmoid(self.eta(log_frp_value, pixel_area, is_night, cluster_size, land_class))

    def scorer(self, classes):
        """s for one RECORD tuple; `classes` maps the record's land index to a class name. A
        class the fit never saw scores as the reference class."""
        a, raw = self.raw_intercept, tuple(self.raw)
        land = [self.land.get(c, 0.0) for c in classes]

        def score(rec):
            eta = a + sum(map(mul, raw, numeric_values(rec[5], rec[6], rec[7], rec[8])))
            return sigmoid(eta + land[rec[9]])
        return score

    def as_dict(self):
        names = self.numeric + [f"land:{c}" for c in self.land_classes]
        return {
            "method": METHOD,
            "features": names,
            "terms": {**dict(TERMS), **{f"land:{c}": f"land_class = '{c}'"
                                        for c in self.land_classes}},
            "coefficients": dict(zip(names, self.coefficients
                                     + [self.land[c] for c in self.land_classes])),
            "intercept": self.intercept,
            "scaler": {"mean": dict(zip(self.numeric, self.mean)),
                       "sd": dict(zip(self.numeric, self.sd))},
            "raw_coefficients": {"intercept": self.raw_intercept,
                                 **dict(zip(self.numeric, self.raw)),
                                 **{f"land:{c}": self.land[c] for c in self.land_classes}},
            "land_reference": self.reference,
            **self.info,
        }


def fit_detection(rows, train_years, cap=SAMPLE_CAP, seed=SEED):
    """The detection-share model alone, fitted on a stratified matchup sample."""
    started = time.monotonic()
    chosen, by_stratum = sample_matchups(rows, train_years, cap, seed)
    if not chosen:
        raise ValueError(f"no matchups in {sorted(train_years)}")
    columns = [array("d") for _ in NUMERIC]
    area, night, land, labels = array("d"), array("B"), [], array("d")
    for i in chosen:
        rec = rows.record(rows.matchup_bucket[i], rows.matchup_pos[i])
        for col, value in zip(columns, numeric_values(rec[5], rec[6], rec[7], rec[8])):
            col.append(value)
        area.append(rec[6])
        night.append(rec[7])
        land.append(rows.classes[rec[9]])
        labels.append(rows.matchup_label[i])
    n = len(chosen)
    mean, sd = [], []
    for j, col in enumerate(columns):
        mu = sum(col) / n
        sigma = math.sqrt(sum((x - mu) ** 2 for x in col) / n)
        if sigma == 0:
            raise ValueError(f"{NUMERIC[j]} is constant in the training sample")
        mean.append(mu)
        sd.append(sigma)
        columns[j] = array("d", ((x - mu) / sigma for x in col))
    present = Counter(land)
    reference = min(present, key=lambda c: (-present[c], c))
    one_hot = sorted(c for c in present if c != reference)
    for c in one_hot:
        columns.append(array("d", (1.0 if x == c else 0.0 for x in land)))

    index, targets, weights = doubled(labels)
    columns = [array("d", (col[i] for i in index)) for col in columns]
    beta, info = logistic_irls(columns, array("d", targets), array("d", weights))
    del columns
    model = Model(NUMERIC, mean, sd, one_hot, reference, beta)
    curve_rows = random.Random(seed).sample(range(n), min(n, CURVE_ROWS))
    model.curve_rows = [(area[i], night[i], land[i]) for i in curve_rows]
    model.info = {
        "train_years": sorted(train_years),
        "training_rows": {
            "matchups": len(rows.matchup_label),
            "in_train_years": sum(s["available"] for s in by_stratum),
            "sampled": n,
            "cap": cap,
            "seed": seed,
            "doubled_rows": len(targets),
            "positive": sum(1 for y in labels if y > 0),
            "label_sum": round(sum(labels), 3),
            "land_classes": dict(sorted(present.items())),
            "by_stratum": by_stratum,
        },
        "fit": {**info, "seconds": round(time.monotonic() - started, 2)},
    }
    return model


def score_sums(rows, model):
    """Sum of s by (region index, role index, in_box, day)."""
    score = model.scorer(rows.classes)
    sums = defaultdict(float)
    for rec in rows.records():
        sums[rec[1], rec[2], rec[3], rec[4]] += score(rec)
    return sums


def _days(first, last):
    return range(day_of(first), day_of(last) + 1)


def coverage_factors(rows, sums, train_years):
    """{(region_id, month, satellite): (k, level)}.

    S-NPP: in-box vegetation MODIS rows over the sum of s of in-box S-NPP rows, on days S-NPP
    observed in `train_years`, pooled as P06 pools the ratio. NOAA-20: k_SNPP × sum of s over
    S-NPP / sum of s over NOAA-20, on days both observed in N20_TRANSFER (from the region's
    first NOAA-20 data), pooled on the S-NPP row counts.
    """
    coverage = rows.coverage()
    present = defaultdict(set)
    for ri, role, _, _ in rows.counts:
        present[ri].add(VIIRS_ROLES[role])
    n20_roles = [r for r, s in VIIRS_ROLES.items() if s == "NOAA-20"]
    out = {}
    for ri, region in enumerate(rows.cfg["regions"]):
        rid = region["id"]
        if not present[ri]:
            continue
        modis, s_snpp = Counter(), Counter()
        for year in sorted(set(train_years)):
            for d in _days(f"{year}-01-01", f"{year}-12-31"):
                if coverage.observed(rid, "S-NPP", ISO[d]):
                    modis[MONTH[d]] += rows.modis[rid].get(ISO[d], 0)
                    s_snpp[MONTH[d]] += sums.get((ri, SNPP, 1, d), 0.0)
        try:
            k_snpp = series.pool(modis, s_snpp, modis)
        except ValueError:
            raise ValueError(f"{rid}: no S-NPP rows on observed days in {sorted(train_years)}"
                             ) from None
        for m, value in k_snpp.items():
            out[rid, m, "S-NPP"] = value
        if "NOAA-20" not in present[ri]:
            continue
        first = max(config.N20_TRANSFER[0].isoformat(), series.n20_data_start(region, rows.cfg))
        a, b, basis = Counter(), Counter(), Counter()
        for d in _days(first, config.N20_TRANSFER[1].isoformat()):
            if coverage.observed(rid, "S-NPP", ISO[d]) and coverage.observed(rid, "NOAA-20",
                                                                             ISO[d]):
                m = MONTH[d]
                a[m] += sums.get((ri, SNPP, 1, d), 0.0)
                basis[m] += rows.counts.get((ri, SNPP, 1, d), 0)
                b[m] += sum(sums.get((ri, r, 1, d), 0.0) for r in n20_roles)
        try:
            transfer = series.pool(a, b, basis)
        except ValueError:
            raise ValueError(f"{rid}: no NOAA-20 rows on days both VIIRS satellites observed"
                             f" from {first}") from None
        for m, (ratio, level) in transfer.items():
            out[rid, m, "NOAA-20"] = (k_snpp[m][0] * ratio, level)
    return out


def fit(rows, train_years, cap=SAMPLE_CAP, seed=SEED):
    """model_v1 fitted on `train_years`: the detection model, with `k` (see coverage_factors)
    and `sums` (score_sums) attached."""
    model = fit_detection(rows, train_years, cap, seed)
    started = time.monotonic()
    model.sums = score_sums(rows, model)
    model.k = coverage_factors(rows, model.sums, train_years)
    model.info["scoring_seconds"] = round(time.monotonic() - started, 1)
    return model


def weight_table(rows, model):
    """k by (region index, month, role index), the lookup the weights use."""
    return {(ri, m, role): model.k[rid, m, satellite][0]
            for ri, rid in enumerate(rows.regions) for m in range(1, 13)
            for role, satellite in VIIRS_ROLES.items() if (rid, m, satellite) in model.k}


def weighted_sums(rows, model, roles=IN_SERIES_ROLES, in_box=1):
    """{(region_id, ym): sum of w} over rows with these role indices and in_box value."""
    kt = weight_table(rows, model)
    out = defaultdict(float)
    for (ri, role, box, d), s in model.sums.items():
        if role in roles and box == in_box:
            out[rows.regions[ri], YEAR[d] * 100 + MONTH[d]] += s * kt[ri, MONTH[d], role]
    return dict(out)


def counts_by_month(rows, roles=IN_SERIES_ROLES, in_box=1):
    """{(region_id, ym): rows} with these role indices and in_box value."""
    out = Counter()
    for (ri, role, box, d), n in rows.counts.items():
        if role in roles and box == in_box:
            out[rows.regions[ri], YEAR[d] * 100 + MONTH[d]] += n
    return dict(out)


def modis_on_series_days(rows):
    """{(region_id, ym): in-box vegetation MODIS rows} on days the series VIIRS satellite
    observed, which leaves out S-NPP outages and 2012-01-01 to 01-19, before S-NPP data."""
    coverage = rows.coverage()
    switch = config.VIIRS_SWITCH.isoformat()
    out = Counter()
    for rid, days in rows.modis.items():
        fill = rows.fill[rid]
        for day, n in days.items():
            satellite = "NOAA-20" if day >= switch or day in fill else "S-NPP"
            if coverage.observed(rid, satellite, day):
                out[rid, int(day[:4] + day[5:7])] += n
    return dict(out)


def modis_by_month(rows):
    out = Counter()
    for rid, days in rows.modis.items():
        for day, n in days.items():
            out[rid, int(day[:4] + day[5:7])] += n
    return dict(out)


def frp_grid():
    """0.1 to 1,000 MW, ten log steps per decade."""
    return [float(f"{10 ** (i / 10 - 1):.4g}") for i in range(41)]


def detection_curve(model):
    """P(detect) over frp_grid() for a lone hotspot (cluster_size 1), averaged over the pixel
    sizes and day/night mix of up to CURVE_ROWS training rows: for `all` with each row's own
    land class, then for each class seen in training."""
    grid = frp_grid()
    classes = sorted(set(model.land_classes) | {model.reference})
    curves = []
    for name in ["all"] + classes:
        p = []
        for frp in grid:
            lf = math.log(frp)
            total = sum(model.share(lf, area, night, 1, own if name == "all" else name)
                        for area, night, own in model.curve_rows)
            p.append(round(total / len(model.curve_rows), 5))
        curves.append({"land_class": name, "p": p})
    return {"frp_mw": grid, "curves": curves}
