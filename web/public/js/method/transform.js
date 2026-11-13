import { TIME } from "../../shared/contracts.js";
import { markColor, rampColor } from "../calendar/color.js";
import { MONTH_LONG } from "../calendar/transform.js";
import { METHOD_PALETTE } from "./palette.js";

/**
 * @typedef {import("../../shared/contracts.js").WeightMethod} WeightMethod
 * @typedef {import("./palette.js").LineStyle} LineStyle
 * @typedef {{ raw: number, ratio: number, model?: number | null }} MethodScores
 * @typedef {{ region_id: string, annual_error_pct: MethodScores, monthly_r: MethodScores }} RegionScores
 * @typedef {{ decision: { method: WeightMethod, passed_regions: number, rule: string },
 *   lyo_2012_2019: RegionScores[], block_2020_2025: RegionScores[],
 *   n20_seam: { region_id: string, annual_error_pct: number, monthly_r: number }[] }} ValidationSummary
 * @typedef {{ ym: number, modis: number, viirs_raw: number, ratio: number, model?: number | null, fold: string }} ValidationMonth
 * @typedef {{ months: ValidationMonth[], n20: { ym: number, snpp: number, n20: number }[] }} RegionValidation
 * @typedef {{ frp_mw: number[], curves: { land_class: string, p: number[] }[] }} DetectionCurve
 * @typedef {{ region_id: string, month: number, satellite: "S-NPP" | "NOAA-20", value: number,
 *   level: "region_month" | "pooled_3month" | "region_year" }} KRow
 * @typedef {{ id: string, name: string }} RegionName
 *
 * The body of GET /api/method (api/method.js).
 * @typedef {object} MethodBody
 * @property {string | null} data_version
 * @property {string | null} published_at
 * @property {{ weight_method: WeightMethod, model_version: string | null, calibration_years: string,
 *   baseline: string, viirs_switch: string }} method
 * @property {RegionName[]} regions
 * @property {string} attribution
 * @property {string[]} mock
 * @property {ValidationSummary | null} validation_summary
 * @property {Record<string, RegionValidation | null>} validation
 * @property {DetectionCurve | null} detection_curve
 * @property {KRow[] | null} k_table
 */

// The RFC decision rule's limits. The decision itself is P09's; these only mark the scorecard.
export const ANNUAL_ERROR_LIMIT_PCT = 15;
export const MIN_MONTHLY_R = 0.9;

export const WEIGHT_METHOD_NAMES = Object.freeze({
  ratio_v1: "the ratio method (ratio_v1)",
  model_v1: "the detection model (model_v1)",
});

export const SCORE_METHOD_NAMES = Object.freeze({ raw: "Raw VIIRS", ratio: "Ratio", model: "Model" });
const SCORE_METHOD_WORDS = Object.freeze({ raw: "raw VIIRS", ratio: "ratio", model: "model" });

export const SEAM_SERIES_NAMES = Object.freeze({
  modis: "MODIS",
  viirs_raw: "Raw VIIRS",
  ratio: "Harmonized, ratio",
  model: "Harmonized, model",
});

export const N20_SERIES_NAMES = Object.freeze({ snpp: "S-NPP, harmonized", n20: "NOAA-20, harmonized" });

export const K_LEVEL_NAMES = Object.freeze({
  region_month: "from the region and month",
  pooled_3month: "pooled with the two adjacent months",
  region_year: "one value for the region's whole year",
});

const SATELLITE_ORDER = Object.freeze(["S-NPP", "NOAA-20"]);
const LAND_CLASS_ORDER = Object.freeze(["all", "cropland", "forest", "shrubland", "savanna", "grassland", "wetland", "other", "unknown"]);

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const yearOf = (ym) => Math.trunc(ym / 100);
const monthOf = (ym) => ym % 100;

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const correlation = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const twoSignificant = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 2 });
const factor = new Intl.NumberFormat("en-US", { minimumSignificantDigits: 2, maximumSignificantDigits: 2 });

export const formatCount = (value) => integer.format(value);
export const formatValue = (value) => oneDecimal.format(value);
export const formatPercent = (value) => `${oneDecimal.format(value)}%`;
export const formatR = (value) => correlation.format(value);
export const formatFrp = (value) => twoSignificant.format(value);
export const formatFactor = (value) => factor.format(value);

/** A multiple such as "7.9" or "1.02": two decimals below 2, one below 10, none above. */
export function formatMultiple(value) {
  if (value >= 10) return integer.format(value);
  return value.toFixed(value >= 2 ? 1 : 2);
}

/** "2012–13" for the fold "2012-2013"; one year stays as it is. */
export function foldLabel(from, to) {
  if (from === to) return String(from);
  const sameCentury = Math.trunc(from / 100) === Math.trunc(to / 100);
  return `${from}–${sameCentury ? String(to).slice(2) : to}`;
}

/** "12–13" for narrow charts. */
export function shortFoldLabel(from, to) {
  const yy = (year) => String(year).slice(2);
  return from === to ? yy(from) : `${yy(from)}–${yy(to)}`;
}

/** @param {number} ym */
export const monthLabel = (ym) => `${MONTH_LONG[monthOf(ym) - 1]} ${yearOf(ym)}`;

/**
 * Position of a month on a chart's x axis, in years: the middle of the month, so January 2012
 * sits at 2012 + 1/24 and the year boundaries fall on whole numbers.
 * @param {number} ym
 */
export const monthX = (ym) => yearOf(ym) + (monthOf(ym) - 0.5) / 12;
const monthStartX = (ym) => yearOf(ym) + (monthOf(ym) - 1) / 12;
const monthEndX = (ym) => yearOf(ym) + monthOf(ym) / 12;

/** "2 November 2026" for "2026-11-02". */
export function formatDate(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return `${day} ${MONTH_LONG[month - 1]} ${year}`;
}

/** @param {RegionName[]} regions */
const nameMap = (regions) => new Map(regions.map((region) => [region.id, region.name]));

/**
 * Region ids in display order, then any others in order of appearance.
 * @param {RegionName[]} regions
 * @param {Iterable<string>} ids
 */
function regionOrder(regions, ids) {
  const seen = new Set(ids);
  const order = regions.map((region) => region.id).filter((id) => seen.has(id));
  for (const id of seen) if (!order.includes(id)) order.push(id);
  return order;
}

/** @param {readonly any[]} rows @param {string} key */
const total = (rows, key) => rows.reduce((sum, row) => sum + (isNumber(row[key]) ? row[key] : 0), 0);

/**
 * Consecutive months that share a `fold`, as x-axis bands. Folds that start after the
 * calibration years are the held-out block; the others are leave-two-years-out folds.
 * @param {ValidationMonth[]} months sorted by `ym`
 */
export function foldBands(months) {
  /** @type {{ fold: string, label: string, shortLabel: string, kind: "lyo" | "block", shade: number, start: number, end: number, months: number }[]} */
  const bands = [];
  for (const month of months) {
    const last = bands.at(-1);
    if (last && last.fold === month.fold) {
      last.end = monthEndX(month.ym);
      last.months += 1;
      continue;
    }
    const [from, to] = month.fold.split("-").map(Number);
    const kind = from > TIME.CALIBRATION.end_year ? "block" : "lyo";
    const shade = kind === "lyo" ? bands.filter((band) => band.kind === "lyo").length % 2 : 0;
    bands.push({
      fold: month.fold,
      label: foldLabel(from, to),
      shortLabel: shortFoldLabel(from, to),
      kind,
      shade,
      start: monthStartX(month.ym),
      end: monthEndX(month.ym),
      months: 1,
    });
  }
  return bands;
}

/**
 * @typedef {{ key: string, label: string, style: LineStyle, shipped: boolean, values: (number | null)[] }} LineSeries
 * @typedef {ReturnType<typeof seamModel>} SeamModel
 */

/**
 * Monthly MODIS, raw VIIRS and harmonized VIIRS for one region, from `validation:<region>`.
 * @param {RegionValidation} validation
 * @param {{ regionId: string, name: string, shipped: WeightMethod, lyo?: RegionScores | null,
 *   block?: RegionScores | null, palette?: typeof METHOD_PALETTE }} context
 */
export function seamModel(validation, { regionId, name, shipped, lyo = null, block = null, palette = METHOD_PALETTE }) {
  const months = [...validation.months].sort((a, b) => a.ym - b.ym);
  const hasModel = months.some((month) => isNumber(month.model));
  const keys = hasModel ? ["modis", "viirs_raw", "ratio", "model"] : ["modis", "viirs_raw", "ratio"];
  const shippedKey = shipped === "model_v1" ? "model" : "ratio";
  /** @type {LineSeries[]} */
  const series = keys.map((key) => ({
    key,
    label: SEAM_SERIES_NAMES[key],
    style: palette.seam[key],
    shipped: key === shippedKey,
    values: months.map((month) => (isNumber(month[key]) ? month[key] : null)),
  }));
  const totals = Object.fromEntries(keys.map((key) => [key, total(months, key)]));
  const peak = months.reduce((best, month) => (!best || month.modis > best.modis ? month : best), null);
  const model = {
    regionId,
    name,
    months,
    x: months.map((month) => monthX(month.ym)),
    series,
    folds: foldBands(months),
    totals,
    hasModel,
    peak,
    lyo,
    block,
    description: "",
  };
  model.description = describeSeam(model);
  return model;
}

/** @param {number} value @param {number} reference */
const multiple = (value, reference) => (reference > 0 ? value / reference : null);

/** Text alternative for a seam chart. @param {Omit<SeamModel, "description">} model */
export function describeSeam(model) {
  const { name, months, totals } = model;
  if (months.length === 0) return `${name}: no validation months.`;
  const parts = [
    `${name}: monthly hotspots from ${monthLabel(months[0].ym)} to ${monthLabel(months.at(-1).ym)} (${months.length} months).`,
  ];
  const raw = multiple(totals.viirs_raw, totals.modis);
  if (raw !== null) {
    const harmonized = [`with the ratio method, ${formatMultiple(multiple(totals.ratio, totals.modis))} times`];
    if (model.hasModel) harmonized.push(`with the model, ${formatMultiple(multiple(totals.model, totals.modis))} times`);
    parts.push(`Raw VIIRS counted ${formatMultiple(raw)} times as many hotspots as MODIS; harmonized ${harmonized.join("; ")}.`);
  }
  const errors = (scores) =>
    scoreMethods(scores)
      .filter((method) => isNumber(scores.annual_error_pct[method]))
      .map((method) => `${SCORE_METHOD_WORDS[method]} ${formatPercent(scores.annual_error_pct[method])}`)
      .join(", ");
  if (model.lyo) {
    parts.push(`Held-out annual error in ${TIME.CALIBRATION.start_year}–${TIME.CALIBRATION.end_year}: ${errors(model.lyo)}.`);
  }
  if (model.block) parts.push(`In 2020–2025: ${errors(model.block)}.`);
  if (model.peak && model.peak.modis > 0) {
    const others = [`raw VIIRS ${formatCount(model.peak.viirs_raw)}`, `ratio ${formatValue(model.peak.ratio)}`];
    if (isNumber(model.peak.model)) others.push(`model ${formatValue(model.peak.model)}`);
    parts.push(`MODIS peaked in ${monthLabel(model.peak.ym)} with ${formatCount(model.peak.modis)} hotspots (${others.join(", ")}).`);
  }
  if (model.folds.length > 0) {
    parts.push(`Shaded bands mark the held-out folds: ${model.folds.map((band) => band.label).join(", ")}.`);
  }
  return parts.join(" ");
}

/** @param {RegionScores} scores */
const scoreMethods = (scores) =>
  isNumber(scores.annual_error_pct.model) || isNumber(scores.monthly_r.model) ? ["raw", "ratio", "model"] : ["raw", "ratio"];

/**
 * @typedef {ReturnType<typeof n20Model>} N20Model
 */

/**
 * Harmonized S-NPP against harmonized NOAA-20 for one region, from `validation:<region>.n20`.
 * @param {RegionValidation} validation
 * @param {{ regionId: string, name: string, score?: { annual_error_pct: number, monthly_r: number } | null,
 *   palette?: typeof METHOD_PALETTE }} context
 */
export function n20Model(validation, { regionId, name, score = null, palette = METHOD_PALETTE }) {
  const months = [...validation.n20].sort((a, b) => a.ym - b.ym);
  /** @type {LineSeries[]} */
  const series = ["snpp", "n20"].map((key) => ({
    key,
    label: N20_SERIES_NAMES[key],
    style: palette.n20[key],
    shipped: false,
    values: months.map((month) => month[key]),
  }));
  const totals = { snpp: total(months, "snpp"), n20: total(months, "n20") };
  const model = { regionId, name, months, x: months.map((month) => monthX(month.ym)), series, totals, score, description: "" };
  model.description = describeN20(model);
  return model;
}

/** @param {Omit<N20Model, "description">} model */
export function describeN20(model) {
  const { name, months, totals, score } = model;
  if (months.length === 0) return `${name}: no months where both S-NPP and NOAA-20 were harmonized.`;
  const parts = [
    `${name}: harmonized monthly hotspots from S-NPP and from NOAA-20, ${monthLabel(months[0].ym)} to ${monthLabel(months.at(-1).ym)} (${months.length} months).`,
  ];
  const ratio = multiple(totals.n20, totals.snpp);
  if (ratio !== null) parts.push(`NOAA-20 totals ${formatMultiple(ratio)} times S-NPP.`);
  if (score) parts.push(`Annual error ${formatPercent(score.annual_error_pct)}, monthly correlation ${formatR(score.monthly_r)}.`);
  return parts.join(" ");
}

/**
 * @typedef {{ value: number | null, passes: boolean | null }} ScoreCell
 * @typedef {ReturnType<typeof scorecard>} Scorecard
 */

/** @param {number | null | undefined} value @param {(value: number) => boolean} rule @returns {ScoreCell} */
const scoreCell = (value, rule) => (isNumber(value) ? { value, passes: rule(value) } : { value: null, passes: null });
const withinError = (value) => value <= ANNUAL_ERROR_LIMIT_PCT;
const highR = (value) => value >= MIN_MONTHLY_R;

/**
 * The validation scorecard, with each score marked against the decision rule's limits.
 * @param {ValidationSummary} summary
 * @param {{ regions: RegionName[], shipped: WeightMethod }} context
 */
export function scorecard(summary, { regions, shipped }) {
  const names = nameMap(regions);
  const all = [...summary.lyo_2012_2019, ...summary.block_2020_2025];
  const hasModel = all.some((row) => scoreMethods(row).includes("model"));
  const methods = hasModel ? ["raw", "ratio", "model"] : ["raw", "ratio"];
  const order = regionOrder(regions, [...all, ...summary.n20_seam].map((row) => row.region_id));
  /** @param {RegionScores[]} list */
  const table = (list) =>
    order
      .map((id) => list.find((row) => row.region_id === id))
      .filter(Boolean)
      .map((row) => ({
        regionId: row.region_id,
        name: names.get(row.region_id) ?? row.region_id,
        annual: methods.map((method) => scoreCell(row.annual_error_pct[method], withinError)),
        r: methods.map((method) => scoreCell(row.monthly_r[method], highR)),
      }));
  const calibration = TIME.CALIBRATION;
  const decision = {
    method: summary.decision.method,
    modelRan: hasModel,
    passed: summary.decision.passed_regions,
    of: summary.lyo_2012_2019.length || regions.length,
    rule: summary.decision.rule,
    shipped,
    agrees: shipped === summary.decision.method,
  };
  const card = {
    methods,
    hasModel,
    tests: [
      {
        id: "lyo_2012_2019",
        years: `${calibration.start_year}–${calibration.end_year}`,
        title: `Leave two years out, ${calibration.start_year}–${calibration.end_year}`,
        note: "Each pair of years is predicted by a fit on the other six. The decision uses this test.",
        rows: table(summary.lyo_2012_2019),
      },
      {
        id: "block_2020_2025",
        years: "2020–2025",
        title: "Held-out block, 2020–2025",
        note: `Predicted by a fit on ${calibration.start_year}–${calibration.end_year}. MODIS orbit drift makes this a harder test for every method.`,
        rows: table(summary.block_2020_2025),
      },
    ],
    n20: order
      .map((id) => summary.n20_seam.find((row) => row.region_id === id))
      .filter(Boolean)
      .map((row) => ({
        regionId: row.region_id,
        name: names.get(row.region_id) ?? row.region_id,
        annual: scoreCell(row.annual_error_pct, withinError),
        r: scoreCell(row.monthly_r, highR),
      })),
    decision,
    description: "",
  };
  card.description = describeDecision(decision);
  return card;
}

/** @param {Scorecard["decision"]} decision */
export function describeDecision(decision) {
  const parts = [`${capitalize(WEIGHT_METHOD_NAMES[decision.method])} ships.`];
  if (decision.modelRan) {
    parts.push(
      `On the leave-two-years-out test the model met both limits (annual totals within ${ANNUAL_ERROR_LIMIT_PCT}% of MODIS and a monthly correlation of at least ${MIN_MONTHLY_R}) in ${decision.passed} of ${decision.of} regions.`,
    );
  } else {
    parts.push("No detection model was validated, so the ratio method is the only candidate.");
  }
  if (!decision.agrees) parts.push(`This data version was published with ${WEIGHT_METHOD_NAMES[decision.shipped]}.`);
  return parts.join(" ");
}

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The FRP at which a detection curve first reaches `target`, interpolated linearly in log FRP.
 * Null when the curve does not cross `target` inside the FRP range.
 * @param {number[]} frp ascending
 * @param {number[]} p
 * @param {number} [target]
 */
export function frpAtProbability(frp, p, target = 0.5) {
  for (let i = 0; i < frp.length; i += 1) {
    if (p[i] === target) return frp[i];
    if (i > 0 && p[i - 1] < target && p[i] > target) {
      const f = (target - p[i - 1]) / (p[i] - p[i - 1]);
      return 10 ** (Math.log10(frp[i - 1]) + f * (Math.log10(frp[i]) - Math.log10(frp[i - 1])));
    }
  }
  return null;
}

/** @param {string} landClass */
export function landClassLabel(landClass) {
  if (landClass === "all") return "All land";
  if (landClass === "other") return "Other land";
  if (landClass === "unknown") return "Unknown land class";
  return capitalize(landClass.replaceAll("_", " "));
}

/**
 * @typedef {{ landClass: string, label: string, style: LineStyle, p: number[], half: number | null }} DetectionLine
 * @typedef {ReturnType<typeof detectionModel>} DetectionModel
 */

/**
 * One line per land class, "all" first, then the seven-class order, then any others.
 * @param {DetectionCurve} curve
 * @param {typeof METHOD_PALETTE} [palette]
 */
export function detectionModel(curve, palette = METHOD_PALETTE) {
  const rank = (landClass) => {
    const i = LAND_CLASS_ORDER.indexOf(landClass);
    return i === -1 ? LAND_CLASS_ORDER.length : i;
  };
  const curves = [...curve.curves].sort((a, b) => rank(a.land_class) - rank(b.land_class));
  let extra = 0;
  /** @type {DetectionLine[]} */
  const lines = curves.map((c) => ({
    landClass: c.land_class,
    label: landClassLabel(c.land_class),
    style: palette.detection[c.land_class] ?? palette.extraLines[extra++ % palette.extraLines.length],
    p: c.p,
    half: frpAtProbability(curve.frp_mw, c.p, 0.5),
  }));
  const model = { frp: curve.frp_mw, lines, description: "" };
  model.description = describeDetection(model);
  return model;
}

/** @param {Omit<DetectionModel, "description">} model */
export function describeDetection(model) {
  const { frp, lines } = model;
  const low = frp[0];
  const high = frp.at(-1);
  const classes = lines.filter((line) => line.landClass !== "all");
  const parts = [
    `Chance that Aqua MODIS detects a fire that VIIRS detects, by the fire's VIIRS radiative power (FRP) from ${formatFrp(low)} to ${formatFrp(high)} MW, for ${lines.length === 1 ? "all land" : `${classes.length} land classes${lines.length > classes.length ? " and all land together" : ""}`}.`,
  ];
  const evenOdds = (line) => {
    if (line.half !== null) return `about ${formatFrp(line.half)} MW`;
    return line.p[0] >= 0.5 ? `below ${formatFrp(low)} MW` : `above ${formatFrp(high)} MW`;
  };
  const all = lines.find((line) => line.landClass === "all");
  if (all) {
    parts.push(
      `Over all land MODIS detects ${formatPercent(all.p[0] * 100)} of fires at ${formatFrp(low)} MW, half at ${evenOdds(all)} and ${formatPercent(all.p.at(-1) * 100)} at ${formatFrp(high)} MW.`,
    );
  }
  if (classes.length > 0) {
    parts.push(`Even odds by land class: ${classes.map((line) => `${line.label.toLowerCase()} ${evenOdds(line)}`).join(", ")}.`);
  }
  return parts.join(" ");
}

/**
 * @typedef {{ month: number, value: number, level: KRow["level"], fill: string, ink: string }} KCell
 * @typedef {{ regionId: string, name: string, satellite: string, cells: (KCell | null)[] }} KTableRow
 * @typedef {ReturnType<typeof kModel>} KModel
 */

/**
 * The shipped method's factor per region, satellite and calendar month, colored on one linear
 * viridis scale from the smallest to the largest value.
 * @param {KRow[]} kTable
 * @param {{ regions: RegionName[], shipped: WeightMethod, palette?: typeof METHOD_PALETTE }} context
 */
export function kModel(kTable, { regions, shipped, palette = METHOD_PALETTE }) {
  const names = nameMap(regions);
  const values = kTable.map((row) => row.value);
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 0;
  const position = (value) => (max > min ? (value - min) / (max - min) : 0.5);
  const index = new Map();
  for (const row of kTable) {
    const key = `${row.region_id}|${row.satellite}|${row.month}`;
    if (!index.has(key)) index.set(key, row);
  }
  /** @type {KTableRow[]} */
  const rows = [];
  for (const regionId of regionOrder(regions, kTable.map((row) => row.region_id))) {
    for (const satellite of SATELLITE_ORDER) {
      const cells = Array.from({ length: 12 }, (_, i) => {
        const row = index.get(`${regionId}|${satellite}|${i + 1}`);
        if (!row) return null;
        const fill = rampColor(palette.sequential, position(row.value));
        return { month: i + 1, value: row.value, level: row.level, fill, ink: markColor(fill, palette.marksDark, palette.marksLight) };
      });
      if (cells.some(Boolean)) rows.push({ regionId, name: names.get(regionId) ?? regionId, satellite, cells });
    }
  }
  const levels = { region_month: 0, pooled_3month: 0, region_year: 0 };
  for (const row of index.values()) levels[row.level] += 1;
  const isRatio = shipped === "ratio_v1";
  const model = {
    symbol: isRatio ? "r" : "k",
    factorName: isRatio ? "ratio factor" : "coverage factor",
    shipped,
    min,
    max,
    rows,
    levels,
    count: index.size,
    lowest: extreme(index, names, (a, b) => a.value < b.value),
    highest: extreme(index, names, (a, b) => a.value > b.value),
    description: "",
  };
  model.description = describeK(model);
  return model;
}

function extreme(index, names, better) {
  let best = null;
  for (const row of index.values()) if (!best || better(row, best)) best = row;
  return best && { value: best.value, name: names.get(best.region_id) ?? best.region_id, satellite: best.satellite, month: best.month };
}

/** @param {Omit<KModel, "description">} model */
export function describeK(model) {
  if (model.count === 0) return `No ${model.factorName} values.`;
  const where = (cell) => `${cell.name}, ${cell.satellite}, ${MONTH_LONG[cell.month - 1]}`;
  const parts = [
    `${capitalize(model.factorName)} ${model.symbol} for ${model.rows.length} region and satellite rows by calendar month.`,
    `It ranges from ${formatFactor(model.lowest.value)} (${where(model.lowest)}) to ${formatFactor(model.highest.value)} (${where(model.highest)}).`,
  ];
  const levels = Object.entries(model.levels)
    .filter(([, count]) => count > 0)
    .map(([level, count]) => `${count} ${K_LEVEL_NAMES[level]}`);
  parts.push(`Of ${model.count} values, ${levels.join(", ")}.`);
  return parts.join(" ");
}

/**
 * Every model the method page draws, from the /api/method body. Sections whose artifact is
 * missing get null.
 * @param {MethodBody} body
 */
export function methodView(body) {
  const shipped = body.method.weight_method;
  const summary = body.validation_summary;
  const find = (list, id) => list?.find((row) => row.region_id === id) ?? null;
  const seams = body.regions.map((region) => {
    const validation = body.validation[region.id];
    return {
      regionId: region.id,
      name: region.name,
      model: validation
        ? seamModel(validation, {
            regionId: region.id,
            name: region.name,
            shipped,
            lyo: find(summary?.lyo_2012_2019, region.id),
            block: find(summary?.block_2020_2025, region.id),
          })
        : null,
    };
  });
  const n20 = body.regions.map((region) => {
    const validation = body.validation[region.id];
    return {
      regionId: region.id,
      name: region.name,
      model:
        validation && validation.n20.length > 0
          ? n20Model(validation, { regionId: region.id, name: region.name, score: find(summary?.n20_seam, region.id) })
          : null,
    };
  });
  const rawMultiples = seams
    .filter((seam) => seam.model && seam.model.totals.modis > 0)
    .map((seam) => ({ name: seam.name, value: seam.model.totals.viirs_raw / seam.model.totals.modis }));
  return {
    dataVersion: body.data_version,
    publishedAt: body.published_at,
    method: body.method,
    shipped,
    attribution: body.attribution,
    mock: {
      any: body.mock.length > 0,
      metadata: body.mock.includes("metadata"),
      validation: body.mock.includes("validation_summary"),
      detection: body.mock.includes("detection_curve"),
    },
    rawMultiples,
    seams,
    n20,
    scorecard: summary ? scorecard(summary, { regions: body.regions, shipped }) : null,
    detection: body.detection_curve ? detectionModel(body.detection_curve) : null,
    k: body.k_table && body.k_table.length > 0 ? kModel(body.k_table, { regions: body.regions, shipped }) : null,
  };
}

/** "7.9 times in the Nile Delta, Egypt and 2.1 times in California and Nevada". @param {{ name: string, value: number }[]} multiples */
export function rawMultiplesText(multiples) {
  const items = multiples.map((item) => `${formatMultiple(item.value)} times in ${item.name}`);
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join("; ")} and ${items.at(-1)}`;
}

/**
 * The shipped method's annual error on 2012-2019 against 2020-2025, per region, for the drift
 * caveat. Empty when the scorecard lacks either number for every region.
 * @param {Scorecard} card
 */
export function driftText(card) {
  const key = card.decision.shipped === "model_v1" ? "model" : "ratio";
  const column = card.methods.indexOf(key);
  if (column === -1) return "";
  const [lyo, block] = card.tests;
  const items = lyo.rows
    .map((row) => {
      const later = block.rows.find((other) => other.regionId === row.regionId);
      const before = row.annual[column].value;
      const after = later?.annual[column].value;
      return isNumber(before) && isNumber(after) ? `${row.name} ${formatPercent(before)} to ${formatPercent(after)}` : null;
    })
    .filter(Boolean);
  if (items.length === 0) return "";
  return `Annual error of ${WEIGHT_METHOD_NAMES[card.decision.shipped]}, ${lyo.years} against ${block.years}: ${items.join("; ")}.`;
}
