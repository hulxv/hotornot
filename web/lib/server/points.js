import { tileOf } from "../../public/shared/grid.js";
import { SATELLITES, validatePointsRequest, yearMonthToYm } from "../../public/shared/contracts.js";
import { mocks, resolveMockRegion } from "../../mocks/index.js";
import {
  LruCache,
  MOCK_HEADERS,
  aoiErrorResponse,
  calendarCacheKey,
  openPublished,
  resolveAoi,
  withDataErrors,
  withSimpleAoi,
} from "./calendar.js";
import { readBody } from "./http.js";

/** @typedef {import("../data/source.js").DataSource} DataSource */
/** @typedef {import("../../public/shared/contracts.js").TileRow} TileRow */
/**
 * @typedef {{
 *   points: number[], date: number[], time: number[], satellite: number[],
 *   frp: number[], weight: (number | null)[], night: number[],
 * }} PointColumns `points` is flat [lon, lat, ...]; the others hold one value per point
 * @typedef {{ columns: PointColumns, total: number, counted: number }} PointSet
 * @typedef {PointColumns & { from: string, to: string, total: number, counted: number, satellites: readonly string[] }} PointsBody
 */

// MapLibre draws this many circles smoothly on a laptop; Black Summer's December alone has
// about 230,000 counted hotspots in south-east Australia.
export const MAX_POINTS = 60_000;

// One range of a region takes 0.3 to 7 s to read from its tiles, so recent answers are kept.
const pointsCache = new LruCache(16);

const validatePointsBody = withSimpleAoi(validatePointsRequest);

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
 * Keeps every other kept point, in place.
 * @param {PointColumns} columns
 */
function halve(columns) {
  const kept = columns.date.length;
  let to = 0;
  for (let from = 0; from < kept; from += 2, to += 1) {
    columns.points[2 * to] = columns.points[2 * from];
    columns.points[2 * to + 1] = columns.points[2 * from + 1];
    for (const key of /** @type {const} */ (["date", "time", "satellite", "frp", "weight", "night"])) columns[key][to] = columns[key][from];
  }
  columns.points.length = 2 * to;
  for (const key of /** @type {const} */ (["date", "time", "satellite", "frp", "weight", "night"])) columns[key].length = to;
}

/**
 * Collects the in-series hotspots dated `from` to `to`. Every one adds to `total` and `counted`.
 * All are kept while they fit under `max`; past it, every other kept one is dropped and only
 * every 2nd, then 4th, ... hotspot is kept from then on, so the map always shows an even spread
 * of between max/2 and max dots without the rest ever being held.
 * @param {Iterable<TileRow> | AsyncIterable<TileRow>} rows
 * @param {string} from YYYY-MM-DD
 * @param {string} to YYYY-MM-DD
 * @param {number} max
 * @returns {Promise<PointSet>}
 */
export async function collectPoints(rows, from, to, max) {
  const columns = emptyColumns();
  let total = 0;
  let counted = 0;
  let stride = 1;
  for await (const row of rows) {
    if (!row.in_series || row.acq_date < from || row.acq_date > to) continue;
    if (total % stride === 0) {
      addPoint(columns, row);
      if (columns.date.length > max) {
        halve(columns);
        stride *= 2;
      }
    }
    total += 1;
    counted += row.weight ?? 0;
  }
  return { columns, total, counted: round(counted, 1) };
}

/**
 * @param {string} from
 * @param {string} to
 * @param {PointSet} set
 * @returns {PointsBody}
 */
const pointsBody = (from, to, { columns, total, counted }) => ({ from, to, total, counted, satellites: SATELLITES, ...columns });

/**
 * `POST /api/points`: where and when the hotspots counted in the harmonized series (`in_series`)
 * were, for an area and a date range, so the map can draw them and describe each.
 * @param {Request} request
 * @param {{ source?: DataSource, maxPoints?: number }} [options]
 */
export async function handlePoints(request, { source, maxPoints = MAX_POINTS } = {}) {
  const body = await readBody(request, validatePointsBody);
  if (!body.ok) return body.response;
  const { aoi, from, to } = body.value;
  const ymStart = yearMonthToYm(from.slice(0, 7));
  const ymEnd = yearMonthToYm(to.slice(0, 7));
  return withDataErrors(async () => {
    const serving = await openPublished(source);
    if (!serving) {
      const region = resolveMockRegion(aoi);
      if (!region.ok) return region.response;
      const set = await collectPoints(mocks.hotspotsNile, from, to, maxPoints);
      return Response.json(pointsBody(from, to, set), { headers: MOCK_HEADERS });
    }
    const resolved = resolveAoi(serving, aoi);
    if (!resolved.ok) return aoiErrorResponse(resolved);
    const regionId = resolved.region.id;
    const cellIds = resolved.coveredCells;
    const key = calendarCacheKey(serving.version, regionId, cellIds, { start: from, end: to, series: `points/${maxPoints}` });
    let set = /** @type {PointSet | undefined} */ (pointsCache.get(key));
    if (!set) {
      const rows = serving.tileRows({ regionId, tileIds: new Set(cellIds.map(tileOf)), cellIds, ymStart, ymEnd });
      set = await collectPoints(rows, from, to, maxPoints);
      pointsCache.set(key, set);
    }
    return Response.json(pointsBody(from, to, set));
  });
}
