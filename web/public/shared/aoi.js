// AOI rules. Polygon edges are straight lines in lon/lat everywhere here: in the
// self-intersection test, the clip, the area and the snap.
import { validateAoiShape } from "./contracts.js";
import { COLS, EARTH_RADIUS_KM, colCenterLon, rowCellAreaKm2, rowCenterLat } from "./grid.js";

/** @typedef {import("./contracts.js").Aoi} Aoi */
/** @typedef {import("./contracts.js").Invalid} Invalid */
/** @typedef {import("./contracts.js").Position} Position */
/** @typedef {import("./contracts.js").RegionId} RegionId */
/** @typedef {import("./grid.js").Bbox} Bbox */
/** @typedef {{ id: RegionId, name?: string, bbox: Bbox }} Region */
/** @typedef {{ cell_id: number, covered: number | boolean }} RegionCell */

const RAD = Math.PI / 180;

const roundTo = (x, digits) => {
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return r === 0 ? 0 : r;
};

const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1];
const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const withinBox = (a, b, p) =>
  Math.min(a[0], b[0]) <= p[0] &&
  p[0] <= Math.max(a[0], b[0]) &&
  Math.min(a[1], b[1]) <= p[1] &&
  p[1] <= Math.max(a[1], b[1]);

/** Closed segments ab and cd share at least one point. */
function segmentsMeet(a, b, c, d) {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  return (
    (o1 === 0 && withinBox(a, b, c)) ||
    (o2 === 0 && withinBox(a, b, d)) ||
    (o3 === 0 && withinBox(c, d, a)) ||
    (o4 === 0 && withinBox(c, d, b))
  );
}

/** Edges a-s and s-c meet beyond their shared vertex s only when the second doubles back. */
const foldsBack = (a, s, c) =>
  orient(a, s, c) === 0 && (a[0] - s[0]) * (c[0] - s[0]) + (a[1] - s[1]) * (c[1] - s[1]) > 0;

/** @param {Position[]} points open ring without repeated neighbours */
function selfIntersects(points) {
  const n = points.length;
  for (let i = 0; i < n; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % n];
    if (foldsBack(a, b, points[(i + 2) % n])) return true;
    const last = i === 0 ? n - 2 : n - 1;
    for (let j = i + 2; j <= last; j += 1) {
      if (segmentsMeet(a, b, points[j], points[(j + 1) % n])) return true;
    }
  }
  return false;
}

/** @param {Position[]} ring */
function openRing(ring) {
  const points = [];
  for (const p of ring) if (points.length === 0 || !samePoint(points[points.length - 1], p)) points.push(p);
  while (points.length > 1 && samePoint(points[0], points[points.length - 1])) points.pop();
  return points;
}

/** @param {string} message @returns {Invalid} */
const invalidAoi = (message) => ({ ok: false, code: "invalid_aoi", message });

/**
 * The AOI checks plus a simple-polygon test. Repeated consecutive positions are allowed.
 * @param {unknown} polygon
 * @returns {{ ok: true, value: Aoi } | Invalid}
 */
export function validateAoi(polygon) {
  const shape = validateAoiShape(polygon);
  if (!shape.ok) return shape;
  const points = openRing(shape.value.coordinates[0]);
  if (points.length < 3) return invalidAoi("the polygon needs at least 3 distinct vertices");
  if (selfIntersects(points)) {
    return invalidAoi("the polygon's edges cross or touch each other; draw it without crossing lines");
  }
  return shape;
}

/**
 * @param {number} west
 * @param {number} south
 * @param {number} east
 * @param {number} north
 * @returns {Aoi}
 */
export function boxToPolygon(west, south, east, north) {
  return {
    type: "Polygon",
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
  };
}

/**
 * Area on the sphere of a ring whose edges are straight in lon/lat, from Green's theorem:
 * R^2 times the line integral of -sin(lat) d(lon), exact for each edge. Open or closed rings,
 * either orientation.
 * @param {Position[]} ring
 */
export function polygonAreaKm2(ring) {
  let sum = 0;
  const n = ring.length;
  for (let i = 0; i < n; i += 1) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % n];
    const half = ((lat2 - lat1) * RAD) / 2;
    const sinc = half === 0 ? 1 : Math.sin(half) / half;
    sum += (lon2 - lon1) * RAD * Math.sin(((lat1 + lat2) / 2) * RAD) * sinc;
  }
  return Math.abs(sum) * EARTH_RADIUS_KM ** 2;
}

const lonCrossing = (a, b, lon) => [lon, a[1] + ((lon - a[0]) * (b[1] - a[1])) / (b[0] - a[0])];
const latCrossing = (a, b, lat) => [a[0] + ((lat - a[1]) * (b[0] - a[0])) / (b[1] - a[1]), lat];

/**
 * Sutherland-Hodgman against a bbox. A concave ring can come back with zero-width bridges
 * along the bbox edge; they add no area.
 * @param {Position[]} ring
 * @param {Bbox} bbox
 * @returns {Position[]} closed ring, or [] when nothing is inside
 */
export function clipRing(ring, [west, south, east, north]) {
  const sides = [
    [(p) => p[0] >= west, (a, b) => lonCrossing(a, b, west)],
    [(p) => p[0] <= east, (a, b) => lonCrossing(a, b, east)],
    [(p) => p[1] >= south, (a, b) => latCrossing(a, b, south)],
    [(p) => p[1] <= north, (a, b) => latCrossing(a, b, north)],
  ];
  let points = openRing(ring);
  for (const [inside, crossing] of sides) {
    const kept = [];
    for (let i = 0; i < points.length; i += 1) {
      const previous = points[(i + points.length - 1) % points.length];
      const current = points[i];
      if (inside(current)) {
        if (!inside(previous)) kept.push(crossing(previous, current));
        kept.push(current);
      } else if (inside(previous)) {
        kept.push(crossing(previous, current));
      }
    }
    points = kept;
  }
  return points.length === 0 ? [] : [...points, points[0]];
}

const insideBbox = ([lon, lat], [west, south, east, north]) =>
  lon >= west && lon <= east && lat >= south && lat <= north;

/**
 * The region whose bbox holds most of the AOI's area. `clippedFraction` is the share outside
 * it, rounded to 4 decimals and exactly 0 when every vertex is inside.
 * @param {Aoi} aoi
 * @param {Region[]} regions the `regions` of `GET /api/metadata`
 * @returns {{ ok: true, region: Region, clippedFraction: number }
 *   | { ok: false, code: "outside_regions", message: string, regions: RegionId[] }}
 */
export function pickRegion(aoi, regions) {
  const ring = aoi.coordinates[0];
  let best = null;
  let bestArea = 0;
  for (const region of regions) {
    const inside = polygonAreaKm2(clipRing(ring, region.bbox));
    if (inside > bestArea) {
      best = region;
      bestArea = inside;
    }
  }
  if (!best) {
    const names = regions.map((region) => region.name ?? region.id).join("; ");
    return {
      ok: false,
      code: "outside_regions",
      message: `The area lies outside every demo region. Available regions: ${names}.`,
      regions: regions.map((region) => region.id),
    };
  }
  const contained = ring.every((p) => insideBbox(p, best.bbox));
  const outside = contained ? 0 : Math.min(Math.max(1 - bestArea / polygonAreaKm2(ring), 0), 1);
  return { ok: true, region: best, clippedFraction: roundTo(outside, 4) };
}

const lowerBound = (sorted, x) => {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/**
 * Even-odd test along one parallel, with points on the boundary counted as inside so a box AOI
 * snaps to the same cells as `cellsInBbox`.
 * @param {number[]} edges flat [lon1, lat1, lon2, lat2, ...]
 * @param {number} lat
 * @returns {(lon: number) => boolean}
 */
function scanline(edges, lat) {
  const crossings = [];
  const touches = [];
  const spans = [];
  for (let k = 0; k < edges.length; k += 4) {
    const x1 = edges[k];
    const y1 = edges[k + 1];
    const x2 = edges[k + 2];
    const y2 = edges[k + 3];
    if (lat < Math.min(y1, y2) || lat > Math.max(y1, y2)) continue;
    if (y1 === y2) {
      spans.push(Math.min(x1, x2), Math.max(x1, x2));
      continue;
    }
    const x = lat === y1 ? x1 : lat === y2 ? x2 : x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1);
    touches.push(x);
    if (y1 > lat !== y2 > lat) crossings.push(x);
  }
  crossings.sort((a, b) => a - b);
  touches.sort((a, b) => a - b);
  return (lon) => {
    if (lowerBound(crossings, lon) % 2 === 1) return true;
    if (touches[lowerBound(touches, lon)] === lon) return true;
    for (let k = 0; k < spans.length; k += 2) if (lon >= spans[k] && lon <= spans[k + 1]) return true;
    return false;
  };
}

/**
 * The region cells whose center is inside the AOI (boundary included). Only covered cells are
 * summed by the API. `areaKm2` is the AOI's area inside `bbox` (the whole AOI when `bbox` is
 * omitted), rounded to 0.1 km2; `snappedFraction` is the snapped cells' area over it, rounded
 * to 4 decimals.
 * @param {Aoi} aoi a polygon that passed `validateAoi`
 * @param {Iterable<RegionCell>} regionCells
 * @param {Bbox} [bbox] the picked region's bbox
 * @returns {{ cells: number[], coveredCells: number[], areaKm2: number, snappedFraction: number }}
 */
export function snap(aoi, regionCells, bbox) {
  const ring = aoi.coordinates[0];
  const edges = [];
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (let i = 0; i < ring.length; i += 1) {
    const [lon, lat] = ring[i];
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    const next = ring[(i + 1) % ring.length];
    if (!samePoint(ring[i], next)) edges.push(lon, lat, next[0], next[1]);
  }

  const rows = new Map();
  const rowTest = (row) => {
    let test = rows.get(row);
    if (test === undefined) {
      const lat = rowCenterLat(row);
      test = lat >= minLat && lat <= maxLat ? scanline(edges, lat) : null;
      rows.set(row, test);
    }
    return test;
  };

  const cells = [];
  const coveredCells = [];
  let snappedArea = 0;
  let ascending = true;
  for (const { cell_id: cellId, covered } of regionCells) {
    const row = Math.floor(cellId / COLS);
    const lon = colCenterLon(cellId - row * COLS);
    if (lon < minLon || lon > maxLon) continue;
    const test = rowTest(row);
    if (test === null || !test(lon)) continue;
    if (cells.length > 0 && cellId < cells[cells.length - 1]) ascending = false;
    cells.push(cellId);
    if (covered) coveredCells.push(cellId);
    snappedArea += rowCellAreaKm2(row);
  }
  if (!ascending) {
    cells.sort((a, b) => a - b);
    coveredCells.sort((a, b) => a - b);
  }

  const area = polygonAreaKm2(bbox ? clipRing(ring, bbox) : ring);
  return {
    cells,
    coveredCells,
    areaKm2: roundTo(area, 1),
    snappedFraction: area > 0 ? roundTo(snappedArea / area, 4) : 0,
  };
}
