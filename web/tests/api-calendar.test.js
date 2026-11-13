import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { POST as postCalendar } from "../api/calendar.js";
import { GET as getMetadata } from "../api/metadata.js";
import { openServing } from "../lib/data/serving.js";
import { DataSource, resetDataSource } from "../lib/data/source.js";
import { CACHE_SIZE, LruCache, calendarCache, calendarCacheKey } from "../lib/server/calendar.js";
import { mocks } from "../mocks/index.js";
import { boxToPolygon } from "../public/shared/aoi.js";
import { checkApiError, checkCalendarResponse, checkMetadata } from "../public/shared/contracts.js";
import { cellsInBbox } from "../public/shared/grid.js";
import { fixtureDir } from "./fixtures/fixture.js";

const FIXTURE = fixtureDir();
const temps = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "hotornot-calendar-test-"));
  temps.push(dir);
  return dir;
};

/** @param {string} dir */
function useData(dir) {
  process.env.DATA_BASE_URL = dir;
  resetDataSource();
}

before(() => useData(FIXTURE));
after(() => {
  resetDataSource();
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const BOX_400 = [30.5, 30.5, 31.5, 31.5];
const AOI_400 = boxToPolygon(...BOX_400);
const REGION_BOXES = {
  nile_delta: [29.5, 29.8, 32.5, 31.8],
  california: [-124.5, 32.5, -114, 42],
  se_australia: [140, -39, 154, -28],
  n_argentina: [-66, -35, -57, -22],
};
const BODY = { aoi: AOI_400, start: "2000-11", end: "2026-11", series: "harmonized" };

const post = (body) =>
  new Request("http://localhost/api/calendar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function calendar(body) {
  const response = await postCalendar(post(body));
  assert.equal(response.status, 200, await response.clone().text());
  const json = await response.json();
  assert.deepEqual(checkCalendarResponse(json), []);
  return { body: json, cache: response.headers.get("x-hotornot-cache"), response };
}

async function expectError(body, status, code) {
  const response = await postCalendar(post(body));
  assert.equal(response.status, status);
  const json = await response.json();
  assert.deepEqual(checkApiError(json), []);
  assert.equal(json.error.code, code, json.error.message);
  return json.error;
}

const ymOf = (m) => m.year * 100 + m.month;
const close = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-3, `${label}: ${actual} != ${expected}`);

describe("GET /api/metadata", () => {
  it("returns meta.metadata unchanged, cached for 10 minutes", async () => {
    const response = await getMetadata();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /(^|[ ,])max-age=600(,|$)/);
    assert.equal(response.headers.get("x-hotornot-data"), null);
    const text = await response.text();
    const db = new DatabaseSync(join(FIXTURE, "v3", "serving.sqlite"), { readOnly: true });
    const stored = db.prepare("SELECT value FROM meta WHERE key = 'metadata'").get().value;
    db.close();
    assert.equal(text, JSON.stringify(JSON.parse(stored)));
    assert.deepEqual(checkMetadata(JSON.parse(text)), []);
  });
});

describe("POST /api/calendar on the fixture", () => {
  it("sums the covered cells of a 400-cell AOI, matching the point tiles", async () => {
    const { body } = await calendar(BODY);
    assert.equal(body.region_id, "nile_delta");
    assert.equal(body.data_version, "v3");
    assert.equal(body.weight_method, "model_v1");
    assert.equal(body.units, "modis_equivalent_hotspots");
    assert.equal(body.clipped_fraction, 0);
    assert.deepEqual(body.baseline, { start_year: 2003, end_year: 2025 });
    assert.deepEqual({ cells: body.aoi.cells, covered: body.aoi.covered_cells }, { cells: 400, covered: 400 });
    assert.equal(body.aoi.snapped_fraction, 1);
    assert.equal(body.months.length, 313);
    assert.deepEqual([body.months[0].year, body.months[0].month], [2000, 11]);
    assert.deepEqual([body.months.at(-1).year, body.months.at(-1).month], [2026, 11]);

    const cells = cellsInBbox(BOX_400);
    const serving = await openServing(new DataSource({ baseUrl: FIXTURE }));
    const truth = new Map();
    for await (const row of serving.tileRows({ regionId: "nile_delta", cellIds: cells })) {
      const ym = Number(row.acq_date.slice(0, 4) + row.acq_date.slice(5, 7));
      const t = truth.get(ym) ?? { value: 0, modis: 0, viirs: 0 };
      truth.set(ym, t);
      if (row.sensor === "MODIS" && row.weight !== null) t.modis += 1;
      if (!row.in_series) continue;
      t.value += row.weight;
      if (row.sensor === "VIIRS_375") t.viirs += 1;
    }
    assert.ok(truth.size > 50, "the AOI should hold many months with hotspots");
    for (const m of body.months) {
      const t = truth.get(ymOf(m)) ?? { value: 0, modis: 0, viirs: 0 };
      close(m.value, t.value, `value ${ymOf(m)}`);
      assert.equal(m.modis_raw, t.modis, `modis_raw ${ymOf(m)}`);
      assert.equal(m.viirs_raw, ymOf(m) < 201201 ? null : t.viirs, `viirs_raw ${ymOf(m)}`);
    }
    assert.deepEqual(body.fire_season, [5, 6, 10, 11]);
  });

  it("trims to the range but keeps statistics from the whole record", async () => {
    const full = (await calendar(BODY)).body;
    const { body } = await calendar({ ...BODY, start: "2025-01", end: "2025-12" });
    assert.equal(body.months.length, 12);
    assert.deepEqual(body.months, full.months.filter((m) => m.year === 2025));
    assert.deepEqual(body.fire_season, full.fire_season);
  });

  it("pads months outside the record with nulls", async () => {
    const { body } = await calendar({ ...BODY, start: "2000-01", end: "2001-02" });
    assert.equal(body.months.length, 14);
    for (const m of body.months.slice(0, 10)) {
      assert.deepEqual(
        [m.value, m.modis_raw, m.viirs_raw, m.median, m.rank, m.provisional, m.partial_coverage],
        [null, null, null, null, null, false, false],
      );
    }
    assert.ok(body.months.slice(10).every((m) => m.value !== null && m.partial_coverage && m.rank === null));
    const late = (await calendar({ ...BODY, start: "2026-10", end: "2027-01" })).body.months;
    assert.deepEqual(
      late.map((m) => m.value === null),
      [false, false, true, true],
    );
    assert.ok(late[1].provisional);
  });

  it("serves raw counts without values or analytics in raw mode", async () => {
    const harmonized = (await calendar(BODY)).body;
    const { body } = await calendar({ ...BODY, series: "raw" });
    assert.deepEqual(body.fire_season, []);
    assert.equal(body.months.length, 313);
    body.months.forEach((m, i) => {
      assert.deepEqual([m.value, m.median, m.anomaly_log2, m.difference, m.rank, m.of_years], [null, null, null, null, null, null]);
      assert.equal(m.modis_raw, harmonized.months[i].modis_raw);
      assert.equal(m.viirs_raw, harmonized.months[i].viirs_raw);
    });
  });

  it("picks each region for its whole bbox and sums only covered cells", async () => {
    for (const [regionId, box] of Object.entries(REGION_BOXES)) {
      const { body } = await calendar({ ...BODY, aoi: boxToPolygon(...box) });
      assert.equal(body.region_id, regionId);
      assert.equal(body.aoi.cells, cellsInBbox(box).length, regionId);
      assert.equal(body.clipped_fraction, 0);
      if (regionId === "n_argentina") assert.ok(body.aoi.covered_cells < body.aoi.cells);
      else assert.equal(body.aoi.covered_cells, body.aoi.cells);
    }
  });

  it("reports the clipped fraction of an AOI crossing a region edge", async () => {
    const { body } = await calendar({ ...BODY, aoi: boxToPolygon(32, 30.5, 33, 31) });
    assert.equal(body.region_id, "nile_delta");
    close(body.clipped_fraction, 0.5, "clipped_fraction");
    assert.equal(body.aoi.cells, 100);
    assert.equal(body.aoi.snapped_fraction, 1);
  });
});

describe("POST /api/calendar errors", () => {
  it("invalid_aoi (422)", async () => {
    const bowTie = { type: "Polygon", coordinates: [[[31, 30.5], [31.5, 31], [31.5, 30.5], [31, 31], [31, 30.5]]] };
    await expectError({ ...BODY, aoi: bowTie }, 422, "invalid_aoi");
    await expectError({ ...BODY, aoi: { type: "Point", coordinates: [31, 30.8] } }, 422, "invalid_aoi");
    await expectError({ ...BODY, aoi: { ...AOI_400, coordinates: [AOI_400.coordinates[0].slice(0, -1)] } }, 422, "invalid_aoi");
    await expectError({ start: "2000-11", end: "2026-11", series: "raw" }, 422, "invalid_aoi");
    await expectError("{not json", 422, "invalid_aoi");
  });

  it("too_many_vertices (422)", async () => {
    const ring = Array.from({ length: 501 }, (_, i) => [
      31 + 0.2 * Math.cos((2 * Math.PI * i) / 501),
      30.8 + 0.2 * Math.sin((2 * Math.PI * i) / 501),
    ]);
    await expectError({ ...BODY, aoi: { type: "Polygon", coordinates: [[...ring, ring[0]]] } }, 422, "too_many_vertices");
  });

  it("outside_regions (422) lists the regions", async () => {
    const error = await expectError({ ...BODY, aoi: boxToPolygon(-30, 10, -29, 11) }, 422, "outside_regions");
    assert.deepEqual(error.regions, ["nile_delta", "california", "se_australia", "n_argentina"]);
    assert.match(error.message, /Nile Delta, Egypt/);
  });

  it("too_small (422) below 4 covered cells, counting excluded countries out", async () => {
    await expectError({ ...BODY, aoi: boxToPolygon(31, 30.6, 31.05, 30.65) }, 422, "too_small");
    const bolivia = await expectError({ ...BODY, aoi: boxToPolygon(-65, -22.8, -63, -22.1) }, 422, "too_small");
    assert.match(bolivia.message, /0 grid cells with data \(and \d+ in countries without data\)/);
    await calendar({ ...BODY, aoi: boxToPolygon(31, 30.6, 31.1, 30.7) });
  });

  it("bad_range (400)", async () => {
    for (const range of [
      { start: "2026-11", end: "2000-11" },
      { start: "2025-13", end: "2026-01" },
      { start: "1999-12", end: "2026-11" },
      { start: "2000-11", end: "2100-01" },
      { series: "both" },
    ]) {
      await expectError({ ...BODY, ...range }, 400, "bad_range");
    }
  });
});

describe("calendar cache", () => {
  it("answers a repeated request from the cache", async () => {
    calendarCache.clear();
    const first = await calendar(BODY);
    const second = await calendar(BODY);
    assert.deepEqual([first.cache, second.cache], ["miss", "hit"]);
    assert.deepEqual(second.body, first.body);
  });

  it("keys on covered cells, so the AOI block still follows the drawn polygon", async () => {
    const first = await calendar(BODY);
    const inner = await calendar({ ...BODY, aoi: boxToPolygon(30.501, 30.501, 31.499, 31.499) });
    assert.equal(inner.cache, "hit");
    assert.equal(inner.body.aoi.cells, 400);
    assert.ok(inner.body.aoi.area_km2 < first.body.aoi.area_km2);
    assert.deepEqual(inner.body.months, first.body.months);
    assert.equal((await calendar({ ...BODY, series: "raw" })).cache, "miss");
    assert.equal((await calendar({ ...BODY, end: "2026-10" })).cache, "miss");
  });

  it("hashes version, region, sorted cells, range and series", () => {
    const request = { start: "2000-11", end: "2026-11", series: "harmonized" };
    const key = calendarCacheKey("v3", "nile_delta", [1, 2, 3], request);
    assert.equal(calendarCacheKey("v3", "nile_delta", [3, 1, 2], request), key);
    for (const other of [
      calendarCacheKey("v4", "nile_delta", [1, 2, 3], request),
      calendarCacheKey("v3", "california", [1, 2, 3], request),
      calendarCacheKey("v3", "nile_delta", [1, 2, 4], request),
      calendarCacheKey("v3", "nile_delta", [1, 2, 3], { ...request, start: "2001-01" }),
      calendarCacheKey("v3", "nile_delta", [1, 2, 3], { ...request, end: "2026-10" }),
      calendarCacheKey("v3", "nile_delta", [1, 2, 3], { ...request, series: "raw" }),
    ]) {
      assert.notEqual(other, key);
    }
  });

  it("holds 200 entries and evicts the least recently used", () => {
    assert.equal(CACHE_SIZE, 200);
    assert.equal(calendarCache.capacity, 200);
    const lru = new LruCache(2);
    lru.set("a", 1);
    lru.set("b", 2);
    assert.equal(lru.get("a"), 1);
    lru.set("c", 3);
    assert.deepEqual([lru.get("a"), lru.get("b"), lru.get("c"), lru.size], [1, undefined, 3, 2]);
  });
});

describe("without published data", () => {
  after(() => useData(FIXTURE));

  it("falls back to the W01 mocks when there is no latest.json", async () => {
    useData(tempDir());
    const metadata = await getMetadata();
    assert.equal(metadata.headers.get("x-hotornot-data"), "mock");
    assert.equal(metadata.headers.get("cache-control"), "no-store");
    assert.deepEqual(await metadata.json(), mocks.metadata);
    const { body, response } = await calendar(BODY);
    assert.equal(response.headers.get("x-hotornot-data"), "mock");
    assert.equal(body.region_id, "nile_delta");
    await expectError({ ...BODY, aoi: boxToPolygon(-30, 10, -29, 11) }, 422, "outside_regions");
  });

  it("answers 503 data_unavailable when published data cannot be read", async (t) => {
    const errors = t.mock.method(console, "error", () => {});
    const dir = tempDir();
    writeFileSync(join(dir, "latest.json"), JSON.stringify({ version: "v9", published_at: "2026-11-13T00:00:00Z" }));
    mkdirSync(join(dir, "v9"));
    writeFileSync(join(dir, "v9", "serving.sqlite"), "not a database");
    useData(dir);
    for (const response of [await getMetadata(), await postCalendar(post(BODY))]) {
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, "data_unavailable");
    }
    assert.ok(errors.mock.callCount() >= 1);
  });
});

describe("timing on the fixture", () => {
  /** Median of five warm requests, with the response cache cleared before each. */
  async function warmMs(body) {
    await calendar(body);
    const times = [];
    for (let i = 0; i < 5; i += 1) {
      calendarCache.clear();
      const started = performance.now();
      const { cache } = await calendar(body);
      times.push(performance.now() - started);
      assert.equal(cache, "miss");
    }
    return times.sort((a, b) => a - b)[2];
  }

  it("400-cell AOI under 300 ms warm", async (t) => {
    const ms = await warmMs(BODY);
    t.diagnostic(`400 cells: ${ms.toFixed(1)} ms`);
    assert.ok(ms < 300, `${ms} ms`);
  });

  it("whole-region box under 1.5 s warm", async (t) => {
    for (const [regionId, box] of Object.entries(REGION_BOXES)) {
      const ms = await warmMs({ ...BODY, aoi: boxToPolygon(...box) });
      t.diagnostic(`${regionId} whole box: ${ms.toFixed(1)} ms`);
      assert.ok(ms < 1500, `${regionId}: ${ms} ms`);
    }
  });
});
