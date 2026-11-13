// The calendar flow from CONTRACTS, split so the current-month and export routes can reuse
// each step: open the published version, resolve the AOI to a region and its snapped cells,
// read the monthly sums, build the months.
import { createHash } from "node:crypto";
import { baselineMedians, buildMonths, fireSeason } from "../../public/shared/analytics.js";
import { pickRegion, snap, validateAoi } from "../../public/shared/aoi.js";
import { MIN_COVERED_CELLS, TIME, UNITS, validateCalendarRequest } from "../../public/shared/contracts.js";
import { openServing } from "../data/serving.js";
import { DataError } from "../data/source.js";
import { errorResponse } from "./http.js";

/** @typedef {import("../../public/shared/contracts.js").Aoi} Aoi */
/** @typedef {import("../../public/shared/contracts.js").CalendarMonth} CalendarMonth */
/** @typedef {import("../../public/shared/contracts.js").CalendarRequest} CalendarRequest */
/** @typedef {import("../../public/shared/contracts.js").CalendarResponse} CalendarResponse */
/** @typedef {import("../../public/shared/contracts.js").ErrorCode} ErrorCode */
/** @typedef {import("../../public/shared/contracts.js").Invalid} Invalid */
/** @typedef {import("../../public/shared/contracts.js").Metadata} Metadata */
/** @typedef {import("../../public/shared/contracts.js").RegionId} RegionId */
/** @typedef {import("../../public/shared/contracts.js").RegionMeta} RegionMeta */
/** @typedef {import("../../public/shared/contracts.js").Series} Series */
/** @typedef {import("../data/serving.js").MonthFlags} MonthFlags */
/** @typedef {import("../data/serving.js").MonthSums} MonthSums */
/** @typedef {import("../data/serving.js").Serving} Serving */
/** @typedef {import("../data/source.js").DataSource} DataSource */
/**
 * @typedef {object} ResolvedAoi
 * @property {true} ok
 * @property {RegionMeta} region
 * @property {number} clippedFraction
 * @property {number[]} cells snapped cells, ascending
 * @property {number[]} coveredCells the snapped cells with `covered = 1`, ascending: the ones summed
 * @property {number} areaKm2
 * @property {number} snappedFraction
 */
/** @typedef {{ ok: false, code: ErrorCode, message: string, regions?: RegionId[] }} AoiError */
/** @typedef {{ months: readonly CalendarMonth[], fire_season: readonly number[] }} CalendarMonths */

export const CACHE_SIZE = 200;
export const METADATA_CACHE_CONTROL = "public, max-age=600, s-maxage=600";
/** Set on responses built from `mocks/` because nothing is published. */
export const MOCK_HEADERS = Object.freeze({ "x-hotornot-data": "mock" });

// The cells aggregate in serving.js holds the years 2000 to 2099. A range beyond them would only
// pad nulls, and "0001-01" to "9999-12" would build and cache 120,000 months.
const FIRST_MONTH = "2000-01";
const LAST_MONTH = "2099-12";

/**
 * Adds `validateAoi`'s simple-polygon test to a `contracts.js` request validator.
 * @template {{ aoi: Aoi }} T
 * @param {(body: unknown) => ({ ok: true, value: T } | Invalid)} validate
 * @returns {(body: unknown) => ({ ok: true, value: T } | Invalid)}
 */
export function withSimpleAoi(validate) {
  return (body) => {
    const request = validate(body);
    if (!request.ok) return request;
    const aoi = validateAoi(request.value.aoi);
    return aoi.ok ? request : aoi;
  };
}

const validateCalendarShape = withSimpleAoi(validateCalendarRequest);

/**
 * The calendar (and export) body: `validateCalendarRequest`, the simple-polygon test, and
 * `start`/`end` between 2000-01 and 2099-12.
 * @param {unknown} body
 * @returns {{ ok: true, value: CalendarRequest } | Invalid}
 */
export function validateCalendarBody(body) {
  const request = validateCalendarShape(body);
  if (!request.ok) return request;
  const { start, end } = request.value;
  if (start < FIRST_MONTH || end > LAST_MONTH) {
    return { ok: false, code: "bad_range", message: `start and end must lie between ${FIRST_MONTH} and ${LAST_MONTH}` };
  }
  return request;
}

/**
 * The current published version, or null when nothing is published (no `latest.json`); routes
 * then answer from `mocks/`. Every other data failure throws.
 * @param {DataSource} [source]
 * @returns {Promise<Serving | null>}
 */
export async function openPublished(source) {
  try {
    return await openServing(source);
  } catch (error) {
    if (error instanceof DataError && error.code === "missing_latest") return null;
    throw error;
  }
}

/**
 * Published data that exists but cannot be read. CONTRACTS lists only client errors, so this
 * 503 carries its own code, `data_unavailable`.
 * @param {DataError} error
 */
export function dataUnavailableResponse(error) {
  console.error(`hotornot data: ${error.code}: ${error.message}`);
  return Response.json(
    { error: { code: "data_unavailable", message: "The published data cannot be read right now. Try again in a few minutes." } },
    { status: 503, headers: { "retry-after": "60" } },
  );
}

/**
 * Runs a route body, answering a `DataError` with `dataUnavailableResponse`.
 * @param {() => Promise<Response>} handler
 * @returns {Promise<Response>}
 */
export async function withDataErrors(handler) {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof DataError) return dataUnavailableResponse(error);
    throw error;
  }
}

/** @type {WeakMap<Serving, Metadata>} */
const metadataByServing = new WeakMap();

/**
 * `meta.metadata`, the exact body of `GET /api/metadata`, parsed once per version.
 * @param {Serving} serving
 * @returns {Metadata}
 */
export function readMetadata(serving) {
  let metadata = metadataByServing.get(serving);
  if (!metadata) {
    metadata = serving.getMeta("metadata");
    if (!metadata) throw new DataError("bad_database", `data version ${serving.version} has no meta.metadata`);
    metadataByServing.set(serving, metadata);
  }
  return metadata;
}

/**
 * The CONTRACTS AOI rules: the region whose bbox holds most of the AOI, its cells centered
 * inside the AOI, and `too_small` below 4 covered cells.
 * @param {Serving} serving
 * @param {Aoi} aoi a polygon that passed `validateAoi`
 * @returns {ResolvedAoi | AoiError}
 */
export function resolveAoi(serving, aoi) {
  const picked = pickRegion(aoi, readMetadata(serving).regions);
  if (!picked.ok) return picked;
  const region = /** @type {RegionMeta} */ (picked.region);
  const snapped = snap(aoi, serving.getRegionCells(region.id), region.bbox);
  const covered = snapped.coveredCells.length;
  if (covered < MIN_COVERED_CELLS) {
    const uncovered = snapped.cells.length - covered;
    return {
      ok: false,
      code: "too_small",
      message:
        `The area holds ${covered} grid cell${covered === 1 ? "" : "s"} with data` +
        (uncovered > 0 ? ` (and ${uncovered} in countries without data)` : "") +
        `; at least ${MIN_COVERED_CELLS} are needed. Each cell is 0.05° (about 5.5 km) across: draw a larger area.`,
    };
  }
  return { ok: true, region, clippedFraction: picked.clippedFraction, ...snapped };
}

/** @param {AoiError} error */
export const aoiErrorResponse = (error) => errorResponse(error.code, error.message, error.regions);

/**
 * Monthly sums over the covered cells for the whole record, with the region's `months` rows.
 * Medians and ranks use every year, so this never narrows to the requested range.
 * @param {Serving} serving
 * @param {RegionId} regionId
 * @param {Iterable<number>} coveredCells
 * @returns {{ sums: MonthSums[], flags: MonthFlags[] }}
 */
export function readMonthlySeries(serving, regionId, coveredCells) {
  return { sums: serving.sumCells(regionId, coveredCells), flags: serving.getMonths(regionId) };
}

/**
 * The CONTRACTS `months` and `fire_season` for a range. Raw mode has no fire season.
 * @param {{ sums: MonthSums[], flags: MonthFlags[] }} series from `readMonthlySeries`
 * @param {{ start: string, end: string, series: Series }} request
 * @returns {CalendarMonths}
 */
export function buildCalendarMonths({ sums, flags }, { start, end, series }) {
  return {
    months: buildMonths(sums, flags, series, { start, end }),
    fire_season: series === "harmonized" ? fireSeason(baselineMedians(sums, flags)) : [],
  };
}

export class LruCache {
  /** @type {Map<string, unknown>} */
  #entries = new Map();

  /** @param {number} capacity */
  constructor(capacity) {
    this.capacity = capacity;
  }

  /** @param {string} key */
  get(key) {
    if (!this.#entries.has(key)) return undefined;
    const value = this.#entries.get(key);
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  /** @param {string} key @param {unknown} value */
  set(key, value) {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    if (this.#entries.size > this.capacity) this.#entries.delete(this.#entries.keys().next().value);
  }

  get size() {
    return this.#entries.size;
  }

  clear() {
    this.#entries.clear();
  }
}

/** Months and fire season per version, region, covered cells, range and series. */
export const calendarCache = new LruCache(CACHE_SIZE);

/**
 * @param {string} version
 * @param {RegionId} regionId
 * @param {Iterable<number>} coveredCells any order
 * @param {{ start: string, end: string, series: Series }} request
 */
export function calendarCacheKey(version, regionId, coveredCells, { start, end, series }) {
  const cells = Int32Array.from(coveredCells).sort();
  return createHash("sha256")
    .update(`${version}\n${regionId}\n${start}\n${end}\n${series}\n`)
    .update(new Uint8Array(cells.buffer, cells.byteOffset, cells.byteLength))
    .digest("base64url");
}

const freezeMonths = ({ months, fire_season }) =>
  Object.freeze({ months: Object.freeze(months.map((m) => Object.freeze(m))), fire_season: Object.freeze(fire_season) });

/**
 * `buildCalendarMonths` for the covered cells, through the LRU cache. The result is shared and
 * frozen.
 * @param {Serving} serving
 * @param {RegionId} regionId
 * @param {number[]} coveredCells
 * @param {{ start: string, end: string, series: Series }} request
 * @returns {CalendarMonths & { cached: boolean }}
 */
export function calendarMonths(serving, regionId, coveredCells, request) {
  const key = calendarCacheKey(serving.version, regionId, coveredCells, request);
  const hit = /** @type {CalendarMonths | undefined} */ (calendarCache.get(key));
  if (hit) return { ...hit, cached: true };
  const built = freezeMonths(buildCalendarMonths(readMonthlySeries(serving, regionId, coveredCells), request));
  calendarCache.set(key, built);
  return { ...built, cached: false };
}

/**
 * The CONTRACTS calendar body. Only `months` and `fire_season` come from the cache: the AOI
 * block depends on the drawn polygon, not just its covered cells.
 * @param {Serving} serving
 * @param {ResolvedAoi} resolved
 * @param {{ start: string, end: string, series: Series }} request
 * @returns {{ body: CalendarResponse, cached: boolean }}
 */
export function calendarResponseBody(serving, resolved, request) {
  const { months, fire_season, cached } = calendarMonths(serving, resolved.region.id, resolved.coveredCells, request);
  return {
    cached,
    body: {
      region_id: resolved.region.id,
      units: UNITS,
      data_version: serving.version,
      weight_method: readMetadata(serving).method.weight_method,
      clipped_fraction: resolved.clippedFraction,
      aoi: {
        cells: resolved.cells.length,
        covered_cells: resolved.coveredCells.length,
        area_km2: resolved.areaKm2,
        snapped_fraction: resolved.snappedFraction,
      },
      baseline: { start_year: TIME.BASELINE.start_year, end_year: TIME.BASELINE.end_year },
      fire_season: /** @type {number[]} */ (fire_season),
      months: /** @type {CalendarMonth[]} */ (months),
    },
  };
}
