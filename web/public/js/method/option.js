import { escapeHtml } from "./html.js";
import { METHOD_PALETTE } from "./palette.js";
import { formatCount, formatFrp, formatValue, monthLabel } from "./transform.js";

/**
 * @typedef {import("./transform.js").SeamModel} SeamModel
 * @typedef {import("./transform.js").N20Model} N20Model
 * @typedef {import("./transform.js").DetectionModel} DetectionModel
 * @typedef {import("./transform.js").LineSeries} LineSeries
 * @typedef {{ width: number, height?: number, palette?: typeof METHOD_PALETTE }} ChartSize
 */

export const CHART_HEIGHT = Object.freeze({ seam: 260, n20: 220, detection: 340 });
const TIME_GRID = Object.freeze({ left: 46, right: 12, top: 24, bottom: 26 });
const DETECTION_GRID = Object.freeze({ left: 58, right: 16, top: 24, bottom: 48 });
const FONT_SIZE = 11;
const BAND_FONT_SIZE = 10;

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
// ECharts measures text only when it renders, so label fitting estimates the width: about
// 0.56 em per character in the system UI font.
const textWidth = (text, size) => text.length * size * 0.56;

/** Whole-year label step that keeps labels at least 40 px apart. */
export function yearStep(spanYears, plotWidth) {
  const fit = Math.max(1, Math.floor(plotWidth / 40));
  return [1, 2, 5, 10, 20, 50].find((step) => spanYears / step <= fit) ?? 50;
}

/** @param {typeof METHOD_PALETTE} palette */
function base(palette, description) {
  return {
    animation: false,
    backgroundColor: palette.background,
    textStyle: { fontFamily: palette.font, color: palette.text, fontSize: FONT_SIZE },
    aria: { enabled: true, label: { description }, decal: { show: false } },
  };
}

/** @param {typeof METHOD_PALETTE} palette */
function tooltip(palette, formatter) {
  return {
    trigger: "axis",
    confine: true,
    axisPointer: { type: "line", lineStyle: { color: palette.muted, width: 1 } },
    backgroundColor: palette.background,
    borderColor: palette.muted,
    borderWidth: 1,
    padding: [6, 8],
    textStyle: { color: palette.text, fontSize: 12, fontFamily: palette.font },
    formatter,
  };
}

/** @param {typeof METHOD_PALETTE} palette */
function axisStyle(palette) {
  return {
    axisLabel: { color: palette.text, fontSize: FONT_SIZE, fontFamily: palette.font },
    axisLine: { lineStyle: { color: palette.muted } },
    axisTick: { lineStyle: { color: palette.muted } },
  };
}

/**
 * A value axis in years with labels on whole years only.
 * @param {number} min @param {number} max @param {number} plotWidth @param {typeof METHOD_PALETTE} palette
 */
function yearAxis(min, max, plotWidth, palette) {
  const style = axisStyle(palette);
  return {
    type: "value",
    min,
    max,
    interval: yearStep(max - min, plotWidth),
    ...style,
    axisLabel: { ...style.axisLabel, formatter: (value) => (Number.isInteger(value) ? String(value) : ""), hideOverlap: true },
    splitLine: { show: false },
  };
}

/** @param {typeof METHOD_PALETTE} palette */
function countAxis(palette) {
  const style = axisStyle(palette);
  return {
    type: "value",
    min: 0,
    ...style,
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { ...style.axisLabel, formatter: (value) => compact.format(value) },
    splitLine: { lineStyle: { color: palette.grid } },
  };
}

/**
 * @param {LineSeries} line
 * @param {number[]} x
 * @param {number} z
 */
function lineSeries(line, x, z) {
  const width = line.shipped ? line.style.width + 1 : line.style.width;
  return {
    id: line.key,
    name: line.label,
    type: "line",
    data: line.values.map((value, i) => [x[i], value]),
    showSymbol: false,
    symbolSize: 6,
    connectNulls: false,
    lineStyle: { color: line.style.color, width, type: line.style.dash ?? "solid", cap: "butt" },
    itemStyle: { color: line.style.color },
    emphasis: { disabled: true },
    z,
  };
}

const formatSeries = (key, value) => (key === "modis" || key === "viirs_raw" ? formatCount(value) : formatValue(value));

/** @param {{ months: { ym: number }[], series: LineSeries[] }} model */
function monthTooltip(model) {
  return (params) => {
    const items = Array.isArray(params) ? params : [params];
    if (items.length === 0) return "";
    const month = model.months[items[0].dataIndex];
    const lines = items
      .filter((item) => item.value?.[1] !== null && item.value?.[1] !== undefined)
      .map((item) => `${item.marker}${escapeHtml(item.seriesName)}: ${formatSeries(item.seriesId, item.value[1])}`);
    return [`<b>${escapeHtml(monthLabel(month.ym))}</b>`, ...lines].join("<br>");
  };
}

/** Whole years around the months, and the folds when given. */
function yearExtent(x, bands = []) {
  const low = Math.min(...x, ...bands.map((band) => band.start));
  const high = Math.max(...x, ...bands.map((band) => band.end));
  return [Math.floor(low), Math.ceil(high)];
}

/**
 * Monthly MODIS, raw VIIRS and harmonized lines over shaded held-out folds.
 * @param {SeamModel} model
 * @param {ChartSize & { showRaw?: boolean }} size
 */
export function seamOption(model, { width, height = CHART_HEIGHT.seam, showRaw = true, palette = METHOD_PALETTE }) {
  const plotWidth = Math.max(80, width - TIME_GRID.left - TIME_GRID.right);
  const [min, max] = model.months.length > 0 ? yearExtent(model.x, model.folds) : [0, 1];
  const pxPerYear = plotWidth / (max - min);
  const lines = model.series.filter((line) => showRaw || line.key !== "viirs_raw");
  const folds = {
    id: "folds",
    name: "Held-out folds",
    type: "line",
    data: [],
    silent: true,
    z: 1,
    markArea: {
      silent: true,
      label: { position: "top", color: palette.muted, fontSize: BAND_FONT_SIZE, fontFamily: palette.font, distance: 4 },
      data: model.folds.map((band) => {
        const room = (band.end - band.start) * pxPerYear - 4;
        const label = [band.label, band.shortLabel].find((text) => textWidth(text, BAND_FONT_SIZE) <= room);
        return [
          {
            name: label ?? "",
            xAxis: band.start,
            itemStyle: {
              color: band.kind === "block" ? palette.blockShade : palette.foldShades[band.shade],
              opacity: band.kind === "block" ? 0.6 : 1,
            },
            label: { show: label !== undefined },
          },
          { xAxis: band.end },
        ];
      }),
    },
  };
  return {
    option: {
      ...base(palette, model.description),
      grid: { ...TIME_GRID },
      tooltip: tooltip(palette, monthTooltip(model)),
      xAxis: yearAxis(min, max, plotWidth, palette),
      yAxis: countAxis(palette),
      series: [folds, ...lines.map((line, i) => lineSeries(line, model.x, 2 + (line.key === "modis" ? lines.length : i)))],
    },
    height,
  };
}

/**
 * Harmonized S-NPP against harmonized NOAA-20.
 * @param {N20Model} model
 * @param {ChartSize} size
 */
export function n20Option(model, { width, height = CHART_HEIGHT.n20, palette = METHOD_PALETTE }) {
  const plotWidth = Math.max(80, width - TIME_GRID.left - TIME_GRID.right);
  const [min, max] = model.months.length > 0 ? yearExtent(model.x) : [0, 1];
  return {
    option: {
      ...base(palette, model.description),
      grid: { ...TIME_GRID, top: 12 },
      tooltip: tooltip(palette, monthTooltip(model)),
      xAxis: yearAxis(min, max, plotWidth, palette),
      yAxis: countAxis(palette),
      series: model.series.map((line, i) => lineSeries(line, model.x, 2 + i)),
    },
    height,
  };
}

/**
 * P(MODIS detects) against VIIRS FRP on a log axis, one line per land class, with the 50%
 * level and the FRP where all land reaches it.
 * @param {DetectionModel} model
 * @param {ChartSize} size
 */
export function detectionOption(model, { width, height = CHART_HEIGHT.detection, palette = METHOD_PALETTE }) {
  const style = axisStyle(palette);
  const name = { color: palette.text, fontSize: FONT_SIZE, fontFamily: palette.font };
  const all = model.lines.find((line) => line.landClass === "all");
  const guide = { color: palette.muted, width: 1, type: [4, 4] };
  const marks = [{ yAxis: 0.5, label: { formatter: "50%", position: "insideStartTop" } }];
  if (all?.half) marks.push({ xAxis: all.half, label: { formatter: `≈ ${formatFrp(all.half)} MW`, position: "end" } });
  const series = model.lines.map((line, i) => ({
    id: line.landClass,
    name: line.label,
    type: "line",
    data: model.frp.map((frp, j) => [frp, line.p[j]]),
    showSymbol: false,
    symbolSize: 6,
    lineStyle: { color: line.style.color, width: line.style.width, type: line.style.dash ?? "solid", cap: "butt" },
    itemStyle: { color: line.style.color },
    emphasis: { disabled: true },
    z: line.landClass === "all" ? 10 : 2 + i,
    ...(line === (all ?? model.lines[0])
      ? {
          markLine: {
            silent: true,
            symbol: "none",
            lineStyle: guide,
            label: { color: palette.muted, fontSize: BAND_FONT_SIZE, fontFamily: palette.font },
            data: all ? marks : marks.slice(0, 1),
          },
        }
      : {}),
  }));
  const formatter = (params) => {
    const items = Array.isArray(params) ? params : [params];
    if (items.length === 0) return "";
    const frp = model.frp[items[0].dataIndex];
    const lines = items.map((item) => `${item.marker}${escapeHtml(item.seriesName)}: ${Math.round(item.value[1] * 100)}%`);
    return [`<b>${escapeHtml(formatFrp(frp))} MW</b>`, ...lines].join("<br>");
  };
  return {
    option: {
      ...base(palette, model.description),
      grid: { ...DETECTION_GRID },
      tooltip: tooltip(palette, formatter),
      xAxis: {
        type: "log",
        logBase: 10,
        min: model.frp[0],
        max: model.frp.at(-1),
        ...style,
        axisLabel: { ...style.axisLabel, formatter: (value) => formatFrp(value), hideOverlap: true },
        splitLine: { show: true, lineStyle: { color: palette.grid } },
        name: width < 420 ? "VIIRS FRP, MW (log)" : "VIIRS fire radiative power, MW (log scale)",
        nameLocation: "middle",
        nameGap: 28,
        nameTextStyle: name,
      },
      yAxis: {
        type: "value",
        min: 0,
        max: 1,
        interval: 0.25,
        ...style,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { ...style.axisLabel, formatter: (value) => `${Math.round(value * 100)}%` },
        splitLine: { lineStyle: { color: palette.grid } },
        name: "Chance MODIS detects it",
        nameLocation: "middle",
        nameGap: 42,
        nameTextStyle: name,
      },
      series,
    },
    height,
  };
}
