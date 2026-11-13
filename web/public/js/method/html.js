import { MONTH_LONG, MONTH_SHORT } from "../calendar/transform.js";
import { METHOD_PALETTE } from "./palette.js";
import {
  ANNUAL_ERROR_LIMIT_PCT,
  K_LEVEL_NAMES,
  MIN_MONTHLY_R,
  SCORE_METHOD_NAMES,
  WEIGHT_METHOD_NAMES,
  formatCount,
  formatDate,
  formatFactor,
  formatFrp,
  formatPercent,
  formatR,
  formatValue,
  monthLabel,
} from "./transform.js";

/**
 * @typedef {import("./palette.js").LineStyle} LineStyle
 * @typedef {import("./transform.js").SeamModel} SeamModel
 * @typedef {import("./transform.js").N20Model} N20Model
 * @typedef {import("./transform.js").DetectionModel} DetectionModel
 * @typedef {import("./transform.js").KModel} KModel
 * @typedef {import("./transform.js").Scorecard} Scorecard
 * @typedef {import("./transform.js").ScoreCell} ScoreCell
 * @typedef {ReturnType<typeof import("./transform.js").methodView>} MethodView
 */

/** @param {unknown} text */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const hidden = (text) => `<span class="visually-hidden">${escapeHtml(text)}</span>`;

/** A short line in the chart's color and dash, for legends. @param {LineStyle} style */
export function swatchSvg(style, width = style.width) {
  const dash = style.dash ? ` stroke-dasharray="${style.dash.join(" ")}"` : "";
  return (
    `<svg class="swatch" width="28" height="12" viewBox="0 0 28 12" aria-hidden="true" focusable="false">` +
    `<line x1="0" y1="6" x2="28" y2="6" stroke="${escapeHtml(style.color)}" stroke-width="${width}"${dash}/></svg>`
  );
}

/** @param {{ label: string, style: LineStyle, width?: number, key?: string }[]} items */
export function legendHtml(items) {
  const li = (item) =>
    `<li${item.key ? ` data-key="${escapeHtml(item.key)}"` : ""}>${swatchSvg(item.style, item.width)}<span>${escapeHtml(item.label)}</span></li>`;
  return `<ul class="legend">${items.map(li).join("")}</ul>`;
}

/** Legend items for a seam or NOAA-20 chart; the shipped method's line is drawn wider. */
export function lineLegendItems(series) {
  return series.map((line) => ({
    key: line.key,
    label: line.shipped ? `${line.label} (shipped)` : line.label,
    style: line.style,
    width: line.shipped ? line.style.width + 1 : line.style.width,
  }));
}

/**
 * A chart's frame: title, the container ECharts draws into, and a collapsed table of its
 * numbers that the page fills when opened. Without a chart, the placeholder text instead.
 * `context` tells screen-reader users which chart a numbers table belongs to when titles repeat
 * across sections.
 * @param {{ id: string, title: string, height: number, placeholder?: string | null, context?: string }} card
 */
export function chartCardHtml({ id, title, height, placeholder = null, context = "" }) {
  const head = `<figcaption class="chart-title">${escapeHtml(title)}</figcaption>`;
  if (placeholder) {
    return `<figure class="chart-card surface">${head}<p class="chart-empty" style="min-height:${height}px">${escapeHtml(placeholder)}</p></figure>`;
  }
  const safe = escapeHtml(id);
  return (
    `<figure class="chart-card surface">${head}` +
    `<div class="chart" id="chart-${safe}" style="height:${height}px"><p class="chart-empty">Drawing the chart…</p></div>` +
    `<details class="numbers" id="numbers-${safe}"><summary>Numbers behind this chart${hidden(`: ${title}${context ? `, ${context}` : ""}`)}</summary>` +
    `<div class="numbers-body" id="numbers-body-${safe}"></div></details>` +
    `</figure>`
  );
}

/**
 * @param {{ caption?: string, columns: { label: string, numeric?: boolean }[], rows: (string | number | null)[][], rowHeader?: boolean }} table
 */
export function dataTableHtml({ caption, columns, rows, rowHeader = true }) {
  const head = columns.map((c) => `<th scope="col"${c.numeric ? ' class="num"' : ""}>${escapeHtml(c.label)}</th>`).join("");
  const body = rows
    .map((row) => {
      const cells = row.map((value, i) => {
        const text = value === null || value === undefined ? "—" : escapeHtml(value);
        if (i === 0 && rowHeader) return `<th scope="row">${text}</th>`;
        return `<td${columns[i]?.numeric ? ' class="num"' : ""}>${text}</td>`;
      });
      return `<tr>${cells.join("")}</tr>`;
    })
    .join("");
  return (
    `<div class="table-wrap"><table class="data">${caption ? `<caption>${escapeHtml(caption)}</caption>` : ""}` +
    `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
  );
}

const maybe = (value, format) => (typeof value === "number" && Number.isFinite(value) ? format(value) : null);

/** @param {SeamModel} model */
export function seamNumbersHtml(model) {
  const columns = [{ label: "Month" }, { label: "MODIS", numeric: true }, { label: "Raw VIIRS", numeric: true }, { label: "Harmonized, ratio", numeric: true }];
  if (model.hasModel) columns.push({ label: "Harmonized, model", numeric: true });
  columns.push({ label: "Held-out fold" });
  const rows = model.months.map((m) => {
    const row = [monthLabel(m.ym), maybe(m.modis, formatCount), maybe(m.viirs_raw, formatCount), maybe(m.ratio, formatValue)];
    if (model.hasModel) row.push(maybe(m.model, formatValue));
    row.push(m.fold.replace("-", "–"));
    return row;
  });
  return `<p>${escapeHtml(model.description)}</p>${dataTableHtml({ caption: `${model.name}, monthly hotspots`, columns, rows })}`;
}

/** @param {N20Model} model */
export function n20NumbersHtml(model) {
  const rows = model.months.map((m) => [monthLabel(m.ym), formatValue(m.snpp), formatValue(m.n20)]);
  const columns = [{ label: "Month" }, { label: "S-NPP, harmonized", numeric: true }, { label: "NOAA-20, harmonized", numeric: true }];
  return `<p>${escapeHtml(model.description)}</p>${dataTableHtml({ caption: `${model.name}, harmonized monthly hotspots`, columns, rows })}`;
}

/** @param {DetectionModel} model */
export function detectionNumbersHtml(model) {
  const columns = [{ label: "VIIRS FRP (MW)" }, ...model.lines.map((line) => ({ label: line.label, numeric: true }))];
  const rows = model.frp.map((frp, i) => [formatFrp(frp), ...model.lines.map((line) => `${Math.round(line.p[i] * 100)}%`)]);
  return `<p>${escapeHtml(model.description)}</p>${dataTableHtml({ caption: "Chance that MODIS detects the fire", columns, rows })}`;
}

/** @param {ScoreCell} cell @param {(value: number) => string} format @param {string} limit */
function scoreCellHtml(cell, format, limit) {
  if (cell.value === null) return `<td class="num">—${hidden(", not run")}</td>`;
  const mark = cell.passes
    ? `<span class="mark" aria-hidden="true">✓</span>${hidden(`, meets the ${limit} limit`)}`
    : `<span class="mark" aria-hidden="true">✗</span>${hidden(`, misses the ${limit} limit`)}`;
  return `<td class="num ${cell.passes ? "pass" : "fail"}">${escapeHtml(format(cell.value))}${mark}</td>`;
}

const ERROR_LIMIT = `${ANNUAL_ERROR_LIMIT_PCT}%`;
const R_LIMIT = `${MIN_MONTHLY_R}`;

/** @param {Scorecard} card */
export function scorecardHtml(card) {
  const { decision } = card;
  const methodHead = card.methods.map((method) => `<th scope="col" class="num">${escapeHtml(SCORE_METHOD_NAMES[method])}</th>`).join("");
  const span = card.methods.length;
  const tables = card.tests
    .filter((test) => test.rows.length > 0)
    .map((test) => {
      const body = test.rows
        .map(
          (row) =>
            `<tr><th scope="row">${escapeHtml(row.name)}</th>` +
            row.annual.map((cell) => scoreCellHtml(cell, formatPercent, ERROR_LIMIT)).join("") +
            row.r.map((cell) => scoreCellHtml(cell, formatR, R_LIMIT)).join("") +
            `</tr>`,
        )
        .join("");
      return (
        `<div class="table-wrap"><table class="data scores" id="scores-${escapeHtml(test.id)}">` +
        `<caption><strong>${escapeHtml(test.title)}.</strong> ${escapeHtml(test.note)}</caption>` +
        `<thead><tr><td></td><th scope="colgroup" colspan="${span}">Annual total error against MODIS (limit ${ERROR_LIMIT})</th>` +
        `<th scope="colgroup" colspan="${span}">Monthly correlation r (at least ${R_LIMIT})</th></tr>` +
        `<tr><th scope="col">Region</th>${methodHead}${methodHead}</tr></thead>` +
        `<tbody>${body}</tbody></table></div>`
      );
    })
    .join("");
  const mismatch = decision.agrees
    ? ""
    : `<p>This data version was published with <strong>${escapeHtml(WEIGHT_METHOD_NAMES[decision.shipped])}</strong>.</p>`;
  return (
    `<div class="decision">` +
    `<p class="decision-head">Decision: <strong>${escapeHtml(WEIGHT_METHOD_NAMES[decision.method])}</strong> ships.</p>` +
    (decision.modelRan
      ? `<p>The model met both limits in <strong>${decision.passed} of ${decision.of}</strong> regions on the leave-two-years-out test.</p>`
      : "<p>No detection model was validated, so the ratio method is the only candidate.</p>") +
    mismatch +
    `<p class="rule">Rule: ${escapeHtml(decision.rule)}</p>` +
    `</div>${tables}`
  );
}

/** @param {Scorecard} card */
export function n20ScoresHtml(card) {
  if (card.n20.length === 0) return "";
  const body = card.n20
    .map(
      (row) =>
        `<tr><th scope="row">${escapeHtml(row.name)}</th>${scoreCellHtml(row.annual, formatPercent, ERROR_LIMIT)}${scoreCellHtml(row.r, formatR, R_LIMIT)}</tr>`,
    )
    .join("");
  return (
    `<div class="table-wrap"><table class="data scores" id="scores-n20">` +
    `<caption>NOAA-20 against S-NPP, both harmonized, on the years both flew</caption>` +
    `<thead><tr><th scope="col">Region</th><th scope="col" class="num">Annual total error (limit ${ERROR_LIMIT})</th>` +
    `<th scope="col" class="num">Monthly correlation r (at least ${R_LIMIT})</th></tr></thead>` +
    `<tbody>${body}</tbody></table></div>`
  );
}

/** @param {KModel} model @param {typeof METHOD_PALETTE} [palette] */
export function kTableHtml(model, palette = METHOD_PALETTE) {
  const ramp = palette.sequential.map((color, i) => `${color} ${Math.round((i / (palette.sequential.length - 1)) * 100)}%`).join(", ");
  const used = Object.entries(model.levels).filter(([level, count]) => count > 0 && level !== "region_month");
  const legend =
    `<div class="k-legend" aria-hidden="true">` +
    `<span class="k-scale"><span>${escapeHtml(formatFactor(model.min))}</span>` +
    `<span class="k-ramp" style="background:linear-gradient(to right, ${ramp})"></span>` +
    `<span>${escapeHtml(formatFactor(model.max))}</span></span>` +
    used.map(([level]) => `<span class="k-key"><span class="k-sample level-${level}"></span>${escapeHtml(capitalize(K_LEVEL_NAMES[level]))}</span>`).join("") +
    `</div>`;
  const head = MONTH_SHORT.map((month, i) => `<th scope="col"><abbr title="${MONTH_LONG[i]}">${month}</abbr></th>`).join("");
  const groups = groupBy(model.rows, (row) => row.regionId)
    .map((rows) =>
      `<tbody>` +
      rows
        .map((row, i) => {
          const region = i === 0 ? `<th scope="rowgroup" rowspan="${rows.length}" class="k-region">${escapeHtml(row.name)}</th>` : "";
          const cells = row.cells
            .map((cell, m) => {
              if (!cell) return `<td class="k-empty">—${hidden(`, no value for ${MONTH_LONG[m]}`)}</td>`;
              const level = cell.level === "region_month" ? "" : hidden(`, ${K_LEVEL_NAMES[cell.level]}`);
              const title = `${row.name}, ${row.satellite}, ${MONTH_LONG[m]}: ${model.symbol} = ${formatFactor(cell.value)}, ${K_LEVEL_NAMES[cell.level]}`;
              return (
                `<td class="level-${cell.level}" style="background:${cell.fill};color:${cell.ink}" title="${escapeHtml(title)}">` +
                `${escapeHtml(formatFactor(cell.value))}${level}</td>`
              );
            })
            .join("");
          return `<tr>${region}<th scope="row" class="k-satellite">${escapeHtml(row.satellite)}</th>${cells}</tr>`;
        })
        .join("") +
      `</tbody>`,
    )
    .join("");
  return (
    `${legend}<div class="table-wrap"><table class="k-table">` +
    `<caption>${escapeHtml(capitalize(model.factorName))} ${escapeHtml(model.symbol)} by region, satellite and calendar month</caption>` +
    `<thead><tr><th scope="col">Region</th><th scope="col">Satellite</th>${head}</tr></thead>${groups}</table></div>` +
    `<p class="summary">${escapeHtml(model.description)}</p>`
  );
}

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** @template T @param {T[]} items @param {(item: T) => string} key @returns {T[][]} */
function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const k = key(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item);
  }
  return [...groups.values()];
}

/**
 * The line under the title: data version and shipped method, and a notice when any section
 * shows mock numbers.
 * @param {MethodView} view
 */
export function statusHtml(view) {
  const method = escapeHtml(WEIGHT_METHOD_NAMES[view.shipped]);
  if (view.mock.metadata) {
    return (
      `<p class="notice"><strong>Preview with mock numbers.</strong> No data version is published yet, so every chart and ` +
      `score on this page comes from the development mocks. They show the page's layout, not results.</p>`
    );
  }
  const published = view.publishedAt ? `, published ${escapeHtml(formatDate(view.publishedAt.slice(0, 10)))}` : "";
  const line = `<p class="muted">Data version ${escapeHtml(view.dataVersion)}${published}. The calendar uses ${method}.</p>`;
  if (!view.mock.validation) return line;
  const sections = ["seam charts", "scorecard", ...(view.mock.detection ? ["detection curve"] : []), "NOAA-20 comparison"];
  return (
    `${line}<p class="notice"><strong>Validation not published yet.</strong> The ${sections.slice(0, -1).join(", ")} and ` +
    `${sections.at(-1)} below use development mocks, not results.</p>`
  );
}
