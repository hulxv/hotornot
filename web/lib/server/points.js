import { tileOf } from "../../public/shared/grid.js";
import { SATELLITES, yearMonthToYm } from "../../public/shared/contracts.js";
import { mocks, resolveMockRegion } from "../../mocks/index.js";
import {
  LruCache,
  MOCK_HEADERS,
  aoiErrorResponse,
  calendarCacheKey,
  openPublished,
  resolveAoi,
  validateCalendarBody,
  withDataErrors,
} from "./calendar.js";
import { readBody } from "./http.js";

/** @typedef {import("../data/source.js").DataSource} DataSource */
/** @typedef {import("../../public/shared/contracts.js").TileRow} TileRow */
/**
 * @typedef {{
 *   points: number[], date: number[], time: number[], satellite: number[],
 *   frp: number[], weight: (number | null)[], night: number[],
 * }} PointColumns `points` is flat [lon, lat, ...]; the others hold one value per point
 * @typedef {PointColumns & { month_start: string, month_end: string, total: number, satellites: readonly string[] }} PointsBody
 */

// MapLibre draws this many circles smoothly on a laptop; Black Summer's December alone has
// about 230,000 counted hotspots in south-east Australia.
export const MAX_POINTS = 60_000;

// One month of a region takes 0.3 to 7 s to read from its tiles, so recent answers are kept.
const pointsCache = new LruCache(16);

const round = (value, decimals) => Math.round(value * 10 ** decimals) / 10 ** decimals;

const emptyColumns = () => ({ points: [], date: [], time: [], satellite: [], frp: [], weight: [], night: [] });

/**
 * Appends one hotspot. Date and time are integers (20261104 and 849 for 2026-11-04T08:49Z), and
 * the satellite is its index in `SATELLITES`.
 * @param {PointColumns} columns
 * @param {Pick<TileRow, "lon" | "lat" | "acq_utc" | "satellite" | "frp_mw" | "weight" | "daynight">} row
 */
function addPoint(columns, row) {
  columns.points.push(round(row.lon, 4), round(row.lat, 4));
  columns.date.push(Number(row.acq_utc.slice(0, 10).replaceAll("-", "")));
  columns.time.push(Number(row.acq_utc.slice(11, 13) + row.acq_utc.slice(14, 16)));
  columns.satellite.push(SATELLITES.indexOf(row.satellite));
  columns.frp.push(round(row.frp_mw, 1));
  columns.weight.push(row.weight === null ? null : round(row.weight, 4));
  columns.night.push(row.daynight === "N" ? 1 : 0);
}

/**
 * Indices of at most `max` of `count` points, every k-th one in order when there are more, so a
 * thinned map keeps the same spread.
 * @param {number} count
 * @param {number} max
 */
export function thinIndices(count, max) {
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  const step = count / max;
  return Array.from({ length: max }, (_, i) => Math.floor(i * step));
}

/**
 * @param {PointColumns} columns
 * @param {number} max
 * @returns {PointColumns}
 */
export function thinPoints(columns, max) {
  const count = columns.date.length;
  if (count <= max) return columns;
  const keep = thinIndices(count, max);
  const out = emptyColumns();
  for (const i of keep) {
    out.points.push(columns.points[2 * i], columns.points[2 * i + 1]);
    for (const key of /** @type {const} */ (["date", "time", "satellite", "frp", "weight", "night"])) out[key].push(columns[key][i]);
  }
  return out;
}

/**
 * @param {string} start
 * @param {string} end
 * @param {PointColumns} columns every point, before thinning
 * @param {number} max
 * @returns {PointsBody}
 */
const pointsBody = (start, end, columns, max) => ({
  month_start: start,
  month_end: end,
  total: columns.date.length,
  satellites: SATELLITES,
  ...thinPoints(columns, max),
});

/**
 * `POST /api/points`: where and when the hotspots counted in the harmonized series (`in_series`)
 * were, for the calendar body's area and months, so the map can draw them and describe each.
 * @param {Request} request
 * @param {{ source?: DataSource, maxPoints?: number }} [options]
 */
export async function handlePoints(request, { source, maxPoints = MAX_POINTS } = {}) {
  const body = await readBody(request, validateCalendarBody);
  if (!body.ok) return body.response;
  const { aoi, start, end } = body.value;
  return withDataErrors(async () => {
    const serving = await openPublished(source);
    if (!serving) {
      const region = resolveMockRegion(aoi);
      if (!region.ok) return region.response;
      const columns = emptyColumns();
      for (const row of mocks.hotspotsNile) {
        const month = row.acq_date.slice(0, 7);
        if (row.in_series && month >= start && month <= end) addPoint(columns, row);
      }
      return Response.json(pointsBody(start, end, columns, maxPoints), { headers: MOCK_HEADERS });
    }
    const resolved = resolveAoi(serving, aoi);
    if (!resolved.ok) return aoiErrorResponse(resolved);
    const regionId = resolved.region.id;
    const cellIds = resolved.coveredCells;
    const key = calendarCacheKey(serving.version, regionId, cellIds, { start, end, series: "points" });
    let columns = /** @type {PointColumns | undefined} */ (pointsCache.get(key));
    if (!columns) {
      columns = emptyColumns();
      const rows = serving.tileRows({
        regionId,
        tileIds: new Set(cellIds.map(tileOf)),
        cellIds,
        ymStart: yearMonthToYm(start),
        ymEnd: yearMonthToYm(end),
      });
      for await (const row of rows) if (row.in_series) addPoint(columns, row);
      pointsCache.set(key, columns);
    }
    return Response.json(pointsBody(start, end, columns, maxPoints));
  });
}
