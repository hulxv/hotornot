import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { POST as postExport } from "../api/export/hotspots.js";
import { POST as postPoints } from "../api/points.js";
import { DataSource, resetDataSource } from "../lib/data/source.js";
import { handlePoints, thinPoints } from "../lib/server/points.js";
import { boxToPolygon } from "../public/shared/aoi.js";
import { HOTSPOT_EXPORT_COLUMNS, checkApiError } from "../public/shared/contracts.js";
import { fixtureDir } from "./fixtures/fixture.js";

process.env.DATA_BASE_URL = fixtureDir();
resetDataSource();

const NILE_BBOX_AOI = boxToPolygon(29.5, 29.8, 32.5, 31.8);
const NILE_AOI = boxToPolygon(30.8, 30.6, 31.4, 31.1);
const ATLANTIC = boxToPolygon(-30, 10, -29, 11);
const round4 = (x) => Math.round(x * 1e4) / 1e4;
const post = (body) =>
  new Request("http://localhost/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const body = (aoi, start, end = start) => ({ aoi, start, end, series: "harmonized" });

/** The export's in-series hotspots for the same body, as [lon, lat] pairs. */
async function expectedPairs(request) {
  const text = await (await postExport(post(request))).text();
  const [, ...lines] = text.trimEnd().split("\n");
  const at = (name) => HOTSPOT_EXPORT_COLUMNS.indexOf(name);
  return lines
    .map((line) => line.split(","))
    .filter((f) => f[at("in_series")] === "true")
    .map((f) => [round4(Number(f[at("lon")])), round4(Number(f[at("lat")]))]);
}

const pairs = (flat) => Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i], flat[2 * i + 1]]);
const sorted = (list) => list.map((p) => p.join(",")).sort();

describe("POST /api/points", () => {
  it("returns every in-series hotspot of the months, the same ones the export counts", async () => {
    let checked = 0;
    for (const [start, end] of [["2025-10", "2025-10"], ["2026-11", "2026-11"], ["2024-01", "2024-12"]]) {
      for (const aoi of [NILE_BBOX_AOI, NILE_AOI]) {
        const response = await postPoints(post(body(aoi, start, end)));
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("x-hotornot-data"), null);
        const answer = await response.json();
        assert.deepEqual(Object.keys(answer).sort(), ["month_end", "month_start", "points", "total"]);
        assert.deepEqual([answer.month_start, answer.month_end], [start, end]);
        const expected = await expectedPairs(body(aoi, start, end));
        assert.equal(answer.total, expected.length);
        assert.deepEqual(sorted(pairs(answer.points)), sorted(expected));
        checked += expected.length;
      }
    }
    assert.ok(checked > 0, "the fixture has in-series hotspots in these months");
  });

  it("thins to the cap with every k-th point and still reports the full total", async () => {
    const request = body(NILE_BBOX_AOI, "2000-11", "2026-11");
    const full = await (await postPoints(post(request))).json();
    assert.ok(full.total > 40, `fixture total ${full.total}`);
    const source = new DataSource({ baseUrl: fixtureDir() });
    const capped = await (await handlePoints(post(request), { source, maxPoints: 20 })).json();
    assert.equal(capped.total, full.total);
    assert.equal(capped.points.length, 40);
    const all = new Set(pairs(full.points).map((p) => p.join(",")));
    for (const p of pairs(capped.points)) assert.ok(all.has(p.join(",")));
    source.close();
  });

  it("refuses an area outside every region like the calendar does", async () => {
    const response = await postPoints(post(body(ATLANTIC, "2026-11")));
    assert.equal(response.status, 422);
    const answer = await response.json();
    assert.deepEqual(checkApiError(answer), []);
    assert.equal(answer.error.code, "outside_regions");
  });

  it("serves the mock hotspots when nothing is published", async () => {
    const source = new DataSource({ baseUrl: mkdtempSync(join(tmpdir(), "hotornot-no-data-")) });
    const response = await handlePoints(post(body(NILE_AOI, "2000-11", "2026-11")), { source });
    assert.equal(response.headers.get("x-hotornot-data"), "mock");
    const answer = await response.json();
    assert.equal(answer.points.length, answer.total * 2);
    source.close();
  });
});

describe("thinPoints", () => {
  it("keeps everything under the cap and evenly spaced points over it", () => {
    const flat = Array.from({ length: 20 }, (_, i) => i);
    assert.equal(thinPoints(flat, 10), flat);
    assert.deepEqual(thinPoints(flat, 5), [0, 1, 4, 5, 8, 9, 12, 13, 16, 17]);
    assert.deepEqual(thinPoints(flat, 3), [0, 1, 6, 7, 12, 13]);
  });
});
