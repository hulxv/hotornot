import { pickRegion, snap, validateAoi } from "../../public/shared/aoi.js";
import { buildMonths, currentMonth } from "../../public/shared/analytics.js";
import {
  HOTSPOT_EXPORT_COLUMNS,
  MAX_EXPORT_ROWS,
  MIN_COVERED_CELLS,
  SUMMARY_EXPORT_COLUMNS,
  exportFilename,
  validateCurrentMonthRequest,
  validateExportRequest,
  yearMonthToYm,
} from "../../public/shared/contracts.js";
import { tileOf } from "../../public/shared/grid.js";
import { csvCell, csvLine } from "../csv.js";
import { openServing } from "../data/serving.js";
import { csvResponse, errorResponse, readBody } from "./http.js";

/** @typedef {import("../../public/shared/contracts.js").Aoi} Aoi */
/** @typedef {import("../../public/shared/contracts.js").RegionId} RegionId */
/** @typedef {import("../csv.js").CsvValue} CsvValue */
/** @typedef {import("../data/serving.js").Serving} Serving */
/** @typedef {import("../data/source.js").DataSource} DataSource */
/** @typedef {{ source?: DataSource }} HandlerOptions */

/**
 * @typedef {object} Area
 * @property {true} ok
 * @property {RegionId} regionId
 * @property {number} clippedFraction
 * @property {ReturnType<typeof snap>} snapped
 */

const CHUNK_CHARS = 64 * 1024;
const encoder = new TextEncoder();

// Numbers and booleans never need quotes. Skipping csvCell's check and the per-row array
// halves the export time: a million hotspot rows take about 2.8 s instead of 4.8 s.
/** @param {CsvValue} value */
const cell = (value) => (typeof value === "number" || typeof value === "boolean" ? String(value) : csvCell(value));

/**
 * The CONTRACTS AOI rules: pick the region, snap to its cells, refuse fewer than 4 covered cells.
 * @param {Serving} serving
 * @param {Aoi} aoi
 * @returns {Area | { ok: false, response: Response }}
 */
export function resolveArea(serving, aoi) {
  const valid = validateAoi(aoi);
  if (!valid.ok) return { ok: false, response: errorResponse(valid.code, valid.message) };
  const picked = pickRegion(aoi, serving.getMeta("metadata").regions);
  if (!picked.ok) return { ok: false, response: errorResponse(picked.code, picked.message, picked.regions) };
  const regionId = picked.region.id;
  const snapped = snap(aoi, serving.getRegionCells(regionId), picked.region.bbox);
  if (snapped.coveredCells.length < MIN_COVERED_CELLS) {
    const message =
      `The area snaps to ${snapped.coveredCells.length} covered grid cells; at least ${MIN_COVERED_CELLS} ` +
      "(each about 5.5 km across) are needed. Draw a larger area.";
    return { ok: false, response: errorResponse("too_small", message) };
  }
  return { ok: true, regionId, clippedFraction: picked.clippedFraction, snapped };
}

/**
 * CSV as a byte stream, pulled about 64 KB at a time so an export is never held in memory. The
 * first chunk is read before returning, so a missing or broken first tile fails the request
 * with a 500 instead of cutting off a download that has already started.
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

/**
 * @param {Request} request
 * @param {HandlerOptions} [options]
 */
export async function handleCurrentMonth(request, { source } = {}) {
  const body = await readBody(request, validateCurrentMonthRequest);
  if (!body.ok) return body.response;
  const serving = await openServing(source);
  const area = resolveArea(serving, body.value.aoi);
  if (!area.ok) return area.response;
  const dayTotals = serving.sumCellDays(area.regionId, area.snapped.coveredCells);
  return Response.json(currentMonth(dayTotals, serving.getMonths(area.regionId)));
}

/**
 * @param {Request} request
 * @param {HandlerOptions} [options]
 */
export async function handleSummaryExport(request, { source } = {}) {
  const body = await readBody(request, validateExportRequest);
  if (!body.ok) return body.response;
  const { aoi, start, end, series } = body.value;
  const serving = await openServing(source);
  const area = resolveArea(serving, aoi);
  if (!area.ok) return area.response;
  const sums = serving.sumCells(area.regionId, area.snapped.coveredCells);
  const months = buildMonths(sums, serving.getMonths(area.regionId), series, { start, end });
  const filename = exportFilename("summary", area.regionId, start, end);
  return csvResponse(filename, await csvStream(SUMMARY_EXPORT_COLUMNS, months));
}

/**
 * The row count comes from `cells.points`, so an export over the cap is refused before any tile
 * is opened.
 * @param {Request} request
 * @param {HandlerOptions & { maxRows?: number }} [options]
 */
export async function handleHotspotExport(request, { source, maxRows = MAX_EXPORT_ROWS } = {}) {
  const body = await readBody(request, validateExportRequest);
  if (!body.ok) return body.response;
  const { aoi, start, end } = body.value;
  const serving = await openServing(source);
  const area = resolveArea(serving, aoi);
  if (!area.ok) return area.response;
  const { regionId } = area;
  const cellIds = area.snapped.coveredCells;
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
}
