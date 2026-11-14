import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  COLS,
  EARTH_RADIUS_KM,
  ROWS,
  cellAreaKm2,
  cellOf,
  cellPolygon,
  cellsInBbox,
  center,
  rowCol,
  tileOf,
} from "../public/shared/grid.js";
import regionCells from "../mocks/region_cells-nile_delta.json" with { type: "json" };

const VECTORS = JSON.parse(readFileSync(new URL("../../shared/grid_vectors.json", import.meta.url), "utf8"));
const RAD = Math.PI / 180;

describe("grid vectors", () => {
  it("has all 44 vectors", () => assert.equal(VECTORS.length, 44));

  for (const v of VECTORS) {
    it(`lat ${v.lat}, lon ${v.lon} -> row ${v.row}, col ${v.col}, ${v.tile_id}`, () => {
      const id = cellOf(v.lat, v.lon);
      assert.equal(id, v.cell_id);
      assert.deepEqual(rowCol(id), [v.row, v.col]);
      assert.equal(v.cell_id, v.row * 7200 + v.col);
      assert.equal(tileOf(id), v.tile_id);
      assert.deepEqual(center(id), v.center);
    });
  }

  it("needs the round-to-6-decimals step for lat -89.95 and lon -179.9", () => {
    // (-89.95 + 90) * 20 is 0.99999999999994 and (-179.9 + 180) * 20 is 1.99999999999989.
    assert.equal(Math.floor((-89.95 + 90) * 20), 0);
    assert.equal(Math.floor((-179.9 + 180) * 20), 1);
    assert.deepEqual(rowCol(cellOf(-89.95, 0)), [1, 3600]);
    assert.deepEqual(rowCol(cellOf(0, -179.9)), [1800, 2]);
  });
});

describe("hand-computed cells", () => {
  it("matches the grid examples", () => {
    // row = floor(120.6 * 20) = 2412, col = floor(211.2 * 20) = 4224.
    assert.equal(cellOf(30.6, 31.2), 2412 * 7200 + 4224);
    assert.equal(cellOf(30.6, 31.2), 17370624);
    assert.equal(tileOf(17370624), "n30e031");
    // row = floor(56.5 * 20) = 1130, col = floor(119.8 * 20) = 2396; tile corner -34, -61.
    assert.equal(cellOf(-33.5, -60.2), 1130 * 7200 + 2396);
    assert.equal(tileOf(cellOf(-33.5, -60.2)), "s34w061");
  });

  it("puts points on a grid line in the cell north and east of it", () => {
    assert.deepEqual(rowCol(cellOf(30.05, 31.05)), [2401, 4221]);
    assert.deepEqual(rowCol(cellOf(30.049999, 31.049999)), [2400, 4220]);
  });

  it("clamps the north pole and the antimeridian into the last row and column", () => {
    assert.deepEqual(rowCol(cellOf(90, 180)), [ROWS - 1, COLS - 1]);
    assert.deepEqual(rowCol(cellOf(-90, -180)), [0, 0]);
  });

  it("names tiles with zero padding and the sign of the south-west corner", () => {
    assert.equal(tileOf(cellOf(-0.01, -0.01)), "s01w001");
    assert.equal(tileOf(cellOf(5.5, 7.5)), "n05e007");
    assert.equal(tileOf(cellOf(-5.5, -100.5)), "s06w101");
  });

  it("rejects points and ids off the globe", () => {
    assert.throws(() => cellOf(90.0001, 0), RangeError);
    assert.throws(() => cellOf(0, -180.5), RangeError);
    assert.throws(() => cellOf(Number.NaN, 0), RangeError);
    assert.throws(() => center(-1), RangeError);
    assert.throws(() => tileOf(ROWS * COLS), RangeError);
    assert.throws(() => cellPolygon(1.5), RangeError);
  });
});

describe("cellPolygon", () => {
  it("is a closed counter-clockwise 0.05 degree square around the center", () => {
    const id = cellOf(30.6, 31.2);
    assert.deepEqual(cellPolygon(id), {
      type: "Polygon",
      coordinates: [[[31.2, 30.6], [31.25, 30.6], [31.25, 30.65], [31.2, 30.65], [31.2, 30.6]]],
    });
  });

  it("shares edges exactly with its neighbours", () => {
    const id = cellOf(-33.5, -60.2);
    const ring = cellPolygon(id).coordinates[0];
    const east = cellPolygon(id + 1).coordinates[0];
    const north = cellPolygon(id + COLS).coordinates[0];
    assert.equal(ring[1][0], east[0][0]);
    assert.equal(ring[2][1], north[0][1]);
  });

  it("contains the center of every vector cell", () => {
    for (const v of VECTORS) {
      const [[west, south], , [east, north]] = cellPolygon(v.cell_id).coordinates[0];
      const [lon, lat] = center(v.cell_id);
      assert.ok(west < lon && lon < east && south < lat && lat < north, `cell ${v.cell_id}`);
    }
  });
});

describe("cellAreaKm2", () => {
  it("is R^2 * 0.05 degrees * (sin north - sin south)", () => {
    const expected = EARTH_RADIUS_KM ** 2 * (0.05 * RAD) * (Math.sin(0.05 * RAD) - Math.sin(0));
    assert.ok(Math.abs(cellAreaKm2(cellOf(0.01, 10)) - expected) < 1e-9);
    assert.ok(Math.abs(expected - 30.9) < 0.1);
  });

  it("adds up to the whole globe", () => {
    let total = 0;
    for (let row = 0; row < ROWS; row += 1) total += cellAreaKm2(row * COLS) * COLS;
    assert.ok(Math.abs(total / (4 * Math.PI * EARTH_RADIUS_KM ** 2) - 1) < 1e-9);
  });
});

describe("cellsInBbox", () => {
  it("rebuilds the Nile Delta region cells: 60 columns by 40 rows", () => {
    const ids = cellsInBbox([29.5, 29.8, 32.5, 31.8]);
    assert.equal(ids.length, 2400);
    assert.deepEqual(
      ids,
      regionCells.cells.map((cell) => cell.cell_id),
    );
  });

  it("includes centers on the edges", () => {
    const ids = cellsInBbox([31.025, 30.025, 31.075, 30.075]);
    assert.deepEqual(ids, [cellOf(30.03, 31.03), cellOf(30.03, 31.08), cellOf(30.08, 31.03), cellOf(30.08, 31.08)]);
  });

  it("returns ascending ids and nothing for a bbox between centers", () => {
    const ids = cellsInBbox([-66, -35, -57, -22]);
    assert.equal(ids.length, 180 * 260);
    assert.ok(ids.every((id, i) => i === 0 || id > ids[i - 1]));
    assert.deepEqual(cellsInBbox([31.03, 30.03, 31.04, 30.04]), []);
  });

  it("clips at the edges of the globe", () => {
    assert.equal(cellsInBbox([-180, -90, -179.9, -89.9]).length, 4);
    assert.equal(cellsInBbox([179.9, 89.9, 180, 90]).length, 4);
  });

  it("rejects a bbox with west after east", () => {
    assert.throws(() => cellsInBbox([32, 30, 31, 31]), RangeError);
    assert.throws(() => cellsInBbox([31, 31, 32, 30]), RangeError);
  });
});
