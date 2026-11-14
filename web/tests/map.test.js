import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, describe, it } from "node:test";
import vm from "node:vm";
import {
  bboxOverlap,
  boxPolygon,
  cellsToGeoJSON,
  hatchImage,
  outsideRegionsMask,
  parseCoordinate,
  polygonBbox,
  regionAt,
  regionsBounds,
  regionsToGeoJSON,
  snappedOverlay,
  validateBox,
} from "../public/js/map/geometry.js";
import { ENGLISH_NAME, PALESTINE_POINT, labelPatches, palestineLabelLayer } from "../public/js/map/labels.js";
import { REGION_LABEL_LAYER, basemapPaint, fallbackStyle, overlayLayers, overlaySources } from "../public/js/map/layers.js";
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
  it("outlines each bbox and puts a label point at the middle of its top edge", () => {
    const { features } = regionsToGeoJSON(regions);
    assert.equal(features.length, regions.length * 2);
    const outline = features.find((f) => f.properties.id === "n_argentina" && f.geometry.type === "Polygon");
    assert.deepEqual(outline.geometry, boxPolygon([-66, -35, -57, -22]));
    assert.equal(outline.properties.name, "Northern Argentina and Paraguayan Chaco");
    const label = features.find((f) => f.properties.id === "california" && f.geometry.type === "Point");
    assert.deepEqual(label.geometry.coordinates, [-119.25, 42]);
    assert.equal(label.properties.name, "California and Nevada");
  });
});

describe("regionsBounds", () => {
  it("holds every region box, for the first view", () => {
    assert.deepEqual(regionsBounds(regions), [[-124.5, -39], [154, 42]]);
    assert.deepEqual(regionsBounds([{ bbox: [29.5, 29.8, 32.5, 31.8] }]), [[29.5, 29.8], [32.5, 31.8]]);
    assert.deepEqual(regionsBounds([]), [[-180, -85], [180, 85]]);
  });
});

describe("regionAt", () => {
  const id = (position, margin) => regionAt(position, regions, margin)?.id ?? null;

  it("finds the region box holding a click, edges included", () => {
    assert.equal(id([31.2, 30.6]), "nile_delta");
    assert.equal(id([-120, 37]), "california");
    assert.equal(id([147, -33]), "se_australia");
    assert.equal(id([-60, -30]), "n_argentina");
    assert.equal(id([29.5, 31.8]), "nile_delta");
    assert.equal(id([-66, -22]), "n_argentina");
  });

  it("gives null for a click outside every box", () => {
    for (const position of [[0, 0], [-40, 10], [100, 60], [33, 31], [-57.01, -35.5]]) assert.equal(id(position), null, String(position));
  });

  it("counts clicks within the margin, and picks the nearest box when two are close", () => {
    assert.equal(id([33, 31]), null);
    assert.equal(id([33, 31], 0.6), "nile_delta");
    assert.equal(id([33, 33], 0.6), null, "the margin applies to latitude too");
    const close = [{ id: "west", bbox: [0, 0, 1, 1] }, { id: "east", bbox: [2, 0, 3, 1] }];
    assert.equal(regionAt([1.4, 0.5], close, 1)?.id, "west");
    assert.equal(regionAt([1.6, 0.5], close, 1)?.id, "east");
  });

  it("accepts longitudes from the world copies either side", () => {
    assert.equal(id([31.2 + 360, 30.6]), "nile_delta");
    assert.equal(id([-120 - 360, 37]), "california");
    assert.equal(id([147 - 720, -33]), "se_australia");
  });
});

describe("outsideRegionsMask", () => {
  // Shoelace sum in lon/lat: positive for a counter-clockwise ring.
  const signedArea = (ring) => ring.slice(1).reduce((sum, [x, y], i) => sum + (ring[i][0] * y - x * ring[i][1]), 0) / 2;

  it("covers the world with one hole per region box", () => {
    const { geometry } = outsideRegionsMask(regions);
    assert.equal(geometry.type, "Polygon");
    assert.equal(geometry.coordinates.length, regions.length + 1);
    assert.deepEqual(geometry.coordinates[0][0], [-180, -85]);
    assert.deepEqual(geometry.coordinates[1], [[29.5, 29.8], [29.5, 31.8], [32.5, 31.8], [32.5, 29.8], [29.5, 29.8]]);
    for (const ring of geometry.coordinates) assert.deepEqual(ring[0], ring.at(-1));
  });

  it("winds the world counter-clockwise and the holes clockwise, as GeoJSON asks", () => {
    const [world, ...holes] = outsideRegionsMask(regions).geometry.coordinates;
    assert.equal(signedArea(world), 360 * 170);
    holes.forEach((hole, i) => {
      const [west, south, east, north] = regions[i].bbox;
      near(signedArea(hole), -(east - west) * (north - south));
    });
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

// Trimmed from https://tiles.openfreemap.org/styles/liberty on 2026-11-14: every symbol layer and a
// few others, with the layout properties that matter here; country labels keep all of theirs.
const NAME_LINES = ["case", ["has", "name:nonlatin"], ["concat", ["get", "name:latin"], "\n", ["get", "name:nonlatin"]], ["coalesce", ["get", "name_en"], ["get", "name"]]];
const NAME_SPACED = ["case", ["has", "name:nonlatin"], ["concat", ["get", "name:latin"], " ", ["get", "name:nonlatin"]], ["coalesce", ["get", "name_en"], ["get", "name"]]];
const LIBERTY_LAYERS = [
  {id:"background",type:"background",paint:{"background-color":"#f8f4f0"}},
  {id:"natural_earth",type:"raster",source:"ne2_shaded",maxzoom:7,paint:{"raster-opacity":1}},
  {id:"water",type:"fill",source:"openmaptiles","source-layer":"water",filter:["!=",["get","brunnel"],"tunnel"],paint:{"fill-color":"rgb(158,189,255)"}},
  {id:"road_one_way_arrow",type:"symbol",source:"openmaptiles","source-layer":"transportation",minzoom:16,filter:["==",["get","oneway"],1],layout:{"icon-image":"arrow"}},
  {id:"road_one_way_arrow_opposite",type:"symbol",source:"openmaptiles","source-layer":"transportation",minzoom:16,filter:["==",["get","oneway"],-1],layout:{"icon-image":"arrow"}},
  {id:"boundary_2",type:"line",source:"openmaptiles","source-layer":"boundary",filter:["all",["==",["get","admin_level"],2],["!=",["get","maritime"],1],["!=",["get","disputed"],1],["!",["has","claimed_by"]]],paint:{"line-color":"hsl(248,1%,41%)"}},
  {id:"waterway_line_label",type:"symbol",source:"openmaptiles","source-layer":"waterway",minzoom:10,filter:["match",["geometry-type"],["LineString","MultiLineString"],true,false],layout:{"text-field":NAME_SPACED,"text-font":["Noto Sans Italic"]}},
  {id:"water_name_point_label",type:"symbol",source:"openmaptiles","source-layer":"water_name",filter:["match",["geometry-type"],["MultiPoint","Point"],true,false],layout:{"text-field":NAME_LINES,"text-font":["Noto Sans Italic"]}},
  {id:"water_name_line_label",type:"symbol",source:"openmaptiles","source-layer":"water_name",filter:["match",["geometry-type"],["LineString","MultiLineString"],true,false],layout:{"text-field":NAME_SPACED,"text-font":["Noto Sans Italic"]}},
  {id:"poi_r20",type:"symbol",source:"openmaptiles","source-layer":"poi",minzoom:17,filter:["all",["match",["geometry-type"],["MultiPoint","Point"],true,false],[">=",["get","rank"],20]],layout:{"icon-image":["match",["get","subclass"],["florist","furniture"],["get","subclass"],["get","class"]],"text-field":NAME_LINES,"text-font":["Noto Sans Italic"]}},
  {id:"poi_r7",type:"symbol",source:"openmaptiles","source-layer":"poi",minzoom:16,filter:["all",["match",["geometry-type"],["MultiPoint","Point"],true,false],[">=",["get","rank"],7],["<",["get","rank"],20]],layout:{"icon-image":["match",["get","subclass"],["florist","furniture"],["get","subclass"],["get","class"]],"text-field":NAME_LINES,"text-font":["Noto Sans Italic"]}},
  {id:"poi_r1",type:"symbol",source:"openmaptiles","source-layer":"poi",minzoom:15,filter:["all",["match",["geometry-type"],["MultiPoint","Point"],true,false],[">=",["get","rank"],1],["<",["get","rank"],7]],layout:{"icon-image":["match",["get","subclass"],["florist","furniture"],["get","subclass"],["get","class"]],"text-field":NAME_LINES,"text-font":["Noto Sans Italic"]}},
  {id:"poi_transit",type:"symbol",source:"openmaptiles","source-layer":"poi",filter:["match",["get","class"],["airport","bus","rail"],true,false],layout:{"icon-image":["to-string",["get","class"]],"text-field":NAME_LINES,"text-font":["Noto Sans Italic"]}},
  {id:"highway-name-path",type:"symbol",source:"openmaptiles","source-layer":"transportation_name",minzoom:15.5,filter:["==",["get","class"],"path"],layout:{"text-field":NAME_SPACED,"text-font":["Noto Sans Regular"]}},
  {id:"highway-name-minor",type:"symbol",source:"openmaptiles","source-layer":"transportation_name",minzoom:15,filter:["all",["match",["geometry-type"],["LineString","MultiLineString"],true,false],["match",["get","class"],["minor","service","track"],true,false]],layout:{"text-field":NAME_SPACED,"text-font":["Noto Sans Regular"]}},
  {id:"highway-name-major",type:"symbol",source:"openmaptiles","source-layer":"transportation_name",minzoom:12.2,filter:["match",["get","class"],["primary","secondary","tertiary","trunk"],true,false],layout:{"text-field":NAME_SPACED,"text-font":["Noto Sans Regular"]}},
  {id:"highway-shield-non-us",type:"symbol",source:"openmaptiles","source-layer":"transportation_name",minzoom:8,filter:["all",["<=",["get","ref_length"],6],["match",["geometry-type"],["LineString","MultiLineString"],true,false],["match",["get","network"],["us-highway","us-interstate","us-state"],false,true]],layout:{"icon-image":["concat","road_",["get","ref_length"]],"text-field":["to-string",["get","ref"]],"text-font":["Noto Sans Regular"]}},
  {id:"highway-shield-us-interstate",type:"symbol",source:"openmaptiles","source-layer":"transportation_name",minzoom:7,filter:["all",["<=",["get","ref_length"],6],["match",["geometry-type"],["LineString","MultiLineString"],true,false],["match",["get","network"],["us-interstate"],true,false]],layout:{"icon-image":["concat",["get","network"],"_",["get","ref_length"]],"text-field":["to-string",["get","ref"]],"text-font":["Noto Sans Regular"]}},
  {id:"road_shield_us",type:"symbol",source:"openmaptiles","source-layer":"transportation_name",minzoom:9,filter:["all",["<=",["get","ref_length"],6],["match",["geometry-type"],["LineString","MultiLineString"],true,false],["match",["get","network"],["us-highway","us-state"],true,false]],layout:{"icon-image":["concat",["get","network"],"_",["get","ref_length"]],"text-field":["to-string",["get","ref"]],"text-font":["Noto Sans Regular"]}},
  {id:"airport",type:"symbol",source:"openmaptiles","source-layer":"aerodrome_label",minzoom:10,filter:["all",["has","iata"]],layout:{"icon-image":"airport_11","text-field":NAME_LINES,"text-font":["Noto Sans Regular"]}},
  {id:"label_other",type:"symbol",source:"openmaptiles","source-layer":"place",minzoom:8,filter:["match",["get","class"],["city","continent","country","state","town","village"],false,true],layout:{"text-field":NAME_LINES,"text-font":["Noto Sans Italic"]}},
  {id:"label_village",type:"symbol",source:"openmaptiles","source-layer":"place",minzoom:9,filter:["==",["get","class"],"village"],layout:{"icon-image":["step",["zoom"],"circle_11_black",10,""],"text-field":NAME_LINES,"text-font":["Noto Sans Regular"]}},
  {id:"label_town",type:"symbol",source:"openmaptiles","source-layer":"place",minzoom:6,filter:["==",["get","class"],"town"],layout:{"icon-image":["step",["zoom"],"circle_11_black",10,""],"text-field":NAME_LINES,"text-font":["Noto Sans Regular"]}},
  {id:"label_state",type:"symbol",source:"openmaptiles","source-layer":"place",minzoom:5,maxzoom:8,filter:["==",["get","class"],"state"],layout:{"text-field":NAME_LINES,"text-font":["Noto Sans Italic"]}},
  {id:"label_city",type:"symbol",source:"openmaptiles","source-layer":"place",minzoom:3,filter:["all",["==",["get","class"],"city"],["!=",["get","capital"],2]],layout:{"icon-image":["step",["zoom"],"circle_11_black",9,""],"text-field":NAME_LINES,"text-font":["Noto Sans Regular"]}},
  {id:"label_city_capital",type:"symbol",source:"openmaptiles","source-layer":"place",minzoom:3,filter:["all",["==",["get","class"],"city"],["==",["get","capital"],2]],layout:{"icon-image":["step",["zoom"],"circle_11_black",9,""],"text-field":NAME_LINES,"text-font":["Noto Sans Bold"]}},
  {id:"label_country_3",type:"symbol",source:"openmaptiles","source-layer":"place",minzoom:2,maxzoom:9,filter:["all",["==",["get","class"],"country"],[">=",["get","rank"],3]],layout:{"text-field":NAME_LINES,"text-font":["Noto Sans Bold"],"text-max-width":6.25,"text-size":["interpolate",["linear"],["zoom"],3,9,7,17]},paint:{"text-color":"#000","text-halo-blur":1,"text-halo-color":"#fff","text-halo-width":1}},
  {id:"label_country_2",type:"symbol",source:"openmaptiles","source-layer":"place",maxzoom:9,filter:["all",["==",["get","class"],"country"],["==",["get","rank"],2]],layout:{"text-field":NAME_LINES,"text-font":["Noto Sans Bold"],"text-max-width":6.25,"text-size":["interpolate",["linear"],["zoom"],2,9,5,17]},paint:{"text-color":"#000","text-halo-blur":1,"text-halo-color":"#fff","text-halo-width":1}},
  {id:"label_country_1",type:"symbol",source:"openmaptiles","source-layer":"place",maxzoom:9,filter:["all",["==",["get","class"],"country"],["==",["get","rank"],1]],layout:{"text-field":NAME_LINES,"text-font":["Noto Sans Bold"],"text-max-width":6.25,"text-size":["interpolate",["linear"],["zoom"],1,9,4,17]},paint:{"text-color":"#000","text-halo-blur":1,"text-halo-color":"#fff","text-halo-width":1}},
];
const LIBERTY_SOURCES = {
  ne2_shaded: { type: "raster", tileSize: 256, maxzoom: 6, tiles: ["https://tiles.openfreemap.org/natural_earth/ne2sr/{z}/{x}/{y}.png"] },
  openmaptiles: { type: "vector", url: "https://tiles.openfreemap.org/planet" },
};
const NAME_LAYERS = LIBERTY_LAYERS.filter((layer) => JSON.stringify(layer.layout?.["text-field"] ?? null).includes("name:latin"));
const COUNTRY_LAYERS = ["label_country_3", "label_country_2", "label_country_1"];

/**
 * The style map.js ends up with: label patches and the Palestine label when the style has country
 * labels, then the overlay under the first symbol layer and its labels on top.
 * @param {{ layers: any[], sources: object }} style
 */
function withOverlay(style) {
  const layers = structuredClone(style.layers);
  for (const { id, property, value } of basemapPaint(layers)) layers.find((candidate) => candidate.id === id).paint[property] = value;
  for (const { id, textField, paint, filter } of labelPatches(layers)) {
    const layer = layers.find((candidate) => candidate.id === id);
    layer.layout["text-field"] = textField;
    layer.paint = { ...layer.paint, ...paint };
    if (filter) layer.filter = filter;
  }
  const sources = { ...style.sources, ...overlaySources(regions) };
  const palestine = palestineLabelLayer(style.layers, "hon-palestine");
  if (palestine) {
    sources["hon-palestine"] = { type: "geojson", data: PALESTINE_POINT };
    layers.push(palestine);
  }
  const { underLabels, overLabels } = overlayLayers();
  const firstLabel = layers.findIndex((layer) => layer.type === "symbol");
  layers.splice(firstLabel < 0 ? layers.length : firstLabel, 0, ...underLabels);
  layers.push(...overLabels);
  return { ...style, sources, layers };
}

describe("basemap labels on the liberty style", () => {
  it("switches every name label to English and leaves shields and arrows alone", () => {
    const patches = labelPatches(LIBERTY_LAYERS);
    assert.equal(NAME_LAYERS.length, 20);
    assert.deepEqual(patches.map((patch) => patch.id), NAME_LAYERS.map((layer) => layer.id));
    for (const patch of patches) assert.deepEqual(patch.textField, ENGLISH_NAME);
    assert.equal(JSON.stringify(ENGLISH_NAME).includes("nonlatin"), false);
  });

  it("filters Israel and Palestine out of the three country label layers only", () => {
    const filtered = labelPatches(LIBERTY_LAYERS).filter((patch) => patch.filter);
    assert.deepEqual(filtered.map((patch) => patch.id), COUNTRY_LAYERS);
    for (const patch of filtered) {
      const original = LIBERTY_LAYERS.find((layer) => layer.id === patch.id);
      assert.deepEqual(patch.filter.slice(0, 2), ["all", original.filter]);
      assert.ok(JSON.stringify(patch.filter[2]).includes('"Israel"'));
    }
  });

  it("adds Palestine styled like the smallest country labels", () => {
    const layer = palestineLabelLayer(LIBERTY_LAYERS, "hon-palestine");
    assert.equal(layer.layout["text-field"], "Palestine");
    assert.deepEqual(layer.layout["text-font"], ["Noto Sans Bold"]);
    assert.deepEqual(layer.layout["text-size"], ["interpolate", ["linear"], ["zoom"], 3, 9, 7, 17]);
    assert.equal(layer.paint["text-color"], "#ffffff");
    assert.equal(layer.paint["text-halo-color"], "#0e1626");
    assert.equal(layer.minzoom, 2);
    assert.equal(layer.maxzoom, 9);
    assert.equal(layer.source, "hon-palestine");
  });
});

describe("the offline fallback style", () => {
  it("is a plain background that needs nothing from the network", () => {
    const style = fallbackStyle();
    assert.deepEqual(style.sources, {});
    assert.deepEqual(style.layers.map((layer) => layer.type), ["background"]);
    assert.equal(style.glyphs, undefined);
    assert.equal(style.sprite, undefined);
    assert.equal(JSON.stringify(style).includes("//"), false);
  });

  it("gets the shading, region boxes, names and selection overlay, but no basemap labels", () => {
    const style = withOverlay(fallbackStyle());
    assert.deepEqual(labelPatches(fallbackStyle().layers), []);
    assert.equal(palestineLabelLayer(fallbackStyle().layers, "hon-palestine"), null);
    assert.deepEqual(style.layers.map((layer) => layer.id), [
      "hon-fallback-background",
      "hon-outside",
      "hon-counted",
      "hon-uncovered",
      "hon-uncovered-hatch",
      "hon-region-outline",
      "hon-uncovered-label",
      REGION_LABEL_LAYER,
    ]);
    assert.equal(JSON.stringify(style).includes("http"), false);
  });
});

describe("the map style against the vendored MapLibre", () => {
  /** @type {(style: object) => { message: string }[]} */
  let validate;
  /** @type {(filter: unknown) => { filter: (globals: object, feature: object) => boolean }} */
  let featureFilter;
  /** @type {any} the style specification the validator uses */
  let spec;

  before(async () => {
    // The UMD bundle keeps the style-spec validator and the filter compiler in a shared chunk it
    // does not export, so the chunk is exposed while the bundle runs in a sandbox.
    const source = await readFile(new URL("../public/vendor/maplibre-gl.js", import.meta.url), "utf8");
    const hook = "modules.index(maplibregl, sharedModule);";
    assert.ok(source.includes(hook), "the vendored bundle's module loader has changed");
    const sandbox = { module: { exports: {} }, TextDecoder };
    sandbox.exports = sandbox.module.exports;
    vm.runInNewContext(source.replace(hook, `${hook} maplibregl.hotOrNotShared = sharedModule;`), sandbox);
    const shared = Object.values(sandbox.module.exports.hotOrNotShared);
    validate = shared.find((value) => typeof value === "function" && ["layer", "filter", "paintProperty", "layoutProperty", "glyphs"].every((key) => key in value));
    const compilesFilters = (fn) => {
      try {
        return typeof fn(["==", ["get", "a"], 1])?.filter === "function";
      } catch {
        return false;
      }
    };
    featureFilter = shared.find((value) => typeof value === "function" && String(value).includes("needGeometry") && compilesFilters(value));
    spec = shared.find((value) => value?.$version === 8 && value.layout_symbol);
    assert.ok(validate && featureFilter && spec, "found the validator, the filter compiler and the spec");
  });

  const messages = (style) => Array.from(validate(style), (error) => error.message);
  const liberty = { version: 8, sources: LIBERTY_SOURCES, glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf", layers: LIBERTY_LAYERS };

  it("accepts the trimmed liberty style as it is, and rejects a broken expression", () => {
    assert.deepEqual(messages(liberty), []);
    const broken = { ...liberty, layers: [{ ...LIBERTY_LAYERS[0] }, { id: "x", type: "fill", source: "openmaptiles", "source-layer": "water", paint: { "fill-color": 3 } }] };
    assert.equal(messages(broken).length, 1);
  });

  it("accepts liberty with the label patches, Palestine and every overlay layer", () => {
    const style = withOverlay(liberty);
    assert.deepEqual(messages(style), []);
    const ids = style.layers.map((layer) => layer.id);
    assert.ok(ids.indexOf("hon-region-outline") < ids.indexOf("road_one_way_arrow"), "the overlay sits under the basemap labels");
    assert.deepEqual(ids.slice(-3), ["hon-palestine-label", "hon-uncovered-label", REGION_LABEL_LAYER]);
  });

  it("accepts the fallback style with the overlay", () => {
    assert.deepEqual(messages(withOverlay(fallbackStyle())), []);
  });

  it("puts region names above small boxes and inside large ones, with anchors the spec allows", () => {
    // The validator does not check enum values inside expressions, so this does.
    const label = overlayLayers().overLabels.find((layer) => layer.id === REGION_LABEL_LAYER);
    const [step, input, below, zoom, inside] = label.layout["text-anchor"];
    assert.deepEqual([step, input, below, inside], ["step", ["zoom"], "bottom", "top"]);
    assert.ok(Object.hasOwn(spec.layout_symbol["text-anchor"].values, below) && Object.hasOwn(spec.layout_symbol["text-anchor"].values, inside));
    assert.equal(label.layout["text-offset"][3], zoom);
    assert.equal(label.layout["text-allow-overlap"], true);
  });

  it("hides the style's own Israel and Palestine labels and keeps every other country", () => {
    const patched = labelPatches(LIBERTY_LAYERS).find((patch) => patch.id === "label_country_3");
    const keep = featureFilter(patched.filter).filter;
    const country = (properties) => keep({ zoom: 4 }, { type: 1, properties: { class: "country", rank: 3, ...properties }, geometry: [] });
    assert.equal(country({ "name:en": "Israel", name: "ישראל" }), false);
    assert.equal(country({ name_en: "Israel" }), false);
    assert.equal(country({ "name:en": "Palestinian Territories" }), false);
    assert.equal(country({ "name:en": "Egypt", name: "مصر" }), true);
    assert.equal(country({ "name:en": "Jordan" }), true);
    assert.equal(country({ "name:en": "Egypt", rank: 2 }), false, "the layer's own rank filter still applies");
  });

  it("reads English names and never falls back to the local script", () => {
    const englishIs = (text, properties) => featureFilter(["==", ENGLISH_NAME, text]).filter({ zoom: 4 }, { type: 1, properties, geometry: [] });
    assert.ok(englishIs("Cairo", { name: "القاهرة", "name:en": "Cairo", "name:latin": "al-Qahira" }));
    assert.ok(englishIs("Cairo", { name: "القاهرة", name_en: "Cairo" }));
    assert.ok(englishIs("al-Qahira", { name: "القاهرة", "name:latin": "al-Qahira" }));
    assert.ok(englishIs("", { name: "القاهرة", "name:nonlatin": "القاهرة" }));
  });
});

describe("basemap contrast", () => {
  it("darkens the water, brightens the borders, and only touches layers the style has", () => {
    const layers = [{ id: "background" }, { id: "water" }, { id: "boundary_country_z5-" }, { id: "park" }];
    const patches = basemapPaint(layers);
    assert.deepEqual([...new Set(patches.map((patch) => patch.id))], ["background", "water", "boundary_country_z5-"]);
    assert.deepEqual(patches.find((patch) => patch.id === "water"), { id: "water", property: "fill-color", value: "#0e1626" });
    assert.deepEqual(basemapPaint([{ id: "hon-fallback-background" }]), []);
  });

  it("gives every name label light text on a dark halo", () => {
    for (const { paint } of labelPatches(LIBERTY_LAYERS)) {
      assert.match(paint["text-color"], /^#[0-9a-f]{6}$/);
      assert.equal(paint["text-halo-color"], "#0e1626");
    }
  });
});
