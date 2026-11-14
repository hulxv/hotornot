// Pure helpers for the map: box-form validation and GeoJSON builders. No DOM and no MapLibre,
// so node:test runs them; `cellPolygon` is a parameter so tests can supply their own grid.
import { GRID_DEG } from "../../shared/contracts.js";

/**
 * @typedef {import("../../shared/contracts.js").Aoi} Aoi
 * @typedef {import("../../shared/contracts.js").Position} Position
 * @typedef {import("../../shared/contracts.js").RegionMeta} RegionMeta
 * @typedef {[number, number, number, number]} Bbox [west, south, east, north]
 * @typedef {"west" | "south" | "east" | "north"} BoxField
 * @typedef {Record<BoxField, string>} BoxInput raw text of the four inputs
 * @typedef {Partial<Record<BoxField | "form", string>>} BoxErrors
 * @typedef {{ type: "Polygon", coordinates: Position[][] } | { type: "Feature", geometry: { type: "Polygon",
 *   coordinates: Position[][] } } | Position[]} CellShape what `cellPolygon` may return
 * @typedef {(cellId: number) => CellShape} CellPolygon
 * @typedef {{ type: "FeatureCollection", features: object[] }} FeatureCollection
 */

export const BOX_FIELDS = Object.freeze(/** @type {BoxField[]} */ (["west", "south", "east", "north"]));

const GRID_COLS = Math.round(360 / GRID_DEG);
const GRID_ROWS = Math.round(180 / GRID_DEG);
const COORDINATE_DECIMALS = 6;
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

const AXES = {
  west: { kind: "longitude", limit: 180 },
  east: { kind: "longitude", limit: 180 },
  south: { kind: "latitude", limit: 90 },
  north: { kind: "latitude", limit: 90 },
};

const round = (value) => Math.round(value * 10 ** COORDINATE_DECIMALS) / 10 ** COORDINATE_DECIMALS;
const capitalize = (text) => text[0].toUpperCase() + text.slice(1);

/**
 * Pasted coordinates often use the Unicode minus sign (U+2212), so it counts as "-".
 * @param {string | undefined} text
 * @param {BoxField} field
 * @returns {{ ok: true, value: number } | { ok: false, error: string }}
 */
export function parseCoordinate(text, field) {
  const { kind, limit } = AXES[field];
  const trimmed = String(text ?? "").trim().replace(/−/g, "-");
  if (trimmed === "") return { ok: false, error: `Enter the ${field} edge as a ${kind} in degrees.` };
  if (!DECIMAL.test(trimmed)) {
    return { ok: false, error: `${capitalize(field)} must be a number of degrees, such as ${field === "west" || field === "east" ? "-58.4" : "-34.6"}.` };
  }
  const value = Number(trimmed);
  if (Math.abs(value) > limit) {
    return { ok: false, error: `A ${kind} must be between -${limit} and ${limit}.` };
  }
  return { ok: true, value: round(value) };
}

/**
 * Counter-clockwise closed ring around the box.
 * @param {Bbox} bbox
 * @returns {Aoi}
 */
export function boxPolygon([west, south, east, north]) {
  return {
    type: "Polygon",
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
  };
}

/**
 * Area of overlap in square degrees; 0 when the boxes only touch.
 * @param {Bbox} a
 * @param {Bbox} b
 */
export function bboxOverlap(a, b) {
  const width = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const height = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * Inline validation for the west, south, east, north form. Field errors come first; the
 * cross-field and region checks run only once every field parses.
 * @param {BoxInput} input
 * @param {Pick<RegionMeta, "name" | "bbox">[]} [regions] when given, the box must overlap one
 * @returns {{ ok: true, bbox: Bbox, polygon: Aoi } | { ok: false, errors: BoxErrors }}
 */
export function validateBox(input, regions) {
  /** @type {BoxErrors} */
  const errors = {};
  /** @type {Partial<Record<BoxField, number>>} */
  const values = {};
  for (const field of BOX_FIELDS) {
    const parsed = parseCoordinate(input?.[field], field);
    if (parsed.ok) values[field] = parsed.value;
    else errors[field] = parsed.error;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  /** @type {Bbox} */
  const bbox = [values.west, values.south, values.east, values.north];
  const [west, south, east, north] = bbox;
  if (west >= east) {
    errors.east = "East must be greater than west. Boxes across the 180° meridian are not supported.";
  }
  if (south >= north) errors.north = "North must be greater than south.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  if (regions && !regions.some((region) => bboxOverlap(bbox, region.bbox) > 0)) {
    const names = regions.map((region) => region.name).join("; ");
    errors.form =
      `This box lies outside every demo region (${names}). ` +
      "Southern latitudes and western longitudes are negative.";
    return { ok: false, errors };
  }
  return { ok: true, bbox, polygon: boxPolygon(bbox) };
}

/**
 * @param {CellShape} shape
 * @returns {Position[]}
 */
function outerRing(shape) {
  if (Array.isArray(shape)) return shape;
  if (shape?.type === "Feature") return outerRing(shape.geometry);
  if (shape?.type === "Polygon" && Array.isArray(shape.coordinates)) return shape.coordinates[0];
  throw new TypeError("cellPolygon must return a GeoJSON Polygon, a Feature with one, or a ring of [lon, lat]");
}

/** @param {Position[]} ring */
function ringBounds(ring) {
  const lons = ring.map(([lon]) => lon);
  const lats = ring.map(([, lat]) => lat);
  return { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
}

/** @param {Iterable<number>} cellIds */
function sortedUniqueCells(cellIds) {
  const unique = new Set();
  for (const id of cellIds) {
    if (!Number.isInteger(id) || id < 0 || id >= GRID_COLS * GRID_ROWS) {
      throw new RangeError(`not a grid cell id: ${id}`);
    }
    unique.add(id);
  }
  return Float64Array.from(unique).sort();
}

/**
 * One rectangle per run of consecutive cells in the same grid row, built from the corners
 * that `cellPolygon` gives for the run's first and last cell. A whole region (60,000 cells)
 * becomes a few hundred features instead of 60,000.
 * @param {Iterable<number>} cellIds
 * @param {CellPolygon} cellPolygon
 * @returns {FeatureCollection}
 */
export function cellsToGeoJSON(cellIds, cellPolygon) {
  const ids = sortedUniqueCells(cellIds);
  const features = [];
  let start = 0;
  for (let i = 1; i <= ids.length; i += 1) {
    const continuesRun = i < ids.length && ids[i] === ids[i - 1] + 1 && ids[i] % GRID_COLS !== 0;
    if (continuesRun) continue;
    const first = ringBounds(outerRing(cellPolygon(ids[start])));
    const last = ringBounds(outerRing(cellPolygon(ids[i - 1])));
    const west = first.west;
    const east = last.east;
    const south = Math.min(first.south, last.south);
    const north = Math.max(first.north, last.north);
    features.push({
      type: "Feature",
      properties: { row: Math.floor(ids[start] / GRID_COLS), first_cell: ids[start], cells: i - start },
      geometry: boxPolygon([west, south, east, north]),
    });
    start = i;
  }
  return { type: "FeatureCollection", features };
}

/**
 * The two overlay layers. A cell listed in both arguments is drawn as uncovered only.
 * @param {Iterable<number>} cellIds snapped cells that count
 * @param {Iterable<number>} uncoveredIds snapped cells with no data
 * @param {CellPolygon} cellPolygon
 */
export function snappedOverlay(cellIds, uncoveredIds, cellPolygon) {
  const uncovered = new Set(uncoveredIds);
  const counted = [...cellIds].filter((id) => !uncovered.has(id));
  return {
    counted: cellsToGeoJSON(counted, cellPolygon),
    uncovered: cellsToGeoJSON(uncovered, cellPolygon),
    countedCells: new Set(counted).size,
    uncoveredCells: uncovered.size,
  };
}

/**
 * Region outlines plus a label point at the middle of each box's top edge.
 * @param {Pick<RegionMeta, "id" | "name" | "bbox">[]} regions
 * @returns {FeatureCollection}
 */
export function regionsToGeoJSON(regions) {
  return {
    type: "FeatureCollection",
    features: regions.flatMap(({ id, name, bbox }) => [
      { type: "Feature", properties: { id, name }, geometry: boxPolygon(bbox) },
      { type: "Feature", properties: { id, name }, geometry: { type: "Point", coordinates: [(bbox[0] + bbox[2]) / 2, bbox[3]] } },
    ]),
  };
}

/**
 * The bounds holding every region box, as MapLibre's [[west, south], [east, north]]; the whole
 * map when there are no regions.
 * @param {{ bbox: Bbox }[]} regions
 */
export function regionsBounds(regions) {
  if (regions.length === 0) return [[-180, -85], [180, 85]];
  const boxes = regions.map(({ bbox }) => bbox);
  return [
    [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1]))],
    [Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))],
  ];
}

/**
 * The region whose box holds a clicked point, or lies within `margin` degrees of it; the
 * nearest when several do. Longitudes from any world copy are accepted.
 * @template {{ bbox: Bbox }} R
 * @param {Position} position [lon, lat]
 * @param {R[]} regions
 * @param {number} [margin] degrees
 * @returns {R | null}
 */
export function regionAt([lon, lat], regions, margin = 0) {
  const x = ((((lon + 180) % 360) + 360) % 360) - 180;
  let best = null;
  let bestDistance = Infinity;
  for (const region of regions) {
    const [west, south, east, north] = region.bbox;
    const distance = Math.max(west - x, x - east, south - lat, lat - north, 0);
    if (distance <= margin && distance < bestDistance) {
      best = region;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The world with a hole for each region box, for shading everything that has no data.
 * Latitudes stop at ±85 because Web Mercator does not reach the poles.
 * @param {{ bbox: Bbox }[]} regions boxes that do not overlap
 */
export function outsideRegionsMask(regions) {
  const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
  const holes = regions.map(({ bbox: [w, s, e, n] }) => [[w, s], [w, n], [e, n], [e, s], [w, s]]);
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [world, ...holes] } };
}

/**
 * A GeoJSON FeatureCollection of points from a flat [lon, lat, lon, lat, ...] array.
 * @param {number[] | null} flat
 */
export function pointsToGeoJSON(flat) {
  const features = [];
  if (flat) {
    for (let i = 0; i + 1 < flat.length; i += 2) {
      features.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [flat[i], flat[i + 1]] } });
    }
  }
  return { type: "FeatureCollection", features };
}

/**
 * Bounds of a polygon's outer ring as [west, south, east, north].
 * @param {Aoi} polygon
 * @returns {Bbox}
 */
export function polygonBbox(polygon) {
  const { west, south, east, north } = ringBounds(outerRing(polygon));
  return [west, south, east, north];
}

/**
 * RGBA pixels for a diagonal hatch tile, for `map.addImage`: one stripe per tile, placed so
 * that it continues into the neighbouring tiles.
 * @param {{ size?: number, stripe?: number, color?: [number, number, number, number] }} [options]
 */
export function hatchImage({ size = 16, stripe = 3, color = [55, 65, 81, 230] } = {}) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if ((x + y) % size < stripe) data.set(color, (y * size + x) * 4);
    }
  }
  return { width: size, height: size, data };
}
