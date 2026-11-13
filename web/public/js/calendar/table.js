import { MONTH_LONG, VIEWS, formatNumber, formatRatio, formatSigned, seasonText, unitsLabel } from "./transform.js";

/**
 * @typedef {import("../../shared/contracts.js").CalendarResponse} CalendarResponse
 * @typedef {import("../../shared/contracts.js").CalendarMonth} CalendarMonth
 * @typedef {import("./transform.js").View} View
 * @typedef {{ label: string, numeric: boolean }} Column
 * @typedef {{ month: string, cells: string[] }} Row
 * @typedef {{ caption: string, columns: Column[], rows: Row[] }} CalendarTable
 */

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const hasData = (m) => isNumber(m.value) || isNumber(m.modis_raw) || isNumber(m.viirs_raw);
const show = (value, format = formatNumber) => (isNumber(value) ? format(value) : "—");

/**
 * The calendar as rows of text, newest month first: what each cell's tooltip says, for keyboard
 * and screen-reader users. Months after the last one with data are left out, as in the chart.
 * @param {CalendarResponse} response
 * @param {{ view?: View, title?: string }} [options]
 * @returns {CalendarTable}
 */
export function calendarTable(response, { view = "harmonized", title } = {}) {
  if (!VIEWS.includes(view)) throw new RangeError(`unknown calendar view: ${view}`);
  const { start_year: from, end_year: to } = response.baseline;
  const lastWithData = response.months.findLastIndex(hasData);
  const months = response.months.slice(0, lastWithData + 1).reverse();
  const units = unitsLabel(response.units);

  /** @type {Column[]} */
  const columns =
    view === "raw"
      ? [{ label: "Month", numeric: false }, { label: "MODIS hotspots", numeric: true }, { label: "VIIRS hotspots", numeric: true }]
      : [
          { label: "Month", numeric: false },
          { label: `Value (${units})`, numeric: true },
          { label: `Median ${from}–${to}`, numeric: true },
          { label: view === "anomaly" ? "Against the median" : "Difference", numeric: true },
          { label: "Rank", numeric: true },
        ];
  columns.push({ label: "Notes", numeric: false });

  const rows = months.map((m) => {
    const notes = [];
    let cells;
    if (view === "raw") {
      if (!isNumber(m.modis_raw) && !isNumber(m.viirs_raw)) notes.push("No data");
      cells = [show(m.modis_raw), show(m.viirs_raw)];
    } else {
      if (!isNumber(m.value)) notes.push("No data");
      else if (view === "anomaly" && !isNumber(m.anomaly_log2)) notes.push("Not enough history");
      const comparison = view === "anomaly" ? show(m.anomaly_log2, formatRatio) : show(m.difference, formatSigned);
      const rank = isNumber(m.rank) && isNumber(m.of_years) ? `${m.rank} of ${m.of_years}` : "—";
      cells = [show(m.value), show(m.median), comparison, rank];
    }
    if (m.provisional) notes.push("Provisional");
    if (m.partial_coverage) notes.push("Partial coverage");
    return { month: `${MONTH_LONG[m.month - 1]} ${m.year}`, cells: [...cells, notes.join("; ")] };
  });

  const what = {
    harmonized: `harmonized ${units} per month`,
    anomaly: `each month against its ${from}–${to} median`,
    raw: "raw hotspot counts per month, MODIS and VIIRS",
  }[view];
  const parts = [`${title ?? response.region_id}: ${what}, newest first.`];
  if (view !== "raw") parts.push(`Rank compares the month with the same month in every year from ${from} to its own; 1 is the most active.`);
  if (view !== "raw" && response.fire_season.length > 0) parts.push(`Fire season: ${seasonText(response.fire_season)}.`);
  return { caption: parts.join(" "), columns, rows };
}

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * The table in a scrolling box that takes keyboard focus, so it can be scrolled without a mouse.
 * @param {CalendarTable} table
 * @param {string} [id] prefix for the caption id, unique on the page
 */
export function calendarTableHtml({ caption, columns, rows }, id = "calendar-table") {
  const numeric = (i) => (columns[i].numeric ? ' class="num"' : "");
  const head = columns.map((column, i) => `<th scope="col"${numeric(i)}>${escapeHtml(column.label)}</th>`).join("");
  const body = rows
    .map((row) => `<tr><th scope="row">${escapeHtml(row.month)}</th>${row.cells.map((cell, i) => `<td${numeric(i + 1)}>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("");
  return (
    `<div class="table-scroll" tabindex="0" role="region" aria-labelledby="${id}-caption">` +
    `<table class="data"><caption id="${id}-caption">${escapeHtml(caption)}</caption>` +
    `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
  );
}
