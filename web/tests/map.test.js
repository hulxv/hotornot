import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bboxOverlap,
  boxPolygon,
  cellsToGeoJSON,
  hatchImage,
  parseCoordinate,
  polygonBbox,
  regionsToGeoJSON,
  snappedOverlay,
  validateBox,
} from "../public/js/map/geometry.js";
import { cellPolygon as sharedCellPolygon, cellsInBbox } from "../public/shared/grid.js";
import metadata from "../mocks/metadata.json" with { type: "json" };

// The CONTRACTS cell formula, standing in for shared/grid.js.
const rowOf = (lat) => Math.min(Math.floor(Math.round((lat + 90) * 20 * 1e6) / 1e6), 3599);
const colOf = (lon) => Math.min(Math.floor(Math.round((lon + 180) * 20 * 1e6) / 1e6), 7199);
const cellOf = (lat, lon) => rowOf(lat) * 7200 + colOf(lon);
const cellPolygon = (cellId) => {
  const row = Math.floor(cellId / 7200);
  const col = cellId % 7200;
  const [west, south, east, north] = [col / 20 - 180, row / 20 - 90, (col + 1) / 20 - 180, (row + 1) / 20 - 90];
  return { type: "Polygon", coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] };
};

const regions = metadata.regions;
const box = (west, south, east, north) => ({ west, south, east, north });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
const nearAll = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => near(value, expected[i]));
};

describe("parseCoordinate", () => {
  it("accepts decimals with signs, spaces and the Unicode minus", () => {
    assert.deepEqual(parseCoordinate("31.2", "west"), { ok: true, value: 31.2 });
    assert.deepEqual(parseCoordinate("  -60.25 ", "east"), { ok: true, value: -60.25 });
    assert.deepEqual(parseCoordinate("−33.5", "south"), { ok: true, value: -33.5 });
    assert.deepEqual(parseCoordinate("+.5", "north"), { ok: true, value: 0.5 });
    assert.deepEqual(parseCoordinate("180", "east"), { ok: true, value: 180 });
  });

  it("rounds to 6 decimals", () => {
    assert.deepEqual(parseCoordinate("30.12345678", "north"), { ok: true, value: 30.123457 });
  });

  it("rejects empty, non-decimal and out-of-range text", () => {
    for (const [text, field, pattern] of [
      ["", "west", /Enter the west edge as a longitude/],
      ["   ", "north", /Enter the north edge as a latitude/],
      ["abc", "west", /West must be a number/],
      ["1e3", "east", /East must be a number/],
      ["12,5", "south", /South must be a number/],
      ["0x10", "north", /North must be a number/],
      ["Infinity", "west", /West must be a number/],
      ["-", "west", /West must be a number/],
      ["180.0001", "east", /longitude must be between -180 and 180/],
      ["-90.5", "south", /latitude must be between -90 and 90/],
    ]) {
      const result = parseCoordinate(text, field);
      assert.equal(result.ok, false, text);
      assert.match(result.error, pattern, text);
    }
  });
});

describe("validateBox", () => {
  it("returns the bbox and a closed counter-clockwise ring", () => {
    const result = validateBox(box("30.8", "30.6", "31.4", "31.1"), regions);
    assert.equal(result.ok, true);
    assert.deepEqual(result.bbox, [30.8, 30.6, 31.4, 31.1]);
    assert.deepEqual(result.polygon, {
      type: "Polygon",
      coordinates: [[[30.8, 30.6], [31.4, 30.6], [31.4, 31.1], [30.8, 31.1], [30.8, 30.6]]],
    });
  });

  it("reports every field error at once, keyed by field", () => {
    const result = validateBox(box("", "abc", "200", "45"), regions);
    assert.equal(result.ok, false);
    assert.deepEqual(Object.keys(result.errors).sort(), ["east", "south", "west"]);
  });

  it("treats a missing input object or field as empty", () => {
    assert.deepEqual(Object.keys(validateBox(undefined).errors), ["west", "south", "east", "north"]);
    assert.deepEqual(Object.keys(validateBox({ west: "1", south: "2", east: "3" }).errors), ["north"]);
  });

  it("needs west below east and south below north", () => {
    assert.deepEqual(Object.keys(validateBox(box("31.4", "30.6", "30.8", "31.1"), regions).errors), ["east"]);
    assert.deepEqual(Object.keys(validateBox(box("30.8", "31.1", "31.4", "31.1"), regions).errors), ["north"]);
    const both = validateBox(box("31", "31", "31", "30"), regions);
    assert.deepEqual(Object.keys(both.errors).sort(), ["east", "north"]);
    assert.match(both.errors.east, /180° meridian/);
  });

  it("rejects a box outside every region and hints at the signs", () => {
    const result = validateBox(box("60.2", "33", "62", "35"), regions);
    assert.equal(result.ok, false);
    assert.deepEqual(Object.keys(result.errors), ["form"]);
    assert.match(result.errors.form, /outside every demo region/);
    assert.match(result.errors.form, /Northern Argentina and Paraguayan Chaco/);
    assert.match(result.errors.form, /negative/);
  });

  it("counts only a real overlap: touching a region's edge is outside", () => {
    assert.equal(validateBox(box("32.5", "30", "33", "31"), regions).ok, false);
    assert.equal(validateBox(box("32.4", "30", "33", "31"), regions).ok, true);
    assert.equal(validateBox(box("-60", "-23", "-50", "-10"), regions).ok, true);
  });

  it("skips the region check when no regions are given", () => {
    assert.equal(validateBox(box("60.2", "33", "62", "35")).ok, true);
  });
});

describe("box helpers", () => {
  it("bboxOverlap gives square degrees and 0 for touching or disjoint boxes", () => {
    near(bboxOverlap([0, 0, 2, 2], [1, 1, 3, 4]), 1);
    assert.equal(bboxOverlap([0, 0, 1, 1], [1, 0, 2, 1]), 0);
    assert.equal(bboxOverlap([0, 0, 1, 1], [5, 5, 6, 6]), 0);
  });

  it("polygonBbox reads the outer ring", () => {
    assert.deepEqual(polygonBbox(boxPolygon([-66, -35, -57, -22])), [-66, -35, -57, -22]);
    const triangle = { type: "Polygon", coordinates: [[[30, 30], [31, 30.5], [30.2, 31.5], [30, 30]]] };
    assert.deepEqual(polygonBbox(triangle), [30, 30, 31, 31.5]);
  });
});

describe("cellsToGeoJSON", () => {
  it("draws one cell exactly where cellPolygon puts it", () => {
    const id = cellOf(30.6, 31.2);
    assert.equal(id, 17370624);
    const { type, features } = cellsToGeoJSON([id], cellPolygon);
    assert.equal(type, "FeatureCollection");
    assert.equal(features.length, 1);
    assert.deepEqual(features[0].properties, { row: 2412, first_cell: id, cells: 1 });
    nearAll(polygonBbox(features[0].geometry), [31.2, 30.6, 31.25, 30.65]);
    assert.deepEqual(features[0].geometry.coordinates[0][0], features[0].geometry.coordinates[0][4]);
  });

  it("merges consecutive cells of a row into one rectangle, in any input order, ignoring duplicates", () => {
    const base = cellOf(30.6, 31.2);
    const { features } = cellsToGeoJSON([base + 2, base, base + 1, base + 1, base + 5], cellPolygon);
    assert.equal(features.length, 2);
    assert.deepEqual(features.map((f) => f.properties.cells), [3, 1]);
    nearAll(polygonBbox(features[0].geometry), [31.2, 30.6, 31.35, 30.65]);
    nearAll(polygonBbox(features[1].geometry), [31.45, 30.6, 31.5, 30.65]);
  });

  it("never merges across rows, even when the ids are consecutive", () => {
    const lastInRow = 2412 * 7200 + 7199;
    const { features } = cellsToGeoJSON([lastInRow, lastInRow + 1], cellPolygon);
    assert.equal(features.length, 2);
    assert.deepEqual(features.map((f) => f.properties.row), [2412, 2413]);
    nearAll(polygonBbox(features[0].geometry), [179.95, 30.6, 180, 30.65]);
    nearAll(polygonBbox(features[1].geometry), [-180, 30.65, -179.95, 30.7]);
  });

  it("covers a southern-hemisphere block with one feature per row and no gaps", () => {
    const ids = [];
    for (let lat = -33.525; lat < -33.4; lat += 0.05) {
      for (let lon = -60.225; lon < -60; lon += 0.05) ids.push(cellOf(lat, lon));
    }
    const { features } = cellsToGeoJSON(ids, cellPolygon);
    assert.equal(features.length, 3);
    assert.deepEqual(features.map((f) => f.properties.cells), [5, 5, 5]);
    nearAll(polygonBbox(features[0].geometry), [-60.25, -33.55, -60, -33.5]);
    nearAll(polygonBbox(features[2].geometry), [-60.25, -33.45, -60, -33.4]);
  });

  it("accepts cellPolygon returning a Feature or a bare ring", () => {
    const asFeature = (id) => ({ type: "Feature", properties: {}, geometry: cellPolygon(id) });
    const asRing = (id) => cellPolygon(id).coordinates[0];
    const ids = [17370624, 17370625];
    const expected = cellsToGeoJSON(ids, cellPolygon);
    assert.deepEqual(cellsToGeoJSON(ids, asFeature), expected);
    assert.deepEqual(cellsToGeoJSON(ids, asRing), expected);
    assert.throws(() => cellsToGeoJSON(ids, () => ({ type: "Point", coordinates: [0, 0] })), TypeError);
  });

  it("gives the same rectangles with shared/grid.js as with the local formula", () => {
    const ids = cellsInBbox([-58, -30.5, -57, -29.4]).filter((id) => id % 3 !== 0);
    const local = cellsToGeoJSON(ids, cellPolygon).features;
    const shared = cellsToGeoJSON(ids, sharedCellPolygon).features;
    assert.equal(shared.length, local.length);
    shared.forEach((feature, i) => {
      assert.deepEqual(feature.properties, local[i].properties);
      nearAll(polygonBbox(feature.geometry), polygonBbox(local[i].geometry));
    });
  });

  it("gives an empty collection for no cells and rejects ids off the grid", () => {
    assert.deepEqual(cellsToGeoJSON([], cellPolygon), { type: "FeatureCollection", features: [] });
    for (const bad of [-1, 3600 * 7200, 1.5, Number.NaN, "17370624"]) {
      assert.throws(() => cellsToGeoJSON([bad], cellPolygon), RangeError, String(bad));
    }
  });

  it("turns a whole region into few features quickly", () => {
    const [west, south, east, north] = regions.find((r) => r.id === "se_australia").bbox;
    const ids = [];
    for (let row = rowOf(south); row < rowOf(north); row += 1) {
      for (let col = colOf(west); col < colOf(east); col += 1) ids.push(row * 7200 + col);
    }
    assert.equal(ids.length, 220 * 280);
    const started = performance.now();
    const { features } = cellsToGeoJSON(ids, cellPolygon);
    const elapsed = performance.now() - started;
    assert.equal(features.length, 220);
    assert.equal(features.reduce((sum, f) => sum + f.properties.cells, 0), ids.length);
    assert.ok(elapsed < 250, `took ${elapsed.toFixed(1)} ms`);
  });
});

describe("snappedOverlay", () => {
  it("splits counted and uncovered cells, and an id in both lists counts as uncovered", () => {
    const base = cellOf(-22.025, -63.025);
    const overlay = snappedOverlay([base, base + 1, base + 2, base + 3], [base + 1, base + 2, base + 10], cellPolygon);
    assert.equal(overlay.countedCells, 2);
    assert.equal(overlay.uncoveredCells, 3);
    assert.deepEqual(overlay.counted.features.map((f) => f.properties.first_cell), [base, base + 3]);
    assert.deepEqual(overlay.uncovered.features.map((f) => f.properties.cells), [2, 1]);
  });

  it("accepts any iterables and defaults to empty layers", () => {
    const overlay = snappedOverlay(new Set([17370624]), [], cellPolygon);
    assert.equal(overlay.counted.features.length, 1);
    assert.deepEqual(overlay.uncovered, { type: "FeatureCollection", features: [] });
  });
});

describe("regionsToGeoJSON", () => {
  it("outlines each bbox and puts a label point at its north-west corner", () => {
    const { features } = regionsToGeoJSON(regions);
    assert.equal(features.length, regions.length * 2);
    const outline = features.find((f) => f.properties.id === "n_argentina" && f.geometry.type === "Polygon");
    assert.deepEqual(outline.geometry, boxPolygon([-66, -35, -57, -22]));
    assert.equal(outline.properties.name, "Northern Argentina and Paraguayan Chaco");
    const label = features.find((f) => f.properties.id === "california" && f.geometry.type === "Point");
    assert.deepEqual(label.geometry.coordinates, [-124.5, 42]);
  });
});

describe("hatchImage", () => {
  it("is an RGBA tile whose stripe continues across tile edges", () => {
    const size = 8;
    const { width, height, data } = hatchImage({ size, stripe: 2, color: [1, 2, 3, 4] });
    assert.equal(width, size);
    assert.equal(height, size);
    assert.equal(data.length, size * size * 4);
    assert.deepEqual([...data.slice(0, 4)], [1, 2, 3, 4]);
    const lit = (x, y) => data[((y % size) * size + (x % size)) * 4 + 3] === 4;
    for (let y = 0; y < 2 * size; y += 1) {
      let count = 0;
      for (let x = 0; x < 2 * size; x += 1) {
        if (lit(x, y)) count += 1;
        if (y > 0) assert.equal(lit(x, y), lit(x + 1, y - 1), `stripe breaks at ${x},${y}`);
      }
      assert.equal(count, 4, `row ${y}`);
    }
  });
});

describe("basemap labels", async () => {
  const { ENGLISH_NAME, labelPatches, palestineLabelLayer } = await import("../public/js/map/labels.js");
  const bilingual = ["case", ["has", "name:nonlatin"], ["concat", ["get", "name:latin"], "\n", ["get", "name:nonlatin"]], ["get", "name"]];
  const country = {
    id: "label_country_3",
    type: "symbol",
    "source-layer": "place",
    minzoom: 2,
    filter: ["all", ["==", ["get", "class"], "country"], [">=", ["get", "rank"], 3]],
    layout: { "text-field": bilingual, "text-size": 10 },
    paint: { "text-color": "#334" },
  };
  const layers = [
    { id: "water", type: "fill" },
    { id: "road_one_way_arrow", type: "symbol", layout: { "icon-image": "arrow" } },
    { id: "highway-shield", type: "symbol", layout: { "text-field": ["to-string", ["get", "ref"]] } },
    { id: "label_city", type: "symbol", "source-layer": "place", filter: ["==", ["get", "class"], "city"], layout: { "text-field": bilingual } },
    {
      id: "label_other",
      type: "symbol",
      "source-layer": "place",
      minzoom: 8,
      filter: ["match", ["get", "class"], ["city", "country", "town"], false, true],
      layout: { "text-field": bilingual },
    },
    country,
  ];

  it("switches every name label to English and leaves other labels alone", () => {
    const patches = labelPatches(layers);
    assert.deepEqual(patches.map((patch) => patch.id), ["label_city", "label_other", "label_country_3"]);
    for (const patch of patches) assert.deepEqual(patch.textField, ENGLISH_NAME);
    assert.equal(JSON.stringify(ENGLISH_NAME).includes("nonlatin"), false);
  });

  it("hides the style's Israel and Palestine country labels only", () => {
    const [city, other, countryPatch] = labelPatches(layers);
    assert.equal(city.filter, undefined);
    assert.equal(other.filter, undefined);
    assert.equal(countryPatch.filter[0], "all");
    assert.deepEqual(countryPatch.filter[1], country.filter);
    assert.ok(JSON.stringify(countryPatch.filter[2]).includes('"Israel"'));
  });

  it("adds Palestine styled like the country labels", () => {
    const layer = palestineLabelLayer(layers, "hon-palestine");
    assert.equal(layer.layout["text-field"], "Palestine");
    assert.equal(layer.layout["text-size"], 10);
    assert.equal(layer.paint["text-color"], "#334");
    assert.equal(layer.minzoom, 2);
    assert.equal(layer.source, "hon-palestine");
  });
});
