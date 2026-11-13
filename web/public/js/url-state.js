import { REGION_IDS, SERIES } from "../shared/contracts.js";
import { boxToPolygon } from "../shared/aoi.js";

/**
 * @typedef {import("../shared/contracts.js").Aoi} Aoi
 * @typedef {import("../shared/contracts.js").RegionId} RegionId
 * @typedef {import("../shared/contracts.js").Series} Series
 * @typedef {"harmonized" | "anomaly" | "raw"} View
 * @typedef {[number, number, number, number]} Bbox west, south, east, north
 * @typedef {{ kind: "preset" } | { kind: "box", bbox: Bbox } | { kind: "polygon", polygon: Aoi }} Area
 * @typedef {{
 *   region: RegionId,
 *   area: Area,
 *   view: View,
 *   series: Series,
 *   start: string | null,
 *   end: string | null,
 *   julyStart: boolean,
 * }} AppState
 * `start`/`end` are YYYY-MM, or null for the start or end of the record.
 */

export const VIEWS = Object.freeze(/** @type {View[]} */ (["harmonized", "anomaly", "raw"]));

/** @type {Readonly<AppState>} */
export const DEFAULT_STATE = Object.freeze({
  region: "nile_delta",
  area: Object.freeze({ kind: "preset" }),
  view: "harmonized",
  series: "harmonized",
  start: null,
  end: null,
  julyStart: false,
});

/**
 * The "Try" links under the verdict. Each ends its range on the month to look at, because the
 * verdict and the outlined calendar square follow the range's last month.
 * @type {readonly { label: string, state: Readonly<AppState> }[]}
 */
export const EXAMPLES = Object.freeze([
  {
    label: "Australia's Black Summer (2019–20)",
    state: Object.freeze({ ...DEFAULT_STATE, region: "se_australia", view: "anomaly", end: "2019-12", julyStart: true }),
  },
  { label: "California 2020", state: Object.freeze({ ...DEFAULT_STATE, region: "california", end: "2020-09" }) },
  { label: "Nile Delta today", state: DEFAULT_STATE },
]);

// Coordinates go into the URL as integers of 1e-6 degree, the precision the map rounds to.
const SCALE = 1e6;
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** @param {View} view @returns {Series} */
export const seriesForView = (view) => (view === "raw" ? "raw" : "harmonized");

/** @param {number[]} bytes */
function toBase64Url(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let k = 0; k < chars; k += 1) text += BASE64URL[(chunk >> (18 - 6 * k)) & 63];
  }
  return text;
}

/** @param {string} text @returns {number[] | null} */
function fromBase64Url(text) {
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    const value = BASE64URL.indexOf(char);
    if (value < 0) return null;
    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return bytes;
}

/**
 * The polygon's ring without its closing position, as zigzag deltas of 1e-6 degree integers in
 * LEB128 varints, base64url: about 4 characters per coordinate, and safe in a URL unescaped.
 * @param {Aoi} polygon
 */
export function encodePolygon(polygon) {
  const ring = polygon.coordinates[0].slice(0, -1);
  const bytes = [];
  let previous = [0, 0];
  for (const position of ring) {
    for (let axis = 0; axis < 2; axis += 1) {
      const value = Math.round(position[axis] * SCALE);
      const delta = value - previous[axis];
      previous[axis] = value;
      let zigzag = delta < 0 ? -2 * delta - 1 : 2 * delta;
      while (zigzag >= 128) {
        bytes.push((zigzag % 128) | 128);
        zigzag = Math.floor(zigzag / 128);
      }
      bytes.push(zigzag);
    }
  }
  return toBase64Url(bytes);
}

/**
 * @param {string} text
 * @returns {Aoi | null} null when the text is not a polygon of at least 3 positions in range
 */
export function decodePolygon(text) {
  const bytes = fromBase64Url(text);
  if (!bytes) return null;
  const values = [];
  let value = 0;
  let factor = 1;
  for (const byte of bytes) {
    value += (byte & 127) * factor;
    if (byte & 128) {
      factor *= 128;
      if (factor >= 2 ** 35) return null;
      continue;
    }
    values.push(value % 2 === 1 ? -(value + 1) / 2 : value / 2);
    value = 0;
    factor = 1;
  }
  if (factor !== 1 || values.length < 6 || values.length % 2 !== 0) return null;
  const ring = [];
  const current = [0, 0];
  for (let i = 0; i < values.length; i += 2) {
    current[0] += values[i];
    current[1] += values[i + 1];
    const lon = current[0] / SCALE;
    const lat = current[1] / SCALE;
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
    ring.push([lon, lat]);
  }
  ring.push([...ring[0]]);
  return { type: "Polygon", coordinates: [/** @type {[number, number][]} */ (ring)] };
}

/** @param {string | null} text @returns {Bbox | null} */
function parseBox(text) {
  if (!text) return null;
  const parts = text.split(",");
  if (parts.length !== 4 || parts.some((part) => part.trim() === "")) return null;
  const [west, south, east, north] = parts.map(Number);
  const valid =
    [west, south, east, north].every(Number.isFinite) &&
    west >= -180 &&
    east <= 180 &&
    south >= -90 &&
    north <= 90 &&
    west < east &&
    south < north;
  return valid ? [west, south, east, north] : null;
}

/**
 * The area for a polygon: a box when it is an axis-aligned rectangle, so the URL stays readable.
 * @param {Aoi} polygon
 * @returns {Area}
 */
export function areaFromPolygon(polygon) {
  const ring = polygon.coordinates[0];
  const lons = [...new Set(ring.map(([lon]) => lon))];
  const lats = [...new Set(ring.map(([, lat]) => lat))];
  const corners = new Set(ring.slice(0, -1).map(([lon, lat]) => `${lon},${lat}`));
  const axisAligned = ring.slice(1).every(([lon, lat], i) => lon === ring[i][0] || lat === ring[i][1]);
  if (ring.length === 5 && lons.length === 2 && lats.length === 2 && corners.size === 4 && axisAligned) {
    const [west, east] = lons.sort((a, b) => a - b);
    const [south, north] = lats.sort((a, b) => a - b);
    return { kind: "box", bbox: [west, south, east, north] };
  }
  return { kind: "polygon", polygon };
}

/**
 * The polygon the API gets for the state's area: the region's bbox for a preset.
 * @param {Area} area
 * @param {{ bbox: Bbox } | undefined} region
 * @returns {Aoi | null}
 */
export function areaPolygon(area, region) {
  if (area.kind === "polygon") return area.polygon;
  const bbox = area.kind === "box" ? area.bbox : region?.bbox;
  return bbox ? boxToPolygon(...bbox) : null;
}

/** @param {string | null} text */
const yearMonth = (text) => (text && YEAR_MONTH.test(text) ? text : null);

/**
 * @param {string | URLSearchParams} search `location.search` or its parsed parameters
 * @returns {AppState}
 */
export function parseState(search) {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const region = /** @type {RegionId} */ (REGION_IDS.includes(params.get("region") ?? "") ? params.get("region") : DEFAULT_STATE.region);
  /** @type {Area} */
  let area = DEFAULT_STATE.area;
  const polygon = params.get("aoi") ? decodePolygon(/** @type {string} */ (params.get("aoi"))) : null;
  const box = parseBox(params.get("box"));
  if (polygon) area = { kind: "polygon", polygon };
  else if (box) area = { kind: "box", bbox: box };
  const view = /** @type {View} */ (VIEWS.includes(/** @type {View} */ (params.get("view"))) ? params.get("view") : DEFAULT_STATE.view);
  const requested = /** @type {Series} */ (params.get("series"));
  // Only the raw view can draw from either series; the other two need the harmonized values.
  const series = SERIES.includes(requested) && (view === "raw" || requested === "harmonized") ? requested : seriesForView(view);
  return {
    region,
    area,
    view,
    series,
    start: yearMonth(params.get("from")),
    end: yearMonth(params.get("to")),
    julyStart: params.get("july") === "1",
  };
}

/** Commas are legal in a query string and keep boxes readable. */
const encode = (value) => encodeURIComponent(value).replace(/%2C/g, ",");

/**
 * The query string for a state, leaving out defaults: "" for the default state, else "?...".
 * @param {AppState} state
 */
export function serializeState(state) {
  const pairs = [["region", state.region]];
  if (state.area.kind === "box") pairs.push(["box", state.area.bbox.map(String).join(",")]);
  if (state.area.kind === "polygon") pairs.push(["aoi", encodePolygon(state.area.polygon)]);
  if (state.view !== DEFAULT_STATE.view) pairs.push(["view", state.view]);
  if (state.series !== seriesForView(state.view)) pairs.push(["series", state.series]);
  if (state.start) pairs.push(["from", state.start]);
  if (state.end) pairs.push(["to", state.end]);
  if (state.julyStart) pairs.push(["july", "1"]);
  const isDefault = pairs.length === 1 && state.region === DEFAULT_STATE.region && state.area.kind === "preset";
  return isDefault ? "" : `?${pairs.map(([key, value]) => `${key}=${encode(value)}`).join("&")}`;
}
