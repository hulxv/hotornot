import { tileOf } from "../../public/shared/grid.js";
import { yearMonthToYm } from "../../public/shared/contracts.js";
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
/** @typedef {{ month_start: string, month_end: string, total: number, points: number[] }} PointsBody */

// MapLibre draws this many circles smoothly on a laptop; Black Summer's December alone has
// about 270,000 hotspots in south-east Australia.
export const MAX_POINTS = 60_000;

// One month of a region takes 0.3 to 4 s to read from its tiles, so recent answers are kept.
const pointsCache = new LruCache(16);

const round4 = (value) => Math.round(value * 1e4) / 1e4;

/**
 * Flat [lon, lat, lon, lat, ...] of at most `max` points, every k-th one in input order when
 * there are more, so a thinned map keeps the same spread.
 * @param {number[]} flat
 * @param {number} max
 */
export function thinPoints(flat, max) {
  const count = flat.length / 2;
  if (count <= max) return flat;
  const step = count / max;
  const out = new Array(max * 2);
  for (let i = 0; i < max; i += 1) {
    const from = Math.floor(i * step) * 2;
    out[i * 2] = flat[from];
    out[i * 2 + 1] = flat[from + 1];
  }
  return out;
}

/**
 * @param {string} start
 * @param {string} end
 * @param {number[]} flat every point, before thinning
 * @param {number} max
 * @returns {PointsBody}
 */
const pointsBody = (start, end, flat, max) => ({ month_start: start, month_end: end, total: flat.length / 2, points: thinPoints(flat, max) });

/**
 * `POST /api/points`: where the hotspots counted in the harmonized series (`in_series`) were, for
 * the calendar body's area and months, so the map can draw them.
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
      const flat = mocks.hotspotsNile
        .filter((row) => row.in_series && row.acq_date.slice(0, 7) >= start && row.acq_date.slice(0, 7) <= end)
        .flatMap((row) => [round4(row.lon), round4(row.lat)]);
      return Response.json(pointsBody(start, end, flat, maxPoints), { headers: MOCK_HEADERS });
    }
    const resolved = resolveAoi(serving, aoi);
    if (!resolved.ok) return aoiErrorResponse(resolved);
    const regionId = resolved.region.id;
    const cellIds = resolved.coveredCells;
    const key = calendarCacheKey(serving.version, regionId, cellIds, { start, end, series: "points" });
    let flat = /** @type {number[] | undefined} */ (pointsCache.get(key));
    if (!flat) {
      flat = [];
      const rows = serving.tileRows({
        regionId,
        tileIds: new Set(cellIds.map(tileOf)),
        cellIds,
        ymStart: yearMonthToYm(start),
        ymEnd: yearMonthToYm(end),
      });
      for await (const row of rows) if (row.in_series) flat.push(round4(row.lon), round4(row.lat));
      pointsCache.set(key, flat);
    }
    return Response.json(pointsBody(start, end, flat, maxPoints));
  });
}
