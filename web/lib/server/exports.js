import {
  HOTSPOT_EXPORT_COLUMNS,
  MAX_EXPORT_ROWS,
  SUMMARY_EXPORT_COLUMNS,
  exportFilename,
  validateCurrentMonthRequest,
  yearMonthToYm,
} from "../../public/shared/contracts.js";
import { currentMonth } from "../../public/shared/analytics.js";
import { tileOf } from "../../public/shared/grid.js";
import { mockCalendar, mocks, resolveMockRegion } from "../../mocks/index.js";
import { csvCell, csvLine } from "../csv.js";
import {
  MOCK_HEADERS,
  aoiErrorResponse,
  calendarMonths,
  openPublished,
  resolveAoi,
  validateCalendarBody,
  withDataErrors,
  withSimpleAoi,
} from "./calendar.js";
import { csvResponse, errorResponse, readBody } from "./http.js";

/** @typedef {import("../csv.js").CsvValue} CsvValue */
/** @typedef {import("../data/source.js").DataSource} DataSource */
/** @typedef {{ source?: DataSource }} HandlerOptions */

const CHUNK_CHARS = 64 * 1024;
const encoder = new TextEncoder();
const validateCurrentMonthBody = withSimpleAoi(validateCurrentMonthRequest);

// Numbers and booleans never need quotes. Skipping csvCell's check and the per-row array
// halves the export time: a million hotspot rows take about 2.8 s instead of 4.8 s.
/** @param {CsvValue} value */
const cell = (value) => (typeof value === "number" || typeof value === "boolean" ? String(value) : csvCell(value));

/**
 * CSV as a byte stream, pulled about 64 KB at a time so an export is never held in memory. The
 * first chunk is read before returning, so a missing or broken first tile fails the request
 * with a 503 instead of cutting off a download that has already started.
 * @param {readonly string[]} columns
 * @param {Iterable<Record<string, CsvValue>> | AsyncIterable<Record<string, CsvValue>>} rows
 * @returns {Promise<ReadableStream<Uint8Array>>}
 */
export async function csvStream(columns, rows) {
  const iterator = Symbol.asyncIterator in rows ? rows[Symbol.asyncIterator]() : rows[Symbol.iterator]();
  const read = async () => {
    let text = "";
    while (text.length < CHUNK_CHARS) {
      const next = await iterator.next();
      if (next.done) return { text, done: true };
      const row = next.value;
      text += cell(row[columns[0]]);
      for (let i = 1; i < columns.length; i += 1) text += `,${cell(row[columns[i]])}`;
      text += "\n";
    }
    return { text, done: false };
  };
  /** @type {{ text: string, done: boolean } | null} */
  let first = await read();
  first.text = csvLine(columns) + first.text;
  return new ReadableStream({
    async pull(controller) {
      const chunk = first ?? (await read());
      first = null;
      if (chunk.text !== "") controller.enqueue(encoder.encode(chunk.text));
      if (chunk.done) controller.close();
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/** @param {Response} response */
function markMock(response) {
  for (const [name, value] of Object.entries(MOCK_HEADERS)) response.headers.set(name, value);
  return response;
}

/**
 * @param {Request} request
 * @param {HandlerOptions} [options]
 */
export async function handleCurrentMonth(request, { source } = {}) {
  const body = await readBody(request, validateCurrentMonthBody);
  if (!body.ok) return body.response;
  return withDataErrors(async () => {
    const serving = await openPublished(source);
    if (!serving) {
      const region = resolveMockRegion(body.value.aoi);
      return region.ok ? Response.json(mocks.currentMonth, { headers: MOCK_HEADERS }) : region.response;
    }
    const resolved = resolveAoi(serving, body.value.aoi);
    if (!resolved.ok) return aoiErrorResponse(resolved);
    const regionId = resolved.region.id;
    const dayTotals = serving.sumCellDays(regionId, resolved.coveredCells);
    return Response.json(currentMonth(dayTotals, serving.getMonths(regionId)));
  });
}

/**
 * The calendar's `months`, through W04's cache, one CSV row each.
 * @param {Request} request
 * @param {HandlerOptions} [options]
 */
export async function handleSummaryExport(request, { source } = {}) {
  const body = await readBody(request, validateCalendarBody);
  if (!body.ok) return body.response;
  const { aoi, start, end, series } = body.value;
  return withDataErrors(async () => {
    const serving = await openPublished(source);
    if (!serving) {
      const region = resolveMockRegion(aoi);
      if (!region.ok) return region.response;
      const { months } = mockCalendar(region.regionId, series, start, end);
      const filename = exportFilename("summary", region.regionId, start, end);
      return markMock(csvResponse(filename, await csvStream(SUMMARY_EXPORT_COLUMNS, months)));
    }
    const resolved = resolveAoi(serving, aoi);
    if (!resolved.ok) return aoiErrorResponse(resolved);
    const { months } = calendarMonths(serving, resolved.region.id, resolved.coveredCells, body.value);
    const filename = exportFilename("summary", resolved.region.id, start, end);
    return csvResponse(filename, await csvStream(SUMMARY_EXPORT_COLUMNS, months));
  });
}

/**
 * The row count comes from `cells.points`, so an export over the cap is refused before any tile
 * is opened.
 * @param {Request} request
 * @param {HandlerOptions & { maxRows?: number }} [options]
 */
export async function handleHotspotExport(request, { source, maxRows = MAX_EXPORT_ROWS } = {}) {
  const body = await readBody(request, validateCalendarBody);
  if (!body.ok) return body.response;
  const { aoi, start, end } = body.value;
  return withDataErrors(async () => {
    const serving = await openPublished(source);
    if (!serving) {
      const region = resolveMockRegion(aoi);
      if (!region.ok) return region.response;
      const rows = mocks.hotspotsNile.filter((row) => row.acq_date.slice(0, 7) >= start && row.acq_date.slice(0, 7) <= end);
      const filename = exportFilename("hotspots", region.regionId, start, end);
      return markMock(csvResponse(filename, await csvStream(HOTSPOT_EXPORT_COLUMNS, rows)));
    }
    const resolved = resolveAoi(serving, aoi);
    if (!resolved.ok) return aoiErrorResponse(resolved);
    const regionId = resolved.region.id;
    const cellIds = resolved.coveredCells;
    const ymStart = yearMonthToYm(start);
    const ymEnd = yearMonthToYm(end);
    const count = serving.sumCells(regionId, cellIds, ymStart, ymEnd).reduce((total, month) => total + month.points, 0);
    if (count > maxRows) {
      const message =
        `This export would have ${count.toLocaleString("en-US")} rows; the limit is ` +
        `${maxRows.toLocaleString("en-US")}. Narrow the area or the dates.`;
      return errorResponse("too_many_rows", message);
    }
    const rows =
      count === 0 ? [] : serving.tileRows({ regionId, tileIds: new Set(cellIds.map(tileOf)), cellIds, ymStart, ymEnd });
    const filename = exportFilename("hotspots", regionId, start, end);
    return csvResponse(filename, await csvStream(HOTSPOT_EXPORT_COLUMNS, rows));
  });
}
