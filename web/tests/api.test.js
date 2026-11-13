import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { after, before, describe, it } from "node:test";
import { POST as postCalendar } from "../api/calendar.js";
import { POST as postCurrentMonth } from "../api/current-month.js";
import { POST as postHotspots } from "../api/export/hotspots.js";
import { POST as postSummary } from "../api/export/summary.js";
import { GET as getMetadata } from "../api/metadata.js";
import {
  HOTSPOT_EXPORT_COLUMNS,
  REGION_IDS,
  SUMMARY_EXPORT_COLUMNS,
  checkApiError,
  checkCalendarResponse,
  checkCurrentMonthResponse,
  checkMetadata,
} from "../public/shared/contracts.js";
import { createAppServer } from "../server.js";

const NILE_AOI = {
  type: "Polygon",
  coordinates: [[[30.8, 30.6], [31.4, 30.6], [31.4, 31.1], [30.8, 31.1], [30.8, 30.6]]],
};
const SE_AOI = {
  type: "Polygon",
  coordinates: [[[148, -37.8], [149.5, -37.8], [149.5, -36.5], [148, -36.5], [148, -37.8]]],
};
const ATLANTIC_AOI = {
  type: "Polygon",
  coordinates: [[[-30, 10], [-29, 10], [-29, 11], [-30, 11], [-30, 10]]],
};
const BODY = { aoi: NILE_AOI, start: "2000-11", end: "2026-11", series: "harmonized" };

const post = (body) =>
  new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function expectOk(response, check) {
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(check(body), []);
  return body;
}

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.deepEqual(checkApiError(body), []);
  assert.equal(body.error.code, code);
  return body.error;
}

describe("GET /api/metadata", () => {
  it("returns the metadata mock", async () => {
    const body = await expectOk(await getMetadata(), checkMetadata);
    assert.deepEqual(
      body.regions.map((region) => region.id),
      [...REGION_IDS],
    );
  });
});

describe("POST /api/calendar", () => {
  it("answers the acceptance request with the Nile Delta calendar", async () => {
    const body = await expectOk(await postCalendar(post(BODY)), checkCalendarResponse);
    assert.equal(body.region_id, "nile_delta");
    assert.equal(body.months.length, 313);
  });

  it("keeps only months inside start and end", async () => {
    const body = await expectOk(await postCalendar(post({ ...BODY, start: "2025-01", end: "2025-12" })), checkCalendarResponse);
    assert.deepEqual(
      body.months.map((m) => [m.year, m.month]),
      Array.from({ length: 12 }, (_, i) => [2025, i + 1]),
    );
  });

  it("serves raw counts in raw mode", async () => {
    const body = await expectOk(await postCalendar(post({ ...BODY, series: "raw" })), checkCalendarResponse);
    assert.ok(body.months.every((m) => m.value === null && m.modis_raw !== null));
  });

  it("picks the region the AOI overlaps", async () => {
    const body = await expectOk(await postCalendar(post({ ...BODY, aoi: SE_AOI })), checkCalendarResponse);
    assert.equal(body.region_id, "se_australia");
  });

  it("returns 422 invalid_aoi for an invalid body", async () => {
    await expectError(await postCalendar(post({ ...BODY, aoi: { type: "Point", coordinates: [31, 30.8] } })), 422, "invalid_aoi");
    const open = { ...NILE_AOI, coordinates: [NILE_AOI.coordinates[0].slice(0, -1)] };
    await expectError(await postCalendar(post({ ...BODY, aoi: open })), 422, "invalid_aoi");
    await expectError(await postCalendar(post("{not json")), 422, "invalid_aoi");
    await expectError(await postCalendar(post({ start: "2000-11", end: "2026-11", series: "raw" })), 422, "invalid_aoi");
  });

  it("returns 422 too_many_vertices above 500 vertices", async () => {
    const ring = Array.from({ length: 501 }, (_, i) => [
      31 + 0.2 * Math.cos((2 * Math.PI * i) / 501),
      30.8 + 0.2 * Math.sin((2 * Math.PI * i) / 501),
    ]);
    const aoi = { type: "Polygon", coordinates: [[...ring, ring[0]]] };
    await expectError(await postCalendar(post({ ...BODY, aoi })), 422, "too_many_vertices");
  });

  it("returns 400 bad_range when start is after end", async () => {
    await expectError(await postCalendar(post({ ...BODY, start: "2026-11", end: "2000-11" })), 400, "bad_range");
  });

  it("returns 422 outside_regions with the region list", async () => {
    const error = await expectError(await postCalendar(post({ ...BODY, aoi: ATLANTIC_AOI })), 422, "outside_regions");
    assert.deepEqual(error.regions, [...REGION_IDS]);
  });
});

describe("POST /api/current-month", () => {
  it("needs only the aoi and ignores start, end and series", async () => {
    for (const body of [{ aoi: NILE_AOI }, { aoi: NILE_AOI, start: "bad", end: "", series: 3 }]) {
      const month = await expectOk(await postCurrentMonth(post(body)), checkCurrentMonthResponse);
      assert.deepEqual([month.year, month.month, month.days_covered], [2026, 11, 13]);
    }
  });

  it("validates the aoi", async () => {
    await expectError(await postCurrentMonth(post({ aoi: { type: "Polygon", coordinates: [] } })), 422, "invalid_aoi");
  });
});

describe("POST /api/export/*", () => {
  const range = { ...BODY, start: "2025-01", end: "2026-11" };

  it("returns the summary CSV with one row per month", async () => {
    const response = await postSummary(post(range));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/csv/);
    assert.equal(
      response.headers.get("content-disposition"),
      'attachment; filename="hotornot_summary_nile_delta_2025-01_2026-11.csv"',
    );
    const lines = (await response.text()).trimEnd().split("\n");
    assert.equal(lines[0], SUMMARY_EXPORT_COLUMNS.join(","));
    assert.equal(lines.length, 1 + 23);
  });

  it("returns the hotspot CSV with the tile columns minus cell_id", async () => {
    const response = await postHotspots(post(range));
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-disposition"),
      'attachment; filename="hotornot_hotspots_nile_delta_2025-01_2026-11.csv"',
    );
    const [header, ...rows] = (await response.text()).trimEnd().split("\n");
    assert.equal(header, HOTSPOT_EXPORT_COLUMNS.join(","));
    assert.ok(!header.split(",").includes("cell_id"));
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.split(",").length === HOTSPOT_EXPORT_COLUMNS.length));
    assert.ok(rows.every((row) => /,(2025-1[0-2]|2026-11)-\d\d,/.test(row)));
  });

  it("validates the body like the calendar", async () => {
    await expectError(await postSummary(post({ ...range, aoi: null })), 422, "invalid_aoi");
    await expectError(await postHotspots(post({ ...range, start: "2026-12" })), 400, "bad_range");
  });
});

describe("server.js", () => {
  let server;
  let base;
  before(async () => {
    server = createAppServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  const rawGet = (path) =>
    new Promise((resolve, reject) => {
      httpRequest(`${base}${path}`, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
        .on("error", reject)
        .end();
    });

  it("serves the pages and static files with their content types", async () => {
    for (const [path, type] of [
      ["/", "text/html"],
      ["/method.html", "text/html"],
      ["/css/base.css", "text/css"],
      ["/shared/contracts.js", "text/javascript"],
      ["/vendor/maplibre-gl.js", "text/javascript"],
      ["/vendor/maplibre-gl.css", "text/css"],
      ["/vendor/manifest.json", "application/json"],
    ]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get("content-type"), new RegExp(`^${type}`), path);
      await response.arrayBuffer();
    }
    assert.match(await (await fetch(base)).text(), /under construction/);
  });

  it("answers HEAD with the file size and no body", async () => {
    const response = await fetch(`${base}/vendor/maplibre-gl.js`, { method: "HEAD" });
    assert.equal(response.status, 200);
    const { size } = await stat(new URL("../public/vendor/maplibre-gl.js", import.meta.url));
    assert.equal(Number(response.headers.get("content-length")), size);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  });

  it("routes /api/* to the handlers", async () => {
    await expectOk(await fetch(`${base}/api/metadata`), checkMetadata);
    const calendar = await fetch(`${base}/api/calendar`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(BODY),
    });
    assert.equal((await expectOk(calendar, checkCalendarResponse)).months.length, 313);
    const invalid = await fetch(`${base}/api/calendar`, { method: "POST", body: JSON.stringify({ ...BODY, aoi: {} }) });
    await expectError(invalid, 422, "invalid_aoi");
  });

  it("gives 404 for unknown paths and 405 for a wrong method", async () => {
    for (const path of ["/nope.html", "/api/nope", "/api/../server.js", "/.gitignore"]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 404, path);
      await response.arrayBuffer();
    }
    assert.equal(await rawGet("/%2e%2e/package.json"), 404);
    assert.equal(await rawGet("/..%2fserver.js"), 404);
    const wrong = await fetch(`${base}/api/calendar`);
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get("allow"), "POST");
    await wrong.arrayBuffer();
  });
});
