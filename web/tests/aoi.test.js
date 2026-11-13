import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  boxToPolygon,
  clipRing,
  pickRegion,
  polygonAreaKm2,
  snap,
  validateAoi,
} from "../public/shared/aoi.js";
import { COLS, EARTH_RADIUS_KM, cellAreaKm2, cellOf, cellsInBbox, center } from "../public/shared/grid.js";
import metadata from "../mocks/metadata.json" with { type: "json" };
import regionCellsNile from "../mocks/region_cells-nile_delta.json" with { type: "json" };

const RAD = Math.PI / 180;
const REGIONS = metadata.regions;
const NILE = REGIONS.find((region) => region.id === "nile_delta");
const polygon = (ring) => ({ type: "Polygon", coordinates: [ring] });
const close = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message ?? ""} ${actual} vs ${expected}`);
const boxArea = (west, south, east, north) =>
  EARTH_RADIUS_KM ** 2 * (east - west) * RAD * (Math.sin(north * RAD) - Math.sin(south * RAD));

/** n vertices on an ellipse; `wobble` makes a star, which is concave. */
function circle(lon, lat, radius, n, wobble = 0) {
  const ring = [];
  for (let i = 0; i < n; i += 1) {
    const angle = (2 * Math.PI * i) / n;
    const r = radius * (1 + wobble * Math.cos(7 * angle));
    ring.push([lon + r * Math.cos(angle), lat + r * 0.8 * Math.sin(angle)]);
  }
  ring.push(ring[0]);
  return polygon(ring);
}

/** Plain ray casting over every cell center, the reference `snap` must agree with. */
function bruteForceSnap(aoi, cells) {
  const ring = aoi.coordinates[0];
  return cells
    .filter(({ cell_id }) => {
      const [x, y] = center(cell_id);
      let inside = false;
      for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i, i += 1) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    })
    .map(({ cell_id }) => cell_id);
}

describe("validateAoi", () => {
  it("accepts a box and returns it", () => {
    const aoi = boxToPolygon(30.8, 30.6, 31.4, 31.1);
    assert.deepEqual(validateAoi(aoi), { ok: true, value: aoi });
  });

  it("accepts 500 vertices and rejects 501", () => {
    assert.equal(validateAoi(circle(31, 30.5, 0.5, 500)).ok, true);
    const result = validateAoi(circle(31, 30.5, 0.5, 501));
    assert.equal(result.ok, false);
    assert.equal(result.code, "too_many_vertices");
  });

  it("rejects an open ring, bad coordinates and wrong types", () => {
    const cases = [
      polygon([[30, 30], [31, 30], [31, 31], [30, 31]]),
      polygon([[30, 30], [31, 30], [31, 91], [30, 30]]),
      polygon([[30, 30], [181, 30], [31, 31], [30, 30]]),
      polygon([[30, 30], [31, "30"], [31, 31], [30, 30]]),
      polygon([[30, 30], [31, 30, 5], [31, 31], [30, 30]]),
      { type: "MultiPolygon", coordinates: [[[[30, 30], [31, 30], [31, 31], [30, 30]]]] },
      { type: "Polygon", coordinates: [] },
      null,
    ];
    for (const aoi of cases) {
      const result = validateAoi(aoi);
      assert.equal(result.ok, false, JSON.stringify(aoi));
      assert.equal(result.code, "invalid_aoi");
    }
  });

  it("rejects a self-intersecting bow tie", () => {
    const result = validateAoi(polygon([[30, 30], [31, 31], [31, 30], [30, 31], [30, 30]]));
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_aoi");
    assert.match(result.message, /cross/);
  });

  it("rejects a vertex touching another edge, a repeated vertex and a spike", () => {
    const cases = {
      touch: [[30, 30], [32, 30], [32, 32], [31, 30], [30, 32], [30, 30]],
      pinch: [[30, 30], [31, 31], [32, 30], [32, 32], [31, 31], [30, 32], [30, 30]],
      spike: [[30, 30], [32, 30], [33, 30], [31, 30], [31, 31], [30, 30]],
      collinear: [[30, 30], [31, 30], [32, 30], [30, 30]],
    };
    for (const [name, ring] of Object.entries(cases)) {
      const result = validateAoi(polygon(ring));
      assert.equal(result.ok, false, name);
      assert.equal(result.code, "invalid_aoi", name);
    }
  });

  it("accepts repeated consecutive positions and a concave star", () => {
    assert.equal(validateAoi(polygon([[30, 30], [31, 30], [31, 30], [31, 31], [30, 30]])).ok, true);
    assert.equal(validateAoi(circle(31, 30.5, 0.5, 120, 0.4)).ok, true);
  });

  it("rejects a ring with fewer than 3 distinct vertices", () => {
    const result = validateAoi(polygon([[30, 30], [31, 31], [31, 31], [30, 30]]));
    assert.equal(result.code, "invalid_aoi");
    assert.match(result.message, /3 distinct/);
  });
});

describe("boxToPolygon", () => {
  it("builds a closed counter-clockwise ring", () => {
    assert.deepEqual(boxToPolygon(-66, -35, -57, -22), {
      type: "Polygon",
      coordinates: [[[-66, -35], [-57, -35], [-57, -22], [-66, -22], [-66, -35]]],
    });
  });
});

describe("polygonAreaKm2", () => {
  it("gives R^2 * dlon * (sin north - sin south) for a box", () => {
    close(polygonAreaKm2(boxToPolygon(0, 0, 1, 1).coordinates[0]), 12363.7, 0.05);
    for (const box of [[30.8, 30.6, 31.4, 31.1], [148, -37.8, 149.5, -36.5], [-124.5, 32.5, -114, 42]]) {
      close(polygonAreaKm2(boxToPolygon(...box).coordinates[0]), boxArea(...box), 1e-6, box.join());
    }
  });

  it("gives R^2 * (1 - cos 1 degree) for the triangle (0,0) (1,0) (0,1)", () => {
    const expected = EARTH_RADIUS_KM ** 2 * (1 - Math.cos(RAD));
    close(polygonAreaKm2([[0, 0], [1, 0], [0, 1], [0, 0]]), expected, 1e-6);
  });

  it("ignores orientation and the closing position", () => {
    const ring = [[30, 30], [31, 30], [31.5, 31], [30, 30.5], [30, 30]];
    const area = polygonAreaKm2(ring);
    close(polygonAreaKm2([...ring].reverse()), area, 1e-9);
    close(polygonAreaKm2(ring.slice(0, -1)), area, 1e-9);
  });

  it("equals the sum of the grid cells a grid-aligned box covers", () => {
    const ids = cellsInBbox([31.0, 30.0, 31.5, 30.5]);
    assert.equal(ids.length, 100);
    const cells = ids.reduce((sum, id) => sum + cellAreaKm2(id), 0);
    close(polygonAreaKm2(boxToPolygon(31.0, 30.0, 31.5, 30.5).coordinates[0]), cells, 1e-9);
  });
});

describe("clipRing", () => {
  it("returns a ring inside the bbox unchanged", () => {
    const ring = boxToPolygon(30.8, 30.6, 31.4, 31.1).coordinates[0];
    assert.deepEqual(clipRing(ring, NILE.bbox), ring);
  });

  it("cuts a box at the bbox edge", () => {
    const clipped = clipRing(boxToPolygon(32, 30, 33, 30.5).coordinates[0], NILE.bbox);
    close(polygonAreaKm2(clipped), boxArea(32, 30, 32.5, 30.5), 1e-6);
    assert.ok(clipped.every(([lon]) => lon <= 32.5));
  });

  it("keeps the area of a concave ring that leaves and re-enters", () => {
    const u = [[30, 30], [34, 30], [34, 31], [33, 31], [33, 30.5], [31, 30.5], [31, 31], [30, 31], [30, 30]];
    const clipped = clipRing(u, [29.5, 30.25, 32.5, 32]);
    const expected = boxArea(30, 30.25, 32.5, 30.5) + boxArea(30, 30.5, 31, 31);
    close(polygonAreaKm2(clipped), expected, 1e-6);
  });

  it("returns nothing when the ring is outside", () => {
    assert.deepEqual(clipRing(boxToPolygon(-30, 10, -29, 11).coordinates[0], NILE.bbox), []);
  });
});

describe("pickRegion", () => {
  it("picks the Nile Delta for an AOI inside it, with clipped_fraction exactly 0", () => {
    const result = pickRegion(boxToPolygon(30.8, 30.6, 31.4, 31.1), REGIONS);
    assert.equal(result.ok, true);
    assert.equal(result.region.id, "nile_delta");
    assert.equal(result.clippedFraction, 0);
  });

  it("reports the share outside the region for an AOI crossing its east edge", () => {
    // 32.0 to 33.0 E against an edge at 32.5 E: equal widths, same latitudes, so half the area.
    const result = pickRegion(boxToPolygon(32, 30, 33, 30.5), REGIONS);
    assert.equal(result.region.id, "nile_delta");
    assert.equal(result.clippedFraction, 0.5);
    // A quarter of the width lies outside the north-west corner.
    const corner = pickRegion(boxToPolygon(29.25, 31.5, 30.25, 32.1), REGIONS);
    const inside = boxArea(29.5, 31.5, 30.25, 31.8);
    const expected = 1 - inside / boxArea(29.25, 31.5, 30.25, 32.1);
    close(corner.clippedFraction, Math.round(expected * 1e4) / 1e4, 0);
  });

  it("answers outside_regions with every region for an AOI in the Atlantic", () => {
    const result = pickRegion(boxToPolygon(-30, 10, -29, 11), REGIONS);
    assert.equal(result.ok, false);
    assert.equal(result.code, "outside_regions");
    assert.deepEqual(result.regions, ["nile_delta", "california", "se_australia", "n_argentina"]);
    assert.match(result.message, /Nile Delta, Egypt; California and Nevada/);
  });

  it("treats an AOI that only touches a bbox edge as outside", () => {
    assert.equal(pickRegion(boxToPolygon(32.5, 30, 33, 30.5), REGIONS).ok, false);
  });

  it("picks the region holding most of the area when two overlap", () => {
    const regions = [
      { id: "nile_delta", name: "A", bbox: [0, 0, 10, 10] },
      { id: "california", name: "B", bbox: [10, 0, 20, 10] },
    ];
    const result = pickRegion(boxToPolygon(9, 1, 12, 2), regions);
    assert.equal(result.region.id, "california");
    assert.equal(result.clippedFraction, Math.round((1 / 3) * 1e4) / 1e4);
  });
});

describe("snap", () => {
  const nileCells = regionCellsNile.cells;

  it("snaps the W01 acceptance box to 12 columns by 10 rows", () => {
    const aoi = boxToPolygon(30.8, 30.6, 31.4, 31.1);
    const result = snap(aoi, nileCells, NILE.bbox);
    assert.equal(result.cells.length, 120);
    assert.deepEqual(result.cells, cellsInBbox([30.8, 30.6, 31.4, 31.1]));
    assert.deepEqual(result.coveredCells, result.cells);
    assert.equal(result.areaKm2, Math.round(boxArea(30.8, 30.6, 31.4, 31.1) * 10) / 10);
    assert.equal(result.snappedFraction, 1);
  });

  it("drops uncovered cells from coveredCells only", () => {
    const blocked = new Set([cellOf(30.62, 30.82), cellOf(30.62, 30.87)]);
    const cells = nileCells.map(({ cell_id }) => ({ cell_id, covered: blocked.has(cell_id) ? 0 : 1 }));
    const result = snap(boxToPolygon(30.8, 30.6, 31.4, 31.1), cells, NILE.bbox);
    assert.equal(result.cells.length, 120);
    assert.equal(result.coveredCells.length, 118);
    assert.ok([...blocked].every((id) => result.cells.includes(id) && !result.coveredCells.includes(id)));
  });

  it("keeps only region cells for an AOI crossing the region edge, measured inside the bbox", () => {
    const result = snap(boxToPolygon(32, 30, 33, 30.5), nileCells, NILE.bbox);
    assert.equal(result.cells.length, 100);
    assert.ok(result.cells.every((id) => center(id)[0] < 32.5));
    assert.equal(result.areaKm2, Math.round(boxArea(32, 30, 32.5, 30.5) * 10) / 10);
    assert.equal(result.snappedFraction, 1);
    const whole = snap(boxToPolygon(32, 30, 33, 30.5), nileCells);
    assert.equal(whole.snappedFraction, 0.5);
  });

  it("finds nothing for an AOI outside the region", () => {
    const result = snap(boxToPolygon(-30, 10, -29, 11), nileCells, NILE.bbox);
    assert.deepEqual(result, { cells: [], coveredCells: [], areaKm2: 0, snappedFraction: 0 });
  });

  it("counts centers on the boundary, like cellsInBbox", () => {
    const box = [31.025, 30.025, 31.125, 30.125];
    const result = snap(boxToPolygon(...box), nileCells, NILE.bbox);
    assert.deepEqual(result.cells, cellsInBbox(box));
    assert.equal(result.cells.length, 9);
  });

  it("agrees with brute-force ray casting on a triangle, a star and a 500-vertex circle", () => {
    const shapes = [
      polygon([[29.91, 29.93], [32.31, 30.42], [30.63, 31.71], [29.91, 29.93]]),
      circle(31, 30.8, 0.9, 140, 0.45),
      circle(30.4, 30.3, 0.37, 500),
    ];
    for (const aoi of shapes) {
      assert.equal(validateAoi(aoi).ok, true);
      const expected = bruteForceSnap(aoi, nileCells);
      assert.ok(expected.length > 50);
      assert.deepEqual(snap(aoi, nileCells, NILE.bbox).cells, expected);
    }
  });

  it("sorts ids even when region cells arrive unordered", () => {
    const shuffled = [...nileCells].reverse();
    const aoi = boxToPolygon(30.8, 30.6, 31.4, 31.1);
    assert.deepEqual(snap(aoi, shuffled).cells, snap(aoi, nileCells).cells);
  });

  it("gives snapped area over AOI area for a polygon off the grid lines", () => {
    const aoi = boxToPolygon(30.81, 30.61, 31.41, 31.11);
    const result = snap(aoi, nileCells, NILE.bbox);
    const snapped = result.cells.reduce((sum, id) => sum + cellAreaKm2(id), 0);
    assert.equal(result.cells.length, 120);
    assert.equal(result.snappedFraction, Math.round((snapped / boxArea(30.81, 30.61, 31.41, 31.11)) * 1e4) / 1e4);
  });

  it("snaps a 500-vertex AOI over 60,000 region cells in under 50 ms", () => {
    const bbox = [-68, -35, -56, -22];
    const ids = cellsInBbox(bbox);
    assert.equal(ids.length, 240 * 260);
    const cells = ids.map((cell_id) => ({ cell_id, covered: (cell_id % COLS) % 17 === 0 ? 0 : 1 }));
    const aoi = circle(-62, -28.5, 5, 500, 0.15);
    assert.equal(validateAoi(aoi).ok, true);
    snap(aoi, cells, bbox);
    const times = [];
    let result;
    for (let i = 0; i < 9; i += 1) {
      const t0 = performance.now();
      result = snap(aoi, cells, bbox);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const medianMs = times[4];
    assert.ok(result.cells.length > 20000);
    assert.ok(medianMs < 50, `snap took ${medianMs.toFixed(1)} ms`);
    console.log(`snap: ${cells.length} region cells, ${result.cells.length} snapped, median ${medianMs.toFixed(2)} ms`);
  });
});
