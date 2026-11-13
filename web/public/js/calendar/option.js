import { edgeColor, markColor } from "./color.js";
import { CALENDAR_PALETTE } from "./palette.js";
import { MONTH_LONG, describeCalendar, formatNumber, seasonText, tooltipLines, unitsLabel } from "./transform.js";

/** @typedef {import("./transform.js").CalendarModel} CalendarModel */
/** @typedef {import("./transform.js").Cell} Cell */
/** @typedef {{ width: number, title?: string, subtitle?: string, palette?: typeof CALENDAR_PALETTE }} OptionSettings */

export const LAYOUT = Object.freeze({
  pad: 16,
  axisWidth: 72,
  cellHeight: 17,
  cellGap: 2,
  bandHeight: 6,
  bandGap: 4,
  panelGap: 18,
  panelTitle: 22,
  monthLabels: 30,
  legendBarWidth: 300,
  swatchRow: 20,
  hatchSpacing: 5,
  stripeSpacing: 3,
});

/** @typedef {[number, number, number, number]} Segment x1, y1, x2, y2 */

/**
 * "/" hatching clipped to the rectangle, one line every `spacing` px along the x + y diagonal.
 * @returns {Segment[]}
 */
export function hatchSegments(x, y, w, h, spacing) {
  const segments = [];
  for (let s = x + y + spacing; s < x + y + w + h; s += spacing) {
    const x1 = Math.max(x, s - (y + h));
    const x2 = Math.min(x + w, s - y);
    segments.push(/** @type {Segment} */ ([x1, s - x1, x2, s - x2]));
  }
  return segments;
}

/** @returns {Segment[]} */
export function stripeSegments(x, y, w, h, spacing) {
  const segments = [];
  for (let yy = y + spacing; yy < y + h; yy += spacing) segments.push(/** @type {Segment} */ ([x, yy, x + w, yy]));
  return segments;
}

const line = ([x1, y1, x2, y2], stroke) => ({ type: "line", shape: { x1, y1, x2, y2 }, style: { stroke, lineWidth: 1 } });

/**
 * ECharts graphic elements for one cell: the fill or the no-data outline, then the
 * not-enough-history stripes, the provisional hatching and the partial-coverage dot. A no-data
 * cell gets no flag marks: there is nothing in it for them to qualify. A fill below 3:1 against
 * the background (the zero gray, the anomaly ramp's center, the light end of viridis) gets a
 * 1 px edge in a darker shade of itself, so every cell stands out from the page. A highlighted
 * cell gets a 2 px outline in the text color, drawn in the gap around it.
 * @param {Pick<Cell, "kind" | "color" | "provisional" | "partial"> & { highlighted?: boolean }} cell
 */
export function cellShapes(cell, x, y, w, h, palette = CALENDAR_PALETTE) {
  const hover = { style: { stroke: palette.hover, lineWidth: 2 } };
  const fill = cell.kind === "no_data" ? palette.noData.fill : cell.color;
  const inset = { x: x + 0.5, y: y + 0.5, width: Math.max(0, w - 1), height: Math.max(0, h - 1) };
  const edge = cell.kind === "value" || cell.kind === "zero" ? edgeColor(fill, palette.background) : null;
  const shapes = [];
  if (cell.kind === "no_data") {
    shapes.push({ type: "rect", shape: inset, style: { fill, stroke: palette.noData.stroke, lineWidth: 1 }, emphasis: hover });
  } else if (edge) {
    shapes.push({ type: "rect", shape: inset, style: { fill, stroke: edge, lineWidth: 1 }, emphasis: hover });
  } else {
    shapes.push({ type: "rect", shape: { x, y, width: w, height: h }, style: { fill }, emphasis: hover });
  }
  if (cell.kind === "no_history") {
    for (const segment of stripeSegments(x, y, w, h, LAYOUT.stripeSpacing)) shapes.push(line(segment, palette.noHistory.stroke));
  }
  if (cell.kind !== "no_data") {
    const mark = markColor(fill, palette.marksDark, palette.marksLight);
    if (cell.provisional) {
      for (const segment of hatchSegments(x, y, w, h, LAYOUT.hatchSpacing)) shapes.push(line(segment, mark));
    }
    if (cell.partial) {
      shapes.push({ type: "circle", shape: { cx: x + w - 4.5, cy: y + 4.5, r: 2.5 }, style: { fill: mark, stroke: fill, lineWidth: 1 } });
    }
  }
  if (cell.highlighted) {
    shapes.push({ type: "rect", shape: { x: x - 1, y: y - 1, width: w + 2, height: h + 2 }, style: { fill: "none", stroke: palette.text, lineWidth: 2 } });
  }
  return shapes;
}

const textWidth = (text, size) => text.length * size * 0.56;

const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** @param {CalendarModel} model */
export function defaultTitle(model) {
  return `Burning calendar · ${model.regionId}`;
}

const capitalize = (text) => text.replace(/^./, (c) => c.toUpperCase());

/** @param {CalendarModel} model */
export function defaultSubtitle(model) {
  const { start_year: from, end_year: to } = model.baseline;
  const what = {
    harmonized: `${capitalize(unitsLabel(model.units))} per month, MODIS and VIIRS on one scale`,
    anomaly: `Each month compared with normal: its ${from}–${to} median`,
    raw: "Raw counts per month before harmonizing, MODIS above VIIRS, one shared scale",
  }[model.view];
  const details = [
    `${model.aoi.covered_cells} cells, ${formatNumber(model.aoi.area_km2)} km²`,
    `weights ${model.weightMethod}`,
    `data ${model.dataVersion}`,
  ];
  if (model.clippedFraction > 0) details.push(`${Math.round(model.clippedFraction * 100)}% of the area outside the region`);
  return `${what}\n${details.join(" · ")}`;
}

/** @param {CalendarModel} model */
function legendCaption(model) {
  const { start_year: from, end_year: to } = model.baseline;
  if (!model.scale) {
    const anyZero = model.panels.some((panel) => panel.cells.some((cell) => cell.kind === "zero"));
    return anyZero ? "No fires in any month of this view" : "No data for this view";
  }
  if (model.view === "anomaly") return `Compared with normal, the ${from}–${to} median for that month (log2 scale)`;
  if (model.view === "raw") return "Raw detections per month, each sensor on its own (log scale)";
  return `${capitalize(unitsLabel(model.units))} per month (log scale)`;
}

/** @param {CalendarModel} model */
function legendSwatches(model, palette) {
  const sample =
    model.view === "anomaly" ? palette.diverging[palette.diverging.length - 3] : palette.sequential[Math.floor(palette.sequential.length / 2)];
  const items = [];
  if (model.view === "anomaly") items.push({ label: "Not enough history", cell: { kind: "no_history", color: palette.noHistory.fill } });
  else items.push({ label: "No fires", cell: { kind: "zero", color: palette.zero } });
  items.push({ label: "No data", cell: { kind: "no_data", color: palette.noData.fill } });
  items.push({ label: "Early numbers, may change", cell: { kind: "value", color: sample, provisional: true } });
  items.push({ label: "Satellite passes missing", cell: { kind: "value", color: sample, partial: true } });
  if (model.seasonRuns.length > 0) items.push({ label: "Fire season", season: true });
  const { highlight } = model;
  if (highlight && model.panels.some((panel) => panel.cells.some((cell) => cell.highlighted))) {
    items.push({ label: `Outlined: ${MONTH_LONG[highlight.month - 1]} ${highlight.year}`, cell: { kind: "value", color: sample, highlighted: true } });
  }
  return items;
}

/**
 * @param {CalendarModel} model
 * @param {number} top
 * @param {number} width
 */
function legendElements(model, top, width, palette) {
  const { pad, legendBarWidth, swatchRow } = LAYOUT;
  const elements = [];
  const text = (x, y, value, extra = {}) => ({
    type: "text",
    style: { x, y, text: value, fill: palette.text, fontSize: 11, fontFamily: palette.font, verticalAlign: "top", ...extra },
  });

  elements.push(text(pad, top, legendCaption(model), { fontSize: 12 }));
  const barY = top + 20;
  const diverging = model.scale?.type === "diverging";
  // Room for the "NOT" and "HOT" words at the ends of the anomaly bar.
  const endWidth = diverging ? 34 : 0;
  const barX = pad + endWidth;
  const barWidth = Math.min(legendBarWidth, width - 2 * pad - 2 * endWidth);
  if (model.scale) {
    const stops = diverging ? palette.diverging : palette.sequential;
    if (diverging) {
      const end = { fontSize: 12, fontWeight: 700, verticalAlign: "middle" };
      elements.push(text(barX - 6, barY + 5, "NOT", { ...end, align: "right", fill: stops[0] }));
      elements.push(text(barX + barWidth + 6, barY + 5, "HOT", { ...end, fill: stops.at(-1) }));
    }
    elements.push({
      type: "rect",
      shape: { x: barX, y: barY, width: barWidth, height: 10 },
      style: {
        fill: {
          type: "linear",
          x: 0,
          y: 0,
          x2: 1,
          y2: 0,
          colorStops: stops.map((color, i) => ({ offset: i / (stops.length - 1), color })),
        },
      },
    });
    for (const tick of model.scale.ticks) {
      const x = barX + tick.t * barWidth;
      elements.push(line([x, barY + 10, x, barY + 14], palette.text));
      const align = tick.t < 0.03 ? "left" : tick.t > 0.97 ? "right" : "center";
      elements.push(text(x, barY + 16, tick.label, { align }));
    }
  }

  let x = pad;
  let y = top + (model.scale ? 58 : 24);
  for (const item of legendSwatches(model, palette)) {
    const itemWidth = 16 + 6 + textWidth(item.label, 11) + 18;
    if (x > pad && x + itemWidth > width - pad) {
      x = pad;
      y += swatchRow;
    }
    if (item.season) {
      elements.push({ type: "rect", shape: { x, y: y + 3, width: 16, height: LAYOUT.bandHeight }, style: { fill: palette.season } });
    } else {
      elements.push(...cellShapes({ provisional: false, partial: false, ...item.cell }, x, y, 16, 12, palette));
    }
    elements.push(text(x + 22, y, item.label));
    x += itemWidth;
  }
  return { elements, bottom: y + swatchRow };
}

/**
 * The ECharts option for a calendar model at a given width, and the height it needs.
 * @param {CalendarModel} model
 * @param {OptionSettings} settings
 */
export function buildOption(model, { width, title, subtitle, palette = CALENDAR_PALETTE }) {
  const { pad, axisWidth, cellHeight, cellGap, bandHeight, bandGap, panelGap, panelTitle, monthLabels } = LAYOUT;
  const subtext = subtitle ?? defaultSubtitle(model);
  const titleHeight = 20 + 6 + 16 * subtext.split("\n").length;
  const legend = legendElements(model, pad + titleHeight + 8, width, palette);
  const graphics = [...legend.elements];

  const gridLeft = pad + axisWidth;
  const gridWidth = Math.max(12 * 8, width - gridLeft - pad);
  const cellWidth = gridWidth / 12;
  const monthLabel = (label) => (cellWidth < 24 ? label[0] : label);
  const font = { fontFamily: palette.font, color: palette.text, fontSize: 11 };

  const grid = [];
  const xAxis = [];
  const yAxis = [];
  const series = [];
  let top = legend.bottom + 8;

  if (model.rows.length === 0) {
    graphics.push({
      type: "text",
      style: { x: pad, y: top, text: "No months to show for this area.", fill: palette.text, fontSize: 13, fontFamily: palette.font },
    });
    top += 24;
  }

  model.panels.forEach((panel, i) => {
    if (model.rows.length === 0) return;
    if (model.panels.length > 1) {
      graphics.push({
        type: "text",
        style: { x: pad, y: top, text: panel.label, fill: palette.text, fontSize: 13, fontWeight: 600, fontFamily: palette.font, verticalAlign: "top" },
      });
      top += panelTitle;
    }
    const gridTop = top + monthLabels;
    const gridHeight = model.rows.length * cellHeight;
    grid.push({ left: gridLeft, top: gridTop, width: gridWidth, height: gridHeight });
    const hidden = { axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false }, axisPointer: { show: false } };
    xAxis.push({
      type: "category",
      gridIndex: i,
      position: "top",
      data: model.columns.map((column) => monthLabel(column.label)),
      axisLabel: { ...font, interval: 0, margin: bandGap + bandHeight + 4 },
      ...hidden,
    });
    yAxis.push({
      type: "category",
      gridIndex: i,
      inverse: true,
      data: model.rows.map((row) => row.label),
      axisLabel: { ...font, interval: 0, margin: 8 },
      ...hidden,
    });
    series.push({
      id: `cells-${i}`,
      name: panel.label,
      type: "custom",
      coordinateSystem: "cartesian2d",
      xAxisIndex: i,
      yAxisIndex: i,
      clip: false,
      data: panel.cells.map((cell) => [cell.col, cell.row]),
      encode: { x: 0, y: 1 },
      renderItem: (params, api) => {
        const cell = panel.cells[params.dataIndex];
        const [cx, cy] = api.coord([cell.col, cell.row]);
        const [w, h] = api.size([1, 1]);
        return {
          type: "group",
          children: cellShapes(cell, cx - w / 2 + cellGap / 2, cy - h / 2 + cellGap / 2, w - cellGap, h - cellGap, palette),
        };
      },
    });
    if (model.seasonRuns.length > 0) {
      series.push({
        id: `season-${i}`,
        name: "Fire season",
        type: "custom",
        coordinateSystem: "cartesian2d",
        xAxisIndex: i,
        yAxisIndex: i,
        clip: false,
        data: model.seasonRuns.map((run) => [run.from, 0, run.to]),
        encode: { x: 0, y: 1 },
        renderItem: (params, api) => {
          const [x0] = api.coord([api.value(0), 0]);
          const [x1] = api.coord([api.value(2), 0]);
          const [w] = api.size([1, 1]);
          return {
            type: "rect",
            shape: { x: x0 - w / 2 + cellGap / 2, y: params.coordSys.y - bandGap - bandHeight, width: x1 - x0 + w - cellGap, height: bandHeight },
            style: { fill: palette.season },
          };
        },
      });
      graphics.push({
        type: "text",
        style: {
          x: gridLeft - 8,
          y: gridTop - bandGap - bandHeight / 2,
          text: "Fire season",
          fill: palette.muted,
          fontSize: 10,
          fontFamily: palette.font,
          align: "right",
          verticalAlign: "middle",
        },
      });
    }
    top = gridTop + gridHeight + panelGap;
  });

  const height = Math.ceil(top - (model.rows.length > 0 ? panelGap : 0) + pad);
  const { start_year: from, end_year: to } = model.baseline;

  const formatter = (params) => {
    const [kind, index] = String(params.seriesId).split("-");
    const panel = model.panels[Number(index)];
    let lines;
    if (kind === "season") {
      lines = [`Fire season: ${seasonText(model.fireSeason)}`, `Months whose ${from}–${to} median is above the mean of the twelve monthly medians`];
    } else {
      lines = tooltipLines(panel.cells[params.dataIndex], model, panel.id);
    }
    return lines.map((text, i) => (i === 0 ? `<b>${escapeHtml(text)}</b>` : escapeHtml(text))).join("<br>");
  };

  const option = {
    animation: false,
    backgroundColor: palette.background,
    textStyle: { fontFamily: palette.font, color: palette.text },
    aria: { enabled: true, label: { description: describeCalendar(model) }, decal: { show: false } },
    title: {
      text: title ?? defaultTitle(model),
      subtext,
      left: pad,
      top: pad,
      padding: 0,
      itemGap: 6,
      textStyle: { fontSize: 15, fontWeight: 600, lineHeight: 20, color: palette.text, width: width - 2 * pad, overflow: "truncate" },
      subtextStyle: { fontSize: 12, lineHeight: 16, color: palette.muted, width: width - 2 * pad, overflow: "truncate" },
    },
    tooltip: {
      trigger: "item",
      confine: true,
      backgroundColor: palette.background,
      borderColor: palette.muted,
      borderWidth: 1,
      padding: [6, 8],
      textStyle: { color: palette.text, fontSize: 12, fontFamily: palette.font },
      formatter,
    },
    graphic: { elements: graphics },
    grid,
    xAxis,
    yAxis,
    series,
  };
  return { option, height };
}
