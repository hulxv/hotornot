// The CONTRACTS grid, shared by the browser and the server. pipeline/hotornot/grid.py implements
// the same formulas; both must pass shared/grid_vectors.json.
import { GRID_DEG } from "./contracts.js";

/** @typedef {import("./contracts.js").Aoi} Aoi */
/** @typedef {[west: number, south: number, east: number, north: number]} Bbox */

export const CELLS_PER_DEG = Math.round(1 / GRID_DEG);
export const ROWS = 180 * CELLS_PER_DEG;
export const COLS = 360 * CELLS_PER_DEG;
// IUGG mean radius, the sphere turf.js uses for areas.
export const EARTH_RADIUS_KM = 6371.0088;

const RAD = Math.PI / 180;
// Absorbs float error so a point on a grid line falls in the cell above or east of it:
// (-89.95 + 90) * 20 is 0.99999999999994.
const round6 = (x) => Math.round(x * 1e6) / 1e6;

/** @param {number} lat */
export const rowOf = (lat) => Math.min(Math.floor(round6((lat + 90) * CELLS_PER_DEG)), ROWS - 1);
/** @param {number} lon */
export const colOf = (lon) => Math.min(Math.floor(round6((lon + 180) * CELLS_PER_DEG)), COLS - 1);

// One division of an exact integer, so each value is the double nearest the true coordinate.
/** @param {number} row */
export const rowCenterLat = (row) => (2 * row + 1 - ROWS) / (2 * CELLS_PER_DEG);
/** @param {number} col */
export const colCenterLon = (col) => (2 * col + 1 - COLS) / (2 * CELLS_PER_DEG);
const rowSouth = (row) => (row - ROWS / 2) / CELLS_PER_DEG;
const colWest = (col) => (col - COLS / 2) / CELLS_PER_DEG;

/**
 * @param {number} lat
 * @param {number} lon
 * @returns {number} cell id
 */
export function cellOf(lat, lon) {
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) {
    throw new RangeError(`point out of range: lat ${lat}, lon ${lon}`);
  }
  return rowOf(lat) * COLS + colOf(lon);
}

/**
 * @param {number} cellId
 * @returns {[row: number, col: number]}
 */
export function rowCol(cellId) {
  if (!Number.isInteger(cellId) || cellId < 0 || cellId >= ROWS * COLS) {
    throw new RangeError(`not a cell id: ${cellId}`);
  }
  return [Math.floor(cellId / COLS), cellId % COLS];
}

/**
 * The 1-degree tile named after its south-west corner, e.g. "n30e031".
 * @param {number} cellId
 */
export function tileOf(cellId) {
  const [row, col] = rowCol(cellId);
  const lat0 = Math.floor(row / CELLS_PER_DEG) - 90;
  const lon0 = Math.floor(col / CELLS_PER_DEG) - 180;
  const ns = lat0 >= 0 ? "n" : "s";
  const ew = lon0 >= 0 ? "e" : "w";
  return `${ns}${String(Math.abs(lat0)).padStart(2, "0")}${ew}${String(Math.abs(lon0)).padStart(3, "0")}`;
}

/**
 * @param {number} cellId
 * @returns {[lon: number, lat: number]}
 */
export function center(cellId) {
  const [row, col] = rowCol(cellId);
  return [colCenterLon(col), rowCenterLat(row)];
}

/**
 * The cell as a GeoJSON Polygon with a counter-clockwise ring. Neighbours share edge values
 * exactly.
 * @param {number} cellId
 * @returns {Aoi}
 */
export function cellPolygon(cellId) {
  const [row, col] = rowCol(cellId);
  const west = colWest(col);
  const east = colWest(col + 1);
  const south = rowSouth(row);
  const north = rowSouth(row + 1);
  return {
    type: "Polygon",
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
  };
}

/**
 * Area of any cell in this row on the sphere; cells shrink towards the poles.
 * @param {number} row
 */
export function rowCellAreaKm2(row) {
  const south = rowSouth(row) * RAD;
  const north = rowSouth(row + 1) * RAD;
  return EARTH_RADIUS_KM ** 2 * (RAD / CELLS_PER_DEG) * (Math.sin(north) - Math.sin(south));
}

/** @param {number} cellId */
export const cellAreaKm2 = (cellId) => rowCellAreaKm2(rowCol(cellId)[0]);

function indicesWithCenterIn(lo, hi, offset, count, centerOf) {
  const first = Math.max(Math.floor((lo + offset) * CELLS_PER_DEG - 0.5), 0);
  const last = Math.min(Math.ceil((hi + offset) * CELLS_PER_DEG - 0.5), count - 1);
  const indices = [];
  for (let i = first; i <= last; i += 1) {
    const c = centerOf(i);
    if (c >= lo && c <= hi) indices.push(i);
  }
  return indices;
}

/**
 * Ids, ascending, of the cells whose center lies inside the bbox, edges included: the rule
 * `region_cells` is built with.
 * @param {Bbox} bbox
 * @returns {number[]}
 */
export function cellsInBbox(bbox) {
  const [west, south, east, north] = bbox;
  if (!(west <= east && south <= north)) {
    throw new RangeError(`bbox must be [west, south, east, north], got ${JSON.stringify(bbox)}`);
  }
  const rows = indicesWithCenterIn(south, north, 90, ROWS, rowCenterLat);
  const cols = indicesWithCenterIn(west, east, 180, COLS, colCenterLon);
  const ids = [];
  for (const row of rows) for (const col of cols) ids.push(row * COLS + col);
  return ids;
}
