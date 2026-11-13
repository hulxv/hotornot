import { TIME } from "../../shared/contracts.js";
import { rampColor } from "./color.js";
import { CALENDAR_PALETTE } from "./palette.js";

/**
 * @typedef {import("../../shared/contracts.js").CalendarResponse} CalendarResponse
 * @typedef {import("../../shared/contracts.js").CalendarMonth} CalendarMonth
 * @typedef {"harmonized" | "anomaly" | "raw"} View
 * @typedef {{ view?: View, julyStart?: boolean }} RenderOptions
 * @typedef {"value" | "zero" | "no_data" | "no_history"} CellKind
 * @typedef {{ row: number, col: number, year: number, month: number, kind: CellKind,
 *   value: number | null, color: string, provisional: boolean, partial: boolean,
 *   source: CalendarMonth | null }} Cell
 * @typedef {"harmonized" | "anomaly" | "modis" | "viirs"} PanelId
 * @typedef {{ id: PanelId, label: string, cells: Cell[] }} Panel
 * @typedef {{ value: number, t: number, label: string }} Tick
 * @typedef {{ type: "log", min: number, max: number, ticks: Tick[] }} LogScale
 * @typedef {{ type: "diverging", limit: number, ticks: Tick[] }} DivergingScale
 * @typedef {{ from: number, to: number }} SeasonRun columns, inclusive
 * @typedef {{ view: View, julyStart: boolean, regionId: string, units: string, dataVersion: string,
 *   weightMethod: string, baseline: { start_year: number, end_year: number },
 *   aoi: CalendarResponse["aoi"], clippedFraction: number, fireSeason: number[],
 *   seasonRuns: SeasonRun[], columns: { month: number, label: string }[],
 *   rows: { year: number, label: string }[], panels: Panel[], scale: LogScale | DivergingScale | null,
 *   counts: { months: number, provisional: number, partial: number } }} CalendarModel
 */

export const VIEWS = Object.freeze(/** @type {const} */ (["harmonized", "anomaly", "raw"]));

export const MONTH_SHORT = Object.freeze(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
export const MONTH_LONG = Object.freeze([
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]);

const RECORD_START = { year: Number(TIME.RECORD_START.slice(0, 4)), month: Number(TIME.RECORD_START.slice(5, 7)) };

// A month more than four decades below the largest one gets the bottom color, so one stray
// fractional weight cannot stretch the ramp until every real month looks alike.
export const MAX_LOG_DECADES = 4;
// The anomaly ramp saturates at 16 times or 1/16 of the median.
export const MAX_ANOMALY_LOG2 = 4;

const ymOf = (year, month) => year * 100 + month;
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const hasData = (m) => isNumber(m.value) || isNumber(m.modis_raw) || isNumber(m.viirs_raw);

const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const tickFormat = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 2 });

export const formatNumber = (value) => decimal.format(value);
export const formatSigned = (value) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${decimal.format(Math.abs(value))}`;
/** 2 ** log2 as a multiplier with two significant digits, e.g. 0.45 gives "1.4×". */
export const formatRatio = (log2) => `${Number((2 ** log2).toPrecision(2))}×`;

export function unitsLabel(units) {
  return units === "modis_equivalent_hotspots" ? "MODIS-equivalent hotspots" : units;
}

/** @param {number} month 1 to 12 */
export function monthColumn(month, julyStart = false) {
  return julyStart ? (month + 5) % 12 : month - 1;
}

export function columnMonths(julyStart = false) {
  return Array.from({ length: 12 }, (_, col) => (julyStart ? ((col + 6) % 12) + 1 : col + 1));
}

/** The row a month falls in: its year, or with a July start the year its July-to-June season began. */
export function rowYear(year, month, julyStart = false) {
  return julyStart && month < 7 ? year - 1 : year;
}

export function rowLabel(year, julyStart = false) {
  return julyStart ? `${year}–${String((year + 1) % 100).padStart(2, "0")}` : String(year);
}

/**
 * Fire-season months as runs of adjacent columns. A season across the year boundary is one run
 * with a July start and two without.
 * @param {number[]} fireSeason calendar months 1 to 12
 * @returns {SeasonRun[]}
 */
export function seasonRuns(fireSeason, julyStart = false) {
  const columns = [...new Set(fireSeason.map((month) => monthColumn(month, julyStart)))].sort((a, b) => a - b);
  /** @type {SeasonRun[]} */
  const runs = [];
  for (const col of columns) {
    const last = runs.at(-1);
    if (last && col === last.to + 1) last.to = col;
    else runs.push({ from: col, to: col });
  }
  return runs;
}

/** Fire-season months as text, wrapping December to January: [1, 2, 12] gives "Dec–Feb". */
export function seasonText(fireSeason) {
  const months = new Set(fireSeason);
  if (months.size === 0) return "";
  if (months.size >= 12) return "all year";
  const next = (m) => (m % 12) + 1;
  const prev = (m) => ((m + 10) % 12) + 1;
  const parts = [];
  for (let start = 1; start <= 12; start += 1) {
    if (!months.has(start) || months.has(prev(start))) continue;
    let end = start;
    while (months.has(next(end))) end = next(end);
    parts.push(end === start ? MONTH_SHORT[start - 1] : `${MONTH_SHORT[start - 1]}–${MONTH_SHORT[end - 1]}`);
  }
  return parts.join(", ");
}

/**
 * Bounds of a log color scale over the positive values. NULL when nothing is positive. The range
 * spans at most MAX_LOG_DECADES below the maximum and at least one decade (widened evenly in log
 * space around a narrower range).
 * @param {Array<number | null | undefined>} values
 * @returns {{ min: number, max: number } | null}
 */
export function logBounds(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (!isNumber(value) || value <= 0) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (max === -Infinity) return null;
  min = Math.max(min, max / 10 ** MAX_LOG_DECADES);
  if (max / min < 10) {
    const middle = Math.sqrt(min * max);
    return { min: middle / Math.sqrt(10), max: middle * Math.sqrt(10) };
  }
  return { min, max };
}

/** Position of a positive value on a log scale, clamped to [0, 1]. */
export function logPosition(value, { min, max }) {
  const t = (Math.log10(value) - Math.log10(min)) / (Math.log10(max) - Math.log10(min));
  return Math.min(1, Math.max(0, t));
}

/**
 * Tick values inside the bounds: whole decades when at least three fit, otherwise the 1-2-5
 * series, and the bounds themselves when even that gives fewer than two.
 * @returns {Tick[]}
 */
export function logTicks(bounds) {
  const { min, max } = bounds;
  const inside = (v) => v >= min * (1 - 1e-9) && v <= max * (1 + 1e-9);
  const decades = [];
  const series = [];
  for (let k = Math.floor(Math.log10(min)); k <= Math.ceil(Math.log10(max)); k += 1) {
    for (const m of [1, 2, 5]) {
      const v = Number((m * 10 ** k).toPrecision(1));
      if (!inside(v)) continue;
      series.push(v);
      if (m === 1) decades.push(v);
    }
  }
  const values = decades.length >= 3 ? decades : series.length >= 2 ? series : [min, max];
  return values.map((value) => ({ value, t: logPosition(value, bounds), label: tickFormat.format(value) }));
}

/** Symmetric log2 limit of the anomaly ramp: the largest |anomaly| rounded up, from 1 to MAX_ANOMALY_LOG2. */
export function anomalyLimit(values) {
  let largest = 0;
  for (const value of values) if (isNumber(value)) largest = Math.max(largest, Math.abs(value));
  return Math.min(MAX_ANOMALY_LOG2, Math.max(1, Math.ceil(largest - 1e-9)));
}

export function anomalyPosition(value, limit) {
  return (Math.min(limit, Math.max(-limit, value)) + limit) / (2 * limit);
}

/** @returns {Tick[]} */
export function anomalyTicks(limit) {
  const step = limit > 3 ? 2 : 1;
  const ticks = [];
  for (let k = -limit; k <= limit; k += 1) {
    if (k % step !== 0) continue;
    const label = k === 0 ? "median" : k > 0 ? `${2 ** k}×` : `1/${2 ** -k}×`;
    ticks.push({ value: k, t: anomalyPosition(k, limit), label });
  }
  return ticks;
}

/**
 * First and last month the grid shows: from the record start (or an earlier response month) to the
 * last month with any data, so null months padded after it do not add rows.
 * @param {CalendarMonth[]} months
 */
export function gridExtent(months) {
  if (months.length === 0) return null;
  const yms = months.map((m) => ymOf(m.year, m.month));
  const withData = months.filter(hasData).map((m) => ymOf(m.year, m.month));
  const first = Math.min(ymOf(RECORD_START.year, RECORD_START.month), ...yms);
  const last = Math.max(...(withData.length > 0 ? withData : yms));
  return {
    first: { year: Math.floor(first / 100), month: first % 100 },
    last: { year: Math.floor(last / 100), month: last % 100 },
  };
}

const PANELS = {
  harmonized: [{ id: "harmonized", field: "value" }],
  anomaly: [{ id: "anomaly", field: "anomaly_log2" }],
  raw: [
    { id: "modis", field: "modis_raw" },
    { id: "viirs", field: "viirs_raw" },
  ],
};

/** @param {PanelId} id */
export function panelLabel(id) {
  switch (id) {
    case "modis":
      return "MODIS (Terra + Aqua), raw count";
    case "viirs":
      return `VIIRS 375 m (S-NPP, then NOAA-20 from ${TIME.VIIRS_SWITCH}), raw count`;
    case "anomaly":
      return "Anomaly";
    default:
      return "Harmonized";
  }
}

/**
 * @param {CalendarMonth | null} source
 * @param {string} field
 * @param {View} view
 * @returns {{ kind: CellKind, value: number | null }}
 */
function classify(source, field, view) {
  if (!source) return { kind: "no_data", value: null };
  if (view === "anomaly") {
    if (!isNumber(source.value)) return { kind: "no_data", value: null };
    return isNumber(source.anomaly_log2) ? { kind: "value", value: source.anomaly_log2 } : { kind: "no_history", value: null };
  }
  const value = source[field];
  if (!isNumber(value)) return { kind: "no_data", value: null };
  return value > 0 ? { kind: "value", value } : { kind: "zero", value: 0 };
}

/**
 * The response as rows of years (or July-to-June seasons) by month columns, one panel per heatmap,
 * each cell with its kind, the number it shows and its fill color.
 * @param {CalendarResponse} response
 * @param {RenderOptions} [options]
 * @param {typeof CALENDAR_PALETTE} [palette]
 * @returns {CalendarModel}
 */
export function buildCalendar(response, { view = "harmonized", julyStart = false } = {}, palette = CALENDAR_PALETTE) {
  if (!VIEWS.includes(view)) throw new RangeError(`view must be one of ${VIEWS.join(", ")}; got ${view}`);
  const months = response.months ?? [];
  const byYm = new Map(months.map((m) => [ymOf(m.year, m.month), m]));
  const columns = columnMonths(julyStart).map((month) => ({ month, label: MONTH_SHORT[month - 1] }));
  const extent = gridExtent(months);

  const rows = [];
  const slots = [];
  if (extent) {
    const lastYm = ymOf(extent.last.year, extent.last.month);
    const firstRow = rowYear(extent.first.year, extent.first.month, julyStart);
    const lastRow = rowYear(extent.last.year, extent.last.month, julyStart);
    for (let year = firstRow; year <= lastRow; year += 1) {
      const row = rows.length;
      rows.push({ year, label: rowLabel(year, julyStart) });
      columns.forEach(({ month }, col) => {
        const calendarYear = julyStart && month < 7 ? year + 1 : year;
        const ym = ymOf(calendarYear, month);
        if (ym <= lastYm) slots.push({ row, col, year: calendarYear, month, source: byYm.get(ym) ?? null });
      });
    }
  }

  const panels = PANELS[view].map(({ id, field }) => ({
    id,
    label: panelLabel(id),
    cells: slots.map((slot) => ({
      ...slot,
      ...classify(slot.source, field, view),
      color: palette.noData.fill,
      provisional: slot.source?.provisional === true,
      partial: slot.source?.partial_coverage === true,
    })),
  }));

  const shown = panels.flatMap((panel) => panel.cells.filter((cell) => cell.kind === "value").map((cell) => cell.value));
  /** @type {LogScale | DivergingScale | null} */
  let scale = null;
  if (view === "anomaly") {
    const limit = anomalyLimit(shown);
    if (shown.length > 0) scale = { type: "diverging", limit, ticks: anomalyTicks(limit) };
  } else {
    const bounds = logBounds(shown);
    if (bounds) scale = { type: "log", ...bounds, ticks: logTicks(bounds) };
  }

  for (const cell of panels.flatMap((panel) => panel.cells)) {
    if (cell.kind === "zero") cell.color = palette.zero;
    else if (cell.kind === "no_history") cell.color = palette.noHistory.fill;
    else if (cell.kind === "value" && scale?.type === "diverging") {
      cell.color = rampColor(palette.diverging, anomalyPosition(cell.value, scale.limit));
    } else if (cell.kind === "value" && scale?.type === "log") {
      cell.color = rampColor(palette.sequential, logPosition(cell.value, scale));
    }
  }

  const sources = slots.map((slot) => slot.source).filter((source) => source !== null);
  return {
    view,
    julyStart,
    regionId: response.region_id,
    units: response.units,
    dataVersion: response.data_version,
    weightMethod: response.weight_method,
    baseline: response.baseline,
    aoi: response.aoi,
    clippedFraction: response.clipped_fraction,
    fireSeason: [...(response.fire_season ?? [])],
    seasonRuns: seasonRuns(response.fire_season ?? [], julyStart),
    columns,
    rows,
    panels,
    scale,
    counts: {
      months: sources.filter(hasData).length,
      provisional: sources.filter((m) => m.provisional).length,
      partial: sources.filter((m) => m.partial_coverage).length,
    },
  };
}

/**
 * Tooltip text for one cell, first line the month. Numbers come from the response month, so a
 * cell never relies on its color alone.
 * @param {Cell} cell
 * @param {CalendarModel} model
 * @param {PanelId} panelId
 * @returns {string[]}
 */
export function tooltipLines(cell, model, panelId) {
  const lines = [`${MONTH_LONG[cell.month - 1]} ${cell.year}`];
  const m = cell.source;
  if (!m) {
    const beforeRecord = ymOf(cell.year, cell.month) < ymOf(RECORD_START.year, RECORD_START.month);
    lines.push(beforeRecord ? `No data: the record starts in ${MONTH_LONG[RECORD_START.month - 1]} ${RECORD_START.year}` : "No data");
    return lines;
  }
  const { start_year: from, end_year: to } = model.baseline;

  if (model.view === "raw") {
    const count = (value) => (isNumber(value) ? `${formatNumber(value)} hotspots` : "no data");
    const marker = (id) => (id === panelId ? " ◂" : "");
    lines.push(`MODIS raw: ${count(m.modis_raw)}${marker("modis")}`);
    lines.push(`VIIRS raw: ${count(m.viirs_raw)}${marker("viirs")}`);
  }
  if (model.view !== "raw" || isNumber(m.value)) {
    lines.push(isNumber(m.value) ? `Value: ${formatNumber(m.value)} ${unitsLabel(model.units)}` : "Value: no data");
    lines.push(`Median ${from}–${to}: ${isNumber(m.median) ? formatNumber(m.median) : "—"}`);
    lines.push(`Difference: ${isNumber(m.difference) ? formatSigned(m.difference) : "—"}`);
    if (model.view === "anomaly") {
      lines.push(
        isNumber(m.anomaly_log2)
          ? `Anomaly: ${formatRatio(m.anomaly_log2)} the median (log2 ${formatSigned(m.anomaly_log2)})`
          : "Anomaly: not enough history (median below 1)",
      );
    }
    if (isNumber(m.rank) && isNumber(m.of_years)) lines.push(`Rank ${m.rank} of ${m.of_years}`);
    else lines.push(cell.year < from ? `Rank: not ranked before ${from}` : "Rank: —");
  }
  if (m.provisional) lines.push("Provisional: includes near-real-time data that can still change");
  if (m.partial_coverage) lines.push("Partial coverage: satellite data missing for part of the month");
  return lines;
}

/** One-paragraph text alternative for screen readers. @param {CalendarModel} model */
export function describeCalendar(model) {
  if (model.rows.length === 0) return `Calendar heatmap for ${model.regionId}: no months to show.`;
  const first = model.rows[0].label;
  const last = model.rows.at(-1).label;
  const parts = [
    `Calendar heatmap for ${model.regionId}, ${model.view} view, ${first} to ${last}, ${model.counts.months} months with data.`,
  ];
  for (const panel of model.panels) {
    const top = panel.cells.filter((c) => c.kind === "value").reduce((best, c) => (!best || c.value > best.value ? c : best), null);
    if (!top) continue;
    const shown = model.view === "anomaly" ? `${formatRatio(top.value)} the median` : formatNumber(top.value);
    parts.push(`${panel.label} highest: ${MONTH_LONG[top.month - 1]} ${top.year}, ${shown}.`);
  }
  if (model.fireSeason.length > 0) parts.push(`Fire season: ${seasonText(model.fireSeason)}.`);
  parts.push(`${model.counts.provisional} provisional months, ${model.counts.partial} with partial coverage.`);
  return parts.join(" ");
}
