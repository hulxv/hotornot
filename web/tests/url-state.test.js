import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boxToPolygon } from "../public/shared/aoi.js";
import { calendarBody, resolveRange } from "../public/js/client-api.js";
import {
  DEFAULT_STATE,
  areaFromPolygon,
  areaPolygon,
  decodePolygon,
  encodePolygon,
  parseState,
  serializeState,
} from "../public/js/url-state.js";
import metadata from "../mocks/metadata.json" with { type: "json" };

/** A closed ring of `n` vertices on a circle, rounded to 6 decimals like the map's output. */
function circle(n, [lon, lat], radius) {
  const round = (x) => Math.round(x * 1e6) / 1e6;
  const ring = Array.from({ length: n }, (_, i) => {
    const angle = (2 * Math.PI * i) / n;
    return [round(lon + radius * Math.cos(angle)), round(lat + radius * Math.sin(angle))];
  });
  return { type: "Polygon", coordinates: [[...ring, ring[0]]] };
}

/** The URL the page writes, read back the way the page reads it on load. */
const roundTrip = (state) => parseState(new URL(`https://example.org/${serializeState(state)}`).search);

describe("URL state round trip", () => {
  const triangle = { type: "Polygon", coordinates: [[[31.012345, 30.6], [31.4, 30.654321], [30.9, 31.1], [31.012345, 30.6]]] };
  const states = [
    ["the default", DEFAULT_STATE],
    ["a preset with every option set", { ...DEFAULT_STATE, region: "se_australia", view: "anomaly", start: "2010-01", end: "2020-12", julyStart: true }],
    ["a box", { ...DEFAULT_STATE, area: { kind: "box", bbox: [30.8, 30.6, 31.4, 31.1] }, view: "raw", series: "raw" }],
    ["a box with negative degrees", { ...DEFAULT_STATE, region: "n_argentina", area: { kind: "box", bbox: [-63.25, -24.5, -61.000001, -22.75] } }],
    ["a drawn polygon", { ...DEFAULT_STATE, area: { kind: "polygon", polygon: triangle }, end: "2026-11" }],
    ["a 500-vertex polygon", { ...DEFAULT_STATE, region: "california", area: { kind: "polygon", polygon: circle(500, [-120.5, 37.25], 1.5) } }],
    ["the raw view drawn from the harmonized series", { ...DEFAULT_STATE, view: "raw", series: "harmonized" }],
  ];

  for (const [name, state] of states) {
    it(`reopens ${name}`, () => {
      assert.deepEqual(roundTrip(state), state);
    });
  }

  it("writes nothing for the default state and short, readable URLs otherwise", () => {
    assert.equal(serializeState(DEFAULT_STATE), "");
    assert.equal(
      serializeState({ ...DEFAULT_STATE, area: { kind: "box", bbox: [30.8, 30.6, 31.4, 31.1] }, view: "anomaly", julyStart: true }),
      "?region=nile_delta&box=30.8,30.6,31.4,31.1&view=anomaly&july=1",
    );
    const query = serializeState({ ...DEFAULT_STATE, area: { kind: "polygon", polygon: circle(500, [-120.5, 37.25], 1.5) } });
    assert.match(query, /^\?region=nile_delta&aoi=[A-Za-z0-9_-]+$/);
    assert.ok(query.length < 4000, `500 vertices took ${query.length} characters`);
  });

  it("falls back to defaults for missing or malformed parameters", () => {
    assert.deepEqual(parseState(""), DEFAULT_STATE);
    const state = parseState("?region=atlantis&view=pie&series=both&from=2010-13&to=20&july=yes&box=1,2,3&aoi=***");
    assert.deepEqual(state, DEFAULT_STATE);
    assert.deepEqual(parseState("?box=31.4,30.6,30.8,31.1").area, DEFAULT_STATE.area, "west after east");
    assert.deepEqual(parseState("?box=30.8,30.6,31.4,91").area, DEFAULT_STATE.area, "latitude off the globe");
  });

  it("keeps the series consistent with the view", () => {
    assert.equal(parseState("?view=raw").series, "raw");
    assert.equal(parseState("?view=anomaly&series=raw").series, "harmonized");
    assert.equal(parseState("?view=raw&series=harmonized").series, "harmonized");
  });

  it("prefers a polygon over a box when a URL has both", () => {
    const query = `?box=30.8,30.6,31.4,31.1&aoi=${encodePolygon(circle(12, [31, 30.8], 0.2))}`;
    assert.equal(parseState(query).area.kind, "polygon");
  });
});

describe("polygon encoding", () => {
  it("is lossless at the map's 6 decimals, including signs and the antimeridian", () => {
    const polygon = {
      type: "Polygon",
      coordinates: [[[-179.999999, -89.5], [179.999999, -89.5], [179.999999, 89.999999], [-0.000001, 0.000001], [-179.999999, -89.5]]],
    };
    assert.deepEqual(decodePolygon(encodePolygon(polygon)), polygon);
  });

  it("uses only URL-safe characters", () => {
    assert.match(encodePolygon(circle(64, [148.5, -37], 2)), /^[A-Za-z0-9_-]+$/);
  });

  it("rejects text that is not a polygon", () => {
    assert.equal(decodePolygon(""), null);
    assert.equal(decodePolygon("not+base64"), null);
    assert.equal(decodePolygon(encodePolygon({ type: "Polygon", coordinates: [[[0, 0], [1, 1], [0, 0]]] })), null, "two positions");
    assert.equal(decodePolygon("_____________"), null, "an unterminated number");
  });
});

describe("areas", () => {
  it("turns an axis-aligned rectangle into a box and anything else into a polygon", () => {
    assert.deepEqual(areaFromPolygon(boxToPolygon(30.8, 30.6, 31.4, 31.1)), { kind: "box", bbox: [30.8, 30.6, 31.4, 31.1] });
    const clockwise = { type: "Polygon", coordinates: [[[30.8, 30.6], [30.8, 31.1], [31.4, 31.1], [31.4, 30.6], [30.8, 30.6]]] };
    assert.deepEqual(areaFromPolygon(clockwise), { kind: "box", bbox: [30.8, 30.6, 31.4, 31.1] });
    const bowTie = { type: "Polygon", coordinates: [[[30.8, 30.6], [31.4, 31.1], [31.4, 30.6], [30.8, 31.1], [30.8, 30.6]]] };
    assert.equal(areaFromPolygon(bowTie).kind, "polygon");
    const quad = { type: "Polygon", coordinates: [[[30.8, 30.6], [31.4, 30.6], [31.4, 31.1], [30.9, 31.1], [30.8, 30.6]]] };
    assert.equal(areaFromPolygon(quad).kind, "polygon");
  });

  it("gives the API the region's bbox for a preset, and the drawn area otherwise", () => {
    const nile = metadata.regions[0];
    assert.deepEqual(areaPolygon({ kind: "preset" }, nile), boxToPolygon(...nile.bbox));
    assert.deepEqual(areaPolygon({ kind: "box", bbox: [30.8, 30.6, 31.4, 31.1] }, nile), boxToPolygon(30.8, 30.6, 31.4, 31.1));
    const polygon = circle(5, [31, 30.8], 0.2);
    assert.equal(areaPolygon({ kind: "polygon", polygon }, nile), polygon);
    assert.equal(areaPolygon({ kind: "preset" }, undefined), null);
  });

  it("builds the calendar request from the state, with the whole record by default", () => {
    assert.deepEqual(resolveRange(DEFAULT_STATE, metadata), { start: "2000-11", end: "2026-11" });
    const state = { ...DEFAULT_STATE, view: "raw", series: "raw", start: "2012-01", end: "2019-12" };
    const aoi = boxToPolygon(30.8, 30.6, 31.4, 31.1);
    assert.deepEqual(calendarBody(aoi, state, metadata), { aoi, start: "2012-01", end: "2019-12", series: "raw" });
  });
});
