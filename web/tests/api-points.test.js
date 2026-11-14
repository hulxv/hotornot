import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { POST as postExport } from "../api/export/hotspots.js";
import { POST as postPoints } from "../api/points.js";
import { DataSource, resetDataSource } from "../lib/data/source.js";
import { handlePoints, thinIndices, thinPoints } from "../lib/server/points.js";
import { boxToPolygon } from "../public/shared/aoi.js";
import { HOTSPOT_EXPORT_COLUMNS, SATELLITES, checkApiError } from "../public/shared/contracts.js";
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

/** The export's in-series hotspots for the same body, described the way /api/points describes them. */
async function expectedPoints(request) {
  const text = await (await postExport(post(request))).text();
  const [, ...lines] = text.trimEnd().split("\n");
  const at = (name) => HOTSPOT_EXPORT_COLUMNS.indexOf(name);
  return lines
    .map((line) => line.split(","))
    .filter((f) => f[at("in_series")] === "true")
    .map((f) => {
      const utc = f[at("acq_utc")];
      return [
        round4(Number(f[at("lon")])),
        round4(Number(f[at("lat")])),
        Number(utc.slice(0, 10).replaceAll("-", "")),
        Number(utc.slice(11, 13) + utc.slice(14, 16)),
        SATELLITES.indexOf(f[at("satellite")]),
        Math.round(Number(f[at("frp_mw")]) * 10) / 10,
        f[at("weight")] === "" ? null : round4(Number(f[at("weight")])),
        f[at("daynight")] === "N" ? 1 : 0,
      ];
    });
}

/** One row per point from the response's columns, in the order expectedPoints builds. */
const rowsOf = (answer) =>
  answer.date.map((date, i) => [
    answer.points[2 * i],
    answer.points[2 * i + 1],
    date,
    answer.time[i],
    answer.satellite[i],
    answer.frp[i],
    answer.weight[i],
    answer.night[i],
  ]);

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
        assert.deepEqual(Object.keys(answer).sort(), ["date", "frp", "month_end", "month_start", "night", "points", "satellite", "satellites", "time", "total", "weight"]);
        assert.deepEqual([answer.month_start, answer.month_end], [start, end]);
        assert.deepEqual(answer.satellites, SATELLITES);
        for (const key of ["date", "time", "satellite", "frp", "weight", "night"]) assert.equal(answer[key].length, answer.total, key);
        const expected = await expectedPoints(body(aoi, start, end));
        assert.equal(answer.total, expected.length);
        assert.deepEqual(sorted(rowsOf(answer)), sorted(expected));
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
    for (const key of ["date", "time", "satellite", "frp", "weight", "night"]) assert.equal(capped[key].length, 20, key);
    const all = new Set(rowsOf(full).map((row) => row.join(",")));
    for (const row of rowsOf(capped)) assert.ok(all.has(row.join(",")), "a thinned point keeps its own details");
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
    assert.equal(answer.date.length, answer.total);
    source.close();
  });
});

describe("thinIndices and thinPoints", () => {
  it("keeps everything under the cap and evenly spaced points over it, with their details", () => {
    assert.deepEqual(thinIndices(4, 10), [0, 1, 2, 3]);
    assert.deepEqual(thinIndices(10, 5), [0, 2, 4, 6, 8]);
    assert.deepEqual(thinIndices(10, 3), [0, 3, 6]);
    const columns = { points: [0, 0, 1, 1, 2, 2, 3, 3], date: [1, 2, 3, 4], time: [5, 6, 7, 8], satellite: [0, 1, 2, 3], frp: [1, 2, 3, 4], weight: [0.1, null, 0.3, 0.4], night: [0, 1, 0, 1] };
    assert.equal(thinPoints(columns, 4), columns);
    assert.deepEqual(thinPoints(columns, 2), { points: [0, 0, 2, 2], date: [1, 3], time: [5, 7], satellite: [0, 2], frp: [1, 3], weight: [0.1, 0.3], night: [0, 0] });
  });
});
