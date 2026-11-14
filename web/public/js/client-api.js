import { TIME } from "../shared/contracts.js";

/**
 * @typedef {import("../shared/contracts.js").Aoi} Aoi
 * @typedef {import("../shared/contracts.js").Metadata} Metadata
 * @typedef {import("../shared/contracts.js").CalendarRequest} CalendarRequest
 * @typedef {import("../shared/contracts.js").CalendarResponse} CalendarResponse
 * @typedef {import("../shared/contracts.js").CurrentMonthResponse} CurrentMonthResponse
 * @typedef {import("../shared/contracts.js").RegionId} RegionId
 * @typedef {import("./url-state.js").AppState} AppState
 * @typedef {"network" | "server_error" | import("../shared/contracts.js").ErrorCode} ClientErrorCode
 */

export const RECORD_START_MONTH = TIME.RECORD_START.slice(0, 7);

/** An API error body, or a failure to reach the API, with the CONTRACTS code when there is one. */
export class ApiError extends Error {
  /**
   * @param {ClientErrorCode} code
   * @param {string} message
   * @param {{ status?: number, regions?: RegionId[], retryAfter?: number | null }} [details]
   */
  constructor(code, message, { status = 0, regions = [], retryAfter = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.regions = regions;
    this.retryAfter = retryAfter;
  }
}

/**
 * The last month any region has data for, from the regions' `nrt_until`.
 * @param {Metadata} metadata
 */
export function lastRecordMonth(metadata) {
  return metadata.regions.map((region) => region.coverage.nrt_until.slice(0, 7)).sort().at(-1) ?? RECORD_START_MONTH;
}

/**
 * `start`/`end` for the API: the state's months, or the whole record where they are null.
 * @param {Pick<AppState, "start" | "end">} state
 * @param {Metadata} metadata
 */
export function resolveRange(state, metadata) {
  return { start: state.start ?? RECORD_START_MONTH, end: state.end ?? lastRecordMonth(metadata) };
}

/**
 * @param {Aoi} aoi
 * @param {AppState} state
 * @param {Metadata} metadata
 * @returns {CalendarRequest}
 */
export function calendarBody(aoi, state, metadata) {
  return { aoi, ...resolveRange(state, metadata), series: state.series };
}

/** @param {Response} response */
async function errorFrom(response) {
  const retryAfter = Number(response.headers.get("retry-after"));
  const details = { status: response.status, retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null };
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const error = body?.error;
  if (error && typeof error.code === "string" && typeof error.message === "string") {
    return new ApiError(error.code, error.message, { ...details, regions: Array.isArray(error.regions) ? error.regions : [] });
  }
  return new ApiError("server_error", `The server answered ${response.status}.`, details);
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
async function request(path, init) {
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError("network", "The server could not be reached.");
  }
  if (!response.ok) throw await errorFrom(response);
  return response;
}

/** Mock routes mark their answers; the page says so instead of passing mocks off as data. */
const isMock = (response) => response.headers.get("x-hotornot-data") === "mock";

/** @returns {Promise<{ body: Metadata, mock: boolean }>} */
export async function getMetadata() {
  const response = await request("/api/metadata");
  return { body: await response.json(), mock: isMock(response) };
}

/**
 * @param {string} path
 * @param {unknown} body
 */
const post = (path, body) => request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/**
 * @param {CalendarRequest} body
 * @returns {Promise<{ body: CalendarResponse, mock: boolean }>}
 */
export async function postCalendar(body) {
  const response = await post("/api/calendar", body);
  return { body: await response.json(), mock: isMock(response) };
}

/**
 * @param {Aoi} aoi
 * @returns {Promise<{ body: CurrentMonthResponse, mock: boolean }>}
 */
export async function postCurrentMonth(aoi) {
  const response = await post("/api/current-month", { aoi });
  return { body: await response.json(), mock: isMock(response) };
}

/**
 * The days of a month the data covers: its first day to its last, or to `through` when the
 * month is still running.
 * @param {string} month YYYY-MM
 * @param {string} through YYYY-MM-DD, the last day with data
 */
export function monthDates(month, through) {
  const [year, number] = month.split("-").map(Number);
  const last = `${month}-${String(new Date(Date.UTC(year, number, 0)).getUTCDate()).padStart(2, "0")}`;
  return { from: `${month}-01`, to: through < last ? through : last };
}

/** The last day with data in any region, YYYY-MM-DD. @param {Metadata} metadata */
export const lastRecordDate = (metadata) => metadata.regions.map((region) => region.coverage.nrt_until).sort().at(-1);

/**
 * Where the fires counted in the series were, for the map.
 * @param {CalendarRequest} body
 * @returns {Promise<{ body: import("./map/point-info.js").PointsData & { month_start: string, month_end: string, total: number }, mock: boolean }>}
 */
export async function postPoints(body) {
  const response = await post("/api/points", body);
  return { body: await response.json(), mock: isMock(response) };
}

/**
 * The file name from a `Content-Disposition` header, or null.
 * @param {string | null} header
 */
export function attachmentFilename(header) {
  const match = header ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header) : null;
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]).replace(/[\\/]/g, "_");
  } catch {
    return match[1].replace(/[\\/]/g, "_");
  }
}

/**
 * @param {"hotspots" | "summary"} kind
 * @param {CalendarRequest} body
 * @returns {Promise<{ blob: Blob, filename: string | null }>}
 */
export async function postExport(kind, body) {
  const response = await post(`/api/export/${kind}`, body);
  return { blob: await response.blob(), filename: attachmentFilename(response.headers.get("content-disposition")) };
}
