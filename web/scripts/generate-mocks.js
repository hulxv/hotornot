// Writes web/mocks/*.json. Every number is synthetic: seeded noise around hand-picked monthly
// climatologies, then run through the shared analytics so the files are self-consistent.
// Run with `npm run mocks`; output is deterministic.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = new URL("../mocks/", import.meta.url);

const DATA_VERSION = "v3";
const WEIGHT_METHOD = "model_v1";
const MODEL_VERSION = "2026-11-13";
const UNITS = "modis_equivalent_hotspots";
const NOW = { year: 2026, month: 11, days: 13 };
const NOW_YM = NOW.year * 100 + NOW.month;
const SP_UNTIL_YM = 202606;
const FIRST_YM = 200011;
const AQUA_YM = 200207;
const SNPP_YM = 201201;
const BASELINE = { start_year: 2003, end_year: 2025 };
const EARTH_RADIUS_KM = 6378.137;

const REGIONS = [
  { id: "nile_delta", name: "Nile Delta, Egypt", bbox: [29.5, 29.8, 32.5, 31.8] },
  { id: "california", name: "California and Nevada", bbox: [-124.5, 32.5, -114.0, 42.0] },
  { id: "se_australia", name: "Southeastern Australia", bbox: [140.0, -39.0, 154.0, -28.0] },
  { id: "n_argentina", name: "Northern Argentina and Paraguayan Chaco", bbox: [-66.0, -35.0, -57.0, -22.0] },
];

const ATTRIBUTION =
  "We acknowledge the use of data and imagery from NASA's Fire Information for Resource Management System " +
  "(FIRMS) (https://www.earthdata.nasa.gov/data/tools/firms), part of NASA's Earth Science Data and Information " +
  "System (ESDIS). Sources: MODIS Collection 6.1 active fires (Terra, Aqua); VIIRS 375 m active fires " +
  "(S-NPP VNP14IMG, NOAA-20 VJ114IMG); Natural Earth boundaries. Mock data for development, not observations.";

function makeRandom(seed) {
  let state = seed;
  const uniform = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    let u = 0;
    while (u === 0) u = uniform();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * uniform());
  };
  const lognormal = (sigma) => Math.exp(sigma * normal() - (sigma * sigma) / 2);
  const poisson = (lambda) => {
    if (lambda <= 0) return 0;
    if (lambda > 60) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal()));
    const limit = Math.exp(-lambda);
    let k = 0;
    for (let p = uniform(); p > limit; p *= uniform()) k += 1;
    return k;
  };
  const binomial = (n, p) => {
    let k = 0;
    for (let i = 0; i < n; i += 1) if (uniform() < p) k += 1;
    return k;
  };
  return { uniform, lognormal, poisson, binomial };
}

const round = (x, digits) => {
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return Object.is(r, -0) ? 0 : r;
};
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const pearson = (xs, ys) => {
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  xs.forEach((x, i) => {
    sxy += (x - mx) * (ys[i] - my);
    sxx += (x - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  });
  return sxy / Math.sqrt(sxx * syy);
};

function* yms(first, last) {
  for (let ym = first; ym <= last; ym = ym % 100 === 12 ? ym + 89 : ym + 1) yield ym;
}

// The shared 0.05° grid.
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const gridRow = (lat) => Math.min(Math.floor(round6((lat + 90) * 20)), 3599);
const gridCol = (lon) => Math.min(Math.floor(round6((lon + 180) * 20)), 7199);
const cellOf = (lat, lon) => gridRow(lat) * 7200 + gridCol(lon);

function cellsInBox([west, south, east, north]) {
  const cells = [];
  for (let row = gridRow(south); row <= gridRow(north); row += 1) {
    const lat = (row + 0.5) / 20 - 90;
    if (lat <= south || lat >= north) continue;
    for (let col = gridCol(west); col <= gridCol(east); col += 1) {
      const lon = (col + 0.5) / 20 - 180;
      if (lon > west && lon < east) cells.push({ row, col, cell_id: row * 7200 + col });
    }
  }
  return cells;
}

const toRad = (deg) => (deg * Math.PI) / 180;
const boxAreaKm2 = ([west, south, east, north]) =>
  EARTH_RADIUS_KM ** 2 * toRad(east - west) * (Math.sin(toRad(north)) - Math.sin(toRad(south)));

function aoiBlock(box) {
  const cells = cellsInBox(box);
  const snappedArea = cells.reduce((sum, { row, col }) => {
    const west = col / 20 - 180;
    const south = row / 20 - 90;
    return sum + boxAreaKm2([west, south, west + 0.05, south + 0.05]);
  }, 0);
  const area = boxAreaKm2(box);
  return {
    cells: cells.length,
    covered_cells: cells.length,
    area_km2: round(area, 1),
    snapped_fraction: round(snappedArea / area, 3),
  };
}

function boxPolygon([west, south, east, north]) {
  return {
    type: "Polygon",
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
  };
}

/**
 * Monthly series for one AOI. `clim` is the expected MODIS-equivalent count per calendar month
 * in a normal year; `nowShare` is the usual share of the current calendar month that falls in
 * its first NOW.days days.
 */
function simulateArea(spec) {
  const r = makeRandom(spec.seed);
  const seasonNoise = new Map();
  const noiseFor = (year, month) => {
    const season = month >= spec.seasonStart ? year : year - 1;
    if (!seasonNoise.has(season)) {
      seasonNoise.set(season, r.lognormal(spec.seasonSigma) * (spec.dampedSeasons?.[season] ?? 1));
    }
    return seasonNoise.get(season);
  };

  const rows = [];
  const firstDays = new Map();
  for (const ym of yms(FIRST_YM, NOW_YM)) {
    const year = Math.floor(ym / 100);
    const month = ym % 100;
    let expected =
      spec.clim[month - 1] * spec.trend(year) * noiseFor(year, month) * r.lognormal(0.3) * (spec.events?.[ym] ?? 1);
    // Terra alone sees roughly half of what Terra plus Aqua see.
    if (ym < AQUA_YM) expected *= 0.55;
    const share = month === NOW.month ? clamp(spec.nowShare * r.lognormal(0.12), 0.15, 0.95) : 1;
    if (ym === NOW_YM) expected *= share;

    let modisRaw;
    let viirsRaw = null;
    let value;
    if (ym < SNPP_YM) {
      modisRaw = r.poisson(expected);
      value = modisRaw;
    } else {
      // S-NPP data start on 2012-01-20.
      const viirsDays = ym === SNPP_YM ? 12 / 31 : 1;
      viirsRaw = r.poisson(expected * spec.viirsPerModis * viirsDays * r.lognormal(0.1));
      value = round((viirsRaw / spec.viirsPerModis) * r.lognormal(0.08), 1);
      // Terra and Aqua orbit drift lowers MODIS detections from about 2020.
      modisRaw = r.poisson(expected * r.lognormal(0.12) * (year >= 2020 ? 0.9 : 1));
    }

    if (month === NOW.month) {
      if (ym === NOW_YM) firstDays.set(year, value);
      else firstDays.set(year, ym < SNPP_YM ? r.binomial(value, share) : round(value * share, 1));
    }
    rows.push({
      year,
      month,
      value,
      modis_raw: modisRaw,
      viirs_raw: viirsRaw,
      provisional: ym > SP_UNTIL_YM,
      partial_coverage: ym < AQUA_YM || ym === SNPP_YM || (spec.extraPartial ?? []).includes(ym),
    });
  }
  return { rows, firstDays };
}

function analyze(rows) {
  const inBaseline = (year) => year >= BASELINE.start_year && year <= BASELINE.end_year;
  const medians = Array.from({ length: 12 }, (_, i) =>
    median(rows.filter((row) => row.month === i + 1 && inBaseline(row.year)).map((row) => row.value)),
  );
  const mean = medians.reduce((a, b) => a + b, 0) / 12;
  const fireSeason = medians.flatMap((m, i) => (m > mean ? [i + 1] : []));
  const months = rows.map((row) => {
    const med = medians[row.month - 1];
    const peers =
      row.year >= BASELINE.start_year
        ? rows.filter((o) => o.month === row.month && o.year >= BASELINE.start_year && o.year <= row.year)
        : null;
    return {
      year: row.year,
      month: row.month,
      value: row.value,
      modis_raw: row.modis_raw,
      viirs_raw: row.viirs_raw,
      median: med,
      anomaly_log2: med >= 1 ? round(Math.log2((row.value + 1) / (med + 1)), 2) : null,
      difference: round(row.value - med, 1),
      rank: peers ? 1 + peers.filter((o) => o.value > row.value).length : null,
      of_years: peers ? peers.length : null,
      provisional: row.provisional,
      partial_coverage: row.partial_coverage,
    };
  });
  return { months, fireSeason, medians };
}

function currentMonth(firstDays, nowRow) {
  const baseline = [...firstDays]
    .filter(([year]) => year >= BASELINE.start_year && year <= BASELINE.end_year)
    .map(([, value]) => value);
  const peers = [...firstDays].filter(([year]) => year >= BASELINE.start_year && year <= NOW.year);
  const value = firstDays.get(NOW.year);
  return {
    year: NOW.year,
    month: NOW.month,
    days_covered: NOW.days,
    value,
    median: median(baseline),
    rank: 1 + peers.filter(([, v]) => v > value).length,
    of_years: peers.length,
    provisional: true,
    partial_coverage: nowRow.partial_coverage,
  };
}

function calendarBody(regionId, box, fireSeason, months) {
  return {
    region_id: regionId,
    units: UNITS,
    data_version: DATA_VERSION,
    weight_method: WEIGHT_METHOD,
    clipped_fraction: 0,
    aoi: aoiBlock(box),
    baseline: BASELINE,
    fire_season: fireSeason,
    months,
  };
}

const rawMonths = (months) =>
  months.map((m) => ({
    ...m,
    value: null,
    median: null,
    anomaly_log2: null,
    difference: null,
    rank: null,
    of_years: null,
  }));

function assert(condition, message) {
  if (!condition) throw new Error(`mock check failed: ${message}`);
}

// Rice-straw burning peaks in October and November; wheat stubble in May and June. Burning
// declines after 2016 as straw collection spreads.
const NILE_CLIM = [1.0, 0.5, 0.7, 2.5, 10, 16, 8, 12, 25, 210, 110, 6];
const nileTrend = (year) => {
  if (year <= 2008) return 1.2;
  if (year <= 2015) return 1.2 - ((year - 2008) / 7) * 0.2;
  if (year <= 2020) return 1.0 - ((year - 2015) / 5) * 0.45;
  return 0.55;
};
const NILE_BOX = [30.8, 30.6, 31.4, 31.1];
const nile = simulateArea({
  seed: 20261113,
  clim: NILE_CLIM,
  trend: nileTrend,
  seasonStart: 1,
  seasonSigma: 0.2,
  viirsPerModis: 7.2,
  nowShare: 0.72,
  extraPartial: [202611],
});
const nileStats = analyze(nile.rows);
const nileNow = nile.rows.at(-1);
const nileCurrent = currentMonth(nile.firstDays, nileNow);
assert(nileStats.fireSeason.join() === "10,11", `nile fire season ${nileStats.fireSeason}`);
assert(nileStats.medians.some((m) => m < 1), "nile needs a median below 1 for a null anomaly");
assert(nile.rows.some((row) => row.value === 0), "nile needs a zero month");
assert(nileCurrent.value === nileNow.value, "current month must equal the calendar's last month");

// Fire season December to February, prescribed burning in autumn, Black Summer in 2019-20 and
// quiet La Nina seasons.
const SE_CLIM = [60, 40, 14, 13, 12, 3, 2, 3, 6, 12, 14, 55];
const SE_BOX = [148.0, -37.8, 149.5, -36.5];
const seAustralia = simulateArea({
  seed: 1912,
  clim: SE_CLIM,
  trend: () => 1,
  seasonStart: 7,
  seasonSigma: 0.55,
  dampedSeasons: { 2010: 0.35, 2011: 0.4, 2021: 0.35, 2022: 0.4 },
  events: { 200212: 4, 200301: 10, 200612: 6, 200701: 5, 201910: 3, 201911: 8, 201912: 25, 202001: 18, 202002: 3 },
  viirsPerModis: 3.4,
  nowShare: 0.4,
});
const seStats = analyze(seAustralia.rows);
assert(seStats.fireSeason.join() === "1,2,12", `se_australia fire season ${seStats.fireSeason}`);

// Whole-region monthly totals for the method page. Folds are the leave-years-out pairs, then the
// 2020 to 2025 block.
function simulateValidation(seed) {
  const r = makeRandom(seed);
  const months = [];
  for (const ym of yms(201201, 202512)) {
    const year = Math.floor(ym / 100);
    const month = ym % 100;
    const expected = NILE_CLIM[month - 1] * 4 * nileTrend(year) * r.lognormal(0.25);
    const viirsDays = ym === SNPP_YM ? 12 / 31 : 1;
    const viirsRaw = r.poisson(expected * 7.2 * viirsDays * r.lognormal(0.1));
    const harmonized = viirsRaw / 7.2 / viirsDays;
    const pair = year - (year % 2);
    months.push({
      ym,
      modis: r.poisson(expected * (year >= 2020 ? 0.92 : 1)),
      viirs_raw: viirsRaw,
      ratio: round(harmonized * r.lognormal(0.2), 1),
      model: round(harmonized * r.lognormal(0.1), 1),
      fold: year <= 2019 ? `${pair}-${pair + 1}` : "2020-2025",
    });
  }
  const n20 = months
    .filter((m) => m.ym >= 201804)
    .map((m) => ({ ym: m.ym, snpp: m.model, n20: round(m.model * 1.02 * r.lognormal(0.07), 1) }));
  return { months, n20 };
}

function scores(rows, key) {
  const byYear = new Map();
  for (const row of rows) {
    const year = Math.floor(row.ym / 100);
    const sums = byYear.get(year) ?? { truth: 0, estimate: 0 };
    sums.truth += row.modis;
    sums.estimate += row[key];
    byYear.set(year, sums);
  }
  const errors = [...byYear.values()].map(({ truth, estimate }) => (Math.abs(estimate - truth) / truth) * 100);
  return {
    annual_error_pct: round(errors.reduce((a, b) => a + b, 0) / errors.length, 1),
    monthly_r: round(
      pearson(
        rows.map((row) => row[key]),
        rows.map((row) => row.modis),
      ),
      3,
    ),
  };
}

function regionScores(regionId, rows) {
  const [raw, ratio, model] = ["viirs_raw", "ratio", "model"].map((key) => scores(rows, key));
  return {
    region_id: regionId,
    annual_error_pct: { raw: raw.annual_error_pct, ratio: ratio.annual_error_pct, model: model.annual_error_pct },
    monthly_r: { raw: raw.monthly_r, ratio: ratio.monthly_r, model: model.monthly_r },
  };
}

const nileValidation = simulateValidation(4242);
const nileLyo = regionScores(
  "nile_delta",
  nileValidation.months.filter((m) => m.ym <= 201912),
);
const nileBlock = regionScores(
  "nile_delta",
  nileValidation.months.filter((m) => m.ym >= 202001),
);
const nileSeamYears = nileValidation.n20.map((m) => ({ ym: m.ym, modis: m.snpp, n20: m.n20 }));
const nileSeam = scores(nileSeamYears, "n20");

const scored = (region_id, annual, r) => ({
  region_id,
  annual_error_pct: { raw: annual[0], ratio: annual[1], model: annual[2] },
  monthly_r: { raw: r[0], ratio: r[1], model: r[2] },
});
const lyo = [
  nileLyo,
  scored("california", [212.4, 9.8, 6.2], [0.97, 0.98, 0.98]),
  scored("se_australia", [168.3, 11.2, 7.5], [0.98, 0.98, 0.99]),
  scored("n_argentina", [305.7, 12.9, 16.8], [0.93, 0.94, 0.89]),
];
const block = [
  nileBlock,
  scored("california", [241.0, 13.1, 8.4], [0.95, 0.96, 0.97]),
  scored("se_australia", [190.6, 14.4, 9.9], [0.97, 0.97, 0.98]),
  scored("n_argentina", [330.2, 17.5, 19.3], [0.9, 0.91, 0.87]),
];
const passes = (s) => s.annual_error_pct.model <= 15 && s.monthly_r.model >= 0.9;
const passedRegions = lyo.filter((s, i) => passes(s) && passes(block[i])).length;
const meanError = (method) =>
  [...lyo, ...block].reduce((sum, s) => sum + s.annual_error_pct[method], 0) / (lyo.length + block.length);
const decisionMethod = passedRegions >= 3 && meanError("model") < meanError("ratio") ? "model_v1" : "ratio_v1";
assert(decisionMethod === WEIGHT_METHOD, `decision ${decisionMethod} must match metadata ${WEIGHT_METHOD}`);

const validationSummary = {
  decision: {
    method: decisionMethod,
    passed_regions: passedRegions,
    rule:
      "Ship model_v1 when, on held-out years (leave-years-out 2012-2019 and the 2020-2025 block), its annual " +
      "totals are within 15% of MODIS and its monthly correlation is at least 0.9 in at least 3 of 4 regions, " +
      "and its annual error is lower than ratio_v1's; otherwise ship ratio_v1.",
  },
  lyo_2012_2019: lyo,
  block_2020_2025: block,
  n20_seam: [
    { region_id: "nile_delta", ...nileSeam },
    { region_id: "california", annual_error_pct: 2.1, monthly_r: 0.99 },
    { region_id: "se_australia", annual_error_pct: 3.4, monthly_r: 0.98 },
    { region_id: "n_argentina", annual_error_pct: 4.8, monthly_r: 0.97 },
  ],
};

// Probability that MODIS detects a fire VIIRS saw, logistic in log10(FRP).
const FRP = [0.5, 1, 2, 3, 5, 7, 10, 15, 20, 30, 50, 70, 100, 150, 200, 300, 500];
const CURVES = { all: -3.0, forest: -2.6, shrubland: -2.8, savanna: -2.9, grassland: -3.0, cropland: -3.4 };
const detectionCurve = {
  frp_mw: FRP,
  curves: Object.entries(CURVES).map(([land_class, intercept]) => ({
    land_class,
    p: FRP.map((frp) => round(1 / (1 + Math.exp(-(intercept + 3.0 * Math.log10(frp)))), 3)),
  })),
};

const nileRegion = REGIONS[0];
const regionCells = {
  region_id: nileRegion.id,
  cells: cellsInBox(nileRegion.bbox).map(({ cell_id }) => ({ cell_id, covered: 1 })),
};

function makeHotspots(seed) {
  const r = makeRandom(seed);
  const [west, south, east, north] = NILE_BOX;
  const rows = [];
  const add = (count, base) => {
    for (let i = 0; i < count; i += 1) {
      const lat = round(south + r.uniform() * (north - south), 5);
      const lon = round(west + r.uniform() * (east - west), 5);
      const date = base.dates[i % base.dates.length];
      const time = base.times[i % base.times.length];
      const modis = base.satellite === "Terra" || base.satellite === "Aqua";
      const weight = base.weight === "viirs" ? round(0.06 + r.uniform() * 0.24, 4) : base.weight;
      rows.push({
        hotspot_id: createHash("sha1")
          .update(`${base.satellite}|${date}|${time}|${lat.toFixed(5)}|${lon.toFixed(5)}`)
          .digest("hex")
          .slice(0, 16),
        satellite: base.satellite,
        sensor: modis ? "MODIS" : "VIIRS_375",
        acq_utc: `${date}T${time.slice(0, 2)}:${time.slice(2)}Z`,
        acq_date: date,
        lat,
        lon,
        daynight: Number(time.slice(0, 2)) >= 6 && Number(time.slice(0, 2)) < 18 ? "D" : "N",
        frp_mw: round(modis ? 6 + r.uniform() * 30 : 0.6 + r.uniform() * 4.5, 2),
        confidence: modis ? String(Math.floor(40 + r.uniform() * 55)) : ["l", "n", "n", "h"][i % 4],
        fire_type: base.fire_type,
        processing: base.processing,
        in_series: base.in_series,
        weight,
        weight_method: WEIGHT_METHOD,
        cell_id: cellOf(lat, lon),
      });
    }
  };
  const sp = { fire_type: 0, processing: "SP" };
  const nrt = { fire_type: null, processing: "NRT" };
  add(3, { ...sp, satellite: "Terra", dates: ["2008-10-14", "2008-10-21"], times: ["0842"], in_series: true, weight: 1 });
  add(3, { ...sp, satellite: "Aqua", dates: ["2008-10-17", "2008-10-24"], times: ["1118"], in_series: true, weight: 1 });
  add(8, { ...sp, satellite: "S-NPP", dates: ["2025-10-08", "2025-10-15", "2025-10-21"], times: ["1052", "2310"], in_series: true, weight: "viirs" });
  add(3, { ...sp, satellite: "NOAA-20", dates: ["2025-10-15", "2025-10-21"], times: ["1002"], in_series: false, weight: "viirs" });
  add(3, { ...sp, satellite: "Aqua", dates: ["2025-10-15", "2025-10-21"], times: ["1124"], in_series: false, weight: 1 });
  add(1, { ...sp, fire_type: 2, satellite: "S-NPP", dates: ["2025-10-11"], times: ["1046"], in_series: false, weight: null });
  add(4, { ...nrt, satellite: "NOAA-20", dates: ["2026-11-03", "2026-11-07", "2026-11-12"], times: ["1014", "2236"], in_series: true, weight: "viirs" });
  add(1, { ...nrt, satellite: "NOAA-20", dates: ["2026-11-09"], times: ["1008"], in_series: false, weight: null });
  add(1, { ...nrt, satellite: "Aqua", dates: ["2026-11-07"], times: ["1131"], in_series: false, weight: 1 });
  return rows.sort((a, b) => a.cell_id - b.cell_id || a.acq_utc.localeCompare(b.acq_utc));
}

const metadata = {
  data_version: DATA_VERSION,
  units: UNITS,
  grid_deg: 0.05,
  regions: REGIONS.map((region) => ({
    ...region,
    coverage: { start: "2000-11-01", sp_until: "2026-06-30", nrt_until: "2026-11-13" },
  })),
  method: {
    weight_method: WEIGHT_METHOD,
    model_version: MODEL_VERSION,
    calibration_years: "2012-2019",
    baseline: "2003-2025",
    viirs_switch: "2026-11-02",
  },
  attribution: ATTRIBUTION,
};

// Arrays of flat objects get one object per line so diffs stay readable.
function format(value, indent = "", inArray = false) {
  const isPrimitive = (v) => v === null || typeof v !== "object";
  const isFlat = (v) =>
    Object.values(v).every((x) => isPrimitive(x) || (Array.isArray(x) && x.every(isPrimitive)));
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.every(isPrimitive)) return JSON.stringify(value);
    return `[\n${value.map((v) => inner + format(v, inner, true)).join(",\n")}\n${indent}]`;
  }
  if (!isPrimitive(value)) {
    const inline = JSON.stringify(value);
    if (isFlat(value) && (inArray || inline.length <= 160)) return inline;
    const entries = Object.entries(value).map(([k, v]) => `${inner}${JSON.stringify(k)}: ${format(v, inner)}`);
    return `{\n${entries.join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

const files = {
  "metadata.json": metadata,
  "calendar-nile_delta-harmonized.json": calendarBody("nile_delta", NILE_BOX, nileStats.fireSeason, nileStats.months),
  "calendar-nile_delta-raw.json": calendarBody("nile_delta", NILE_BOX, [], rawMonths(nileStats.months)),
  "calendar-se_australia-harmonized.json": calendarBody("se_australia", SE_BOX, seStats.fireSeason, seStats.months),
  "current-month.json": nileCurrent,
  "validation_summary.json": validationSummary,
  "validation-nile_delta.json": nileValidation,
  "detection_curve.json": detectionCurve,
  "region_cells-nile_delta.json": regionCells,
  "hotspots-nile_delta.json": makeHotspots(77),
  "aoi.json": { nile_delta: boxPolygon(NILE_BOX), se_australia: boxPolygon(SE_BOX) },
};

mkdirSync(OUT, { recursive: true });
for (const [name, data] of Object.entries(files)) {
  writeFileSync(new URL(name, OUT), `${format(data)}\n`);
}
console.log(
  `wrote ${Object.keys(files).length} files; nile season ${nileStats.fireSeason}, se season ${seStats.fireSeason}, ` +
    `current month ${nileCurrent.value} vs median ${nileCurrent.median} (rank ${nileCurrent.rank}/${nileCurrent.of_years}), ` +
    `decision ${decisionMethod} with ${passedRegions} regions`,
);
