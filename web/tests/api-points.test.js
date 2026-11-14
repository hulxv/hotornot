import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { POST as postCalendar } from "../api/calendar.js";
import { POST as postExport } from "../api/export/hotspots.js";
import { POST as postPoints } from "../api/points.js";
import { DataSource, resetDataSource } from "../lib/data/source.js";
import { collectPoints, handlePoints } from "../lib/server/points.js";
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
        assert.deepEqual(Object.keys(answer).sort(), ["counted", "date", "from", "frp", "night", "points", "satellite", "satellites", "time", "to", "total", "weight"]);
        assert.equal(answer.from, `${start}-01`);
        assert.equal(answer.to.slice(0, 7), end);
        assert.deepEqual(answer.satellites, SATELLITES);
        for (const key of ["date", "time", "satellite", "frp", "weight", "night"]) assert.equal(answer[key].length, answer.total, key);
        const expected = await expectedPoints(body(aoi, start, end));
        assert.equal(answer.total, expected.length);
        assert.deepEqual(sorted(rowsOf(answer)), sorted(expected));
        const calendar = await (await postCalendar(post(body(aoi, start, end)))).json();
        const calendarTotal = calendar.months.reduce((sum, month) => sum + (month.value ?? 0), 0);
        assert.ok(Math.abs(answer.counted - calendarTotal) <= 0.05 + 1e-4 * calendar.months.length, `${start}..${end}: dots add up to ${answer.counted}, the calendar to ${calendarTotal}`);
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
    assert.equal(capped.counted, full.counted);
    const kept = capped.date.length;
    assert.ok(kept > 0 && kept <= 20, `kept ${kept}`);
    assert.equal(capped.points.length, kept * 2);
    for (const key of ["time", "satellite", "frp", "weight", "night"]) assert.equal(capped[key].length, kept, key);
    const all = new Set(rowsOf(full).map((row) => row.join(",")));
    for (const row of rowsOf(capped)) assert.ok(all.has(row.join(",")), "a thinned point keeps its own details");
    source.close();
  });

  it("takes any date range and keeps only the hotspots dated inside it", async () => {
    const all = await (await postPoints(post(body(NILE_BBOX_AOI, "2000-11", "2026-11")))).json();
    assert.equal(all.date.length, all.total, "the fixture is small enough not to be thinned");
    const days = [...new Set(all.date)].sort((a, b) => a - b);
    assert.ok(days.length > 4, `the fixture has ${days.length} fire days`);
    const [first, last] = [days[Math.floor(days.length / 4)], days[Math.floor((3 * days.length) / 4)]];
    const iso = (yyyymmdd) => `${String(yyyymmdd).slice(0, 4)}-${String(yyyymmdd).slice(4, 6)}-${String(yyyymmdd).slice(6)}`;
    const [from, to] = [iso(first), iso(last)];
    const range = await (await postPoints(post({ aoi: NILE_BBOX_AOI, from, to }))).json();
    assert.deepEqual([range.from, range.to], [from, to]);
    const inside = rowsOf(all).filter((row) => row[2] >= first && row[2] <= last);
    assert.ok(inside.length > 0 && inside.length < all.total);
    assert.equal(range.total, inside.length);
    assert.deepEqual(sorted(rowsOf(range)), sorted(inside));
  });

  it("refuses an impossible or reversed date range", async () => {
    for (const [from, to] of [["2021-02-29", "2021-03-01"], ["2020-03-01", "2020-02-01"], ["2020-1-1", "2020-02-01"]]) {
      const response = await postPoints(post({ aoi: NILE_AOI, from, to }));
      assert.equal(response.status, 400, `${from}..${to}`);
      assert.equal((await response.json()).error.code, "bad_range");
    }
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

describe("collectPoints", () => {
  const row = (date, inSeries, weight, minute = 5) => ({
    in_series: inSeries,
    acq_date: date,
    acq_utc: `${date}T10:${String(minute).padStart(2, "0")}Z`,
    lon: 31,
    lat: 30,
    satellite: "NOAA-20",
    frp_mw: 1.25,
    weight,
    daynight: "D",
  });

  it("counts every hotspot in the range and skips other dates and the ones out of the series", async () => {
    const rows = [row("2026-10-31", true, 1), ...Array.from({ length: 10 }, () => row("2026-11-01", true, 0.5)), row("2026-11-02", false, 1), row("2026-11-14", true, 1)];
    const set = await collectPoints(rows, "2026-11-01", "2026-11-13", 100);
    assert.equal(set.total, 10);
    assert.equal(set.counted, 5);
    assert.equal(set.columns.date.length, 10, "everything fits, so everything is kept");
    assert.deepEqual([set.columns.time[0], set.columns.frp[0], set.columns.satellite[0], set.columns.night[0]], [1005, 1.3, 3, 0]);
  });

  it("thins to an even spread between half the cap and the cap", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => row("2026-11-01", true, 1, i % 60));
    for (const max of [10, 33, 99, 100]) {
      const set = await collectPoints(rows, "2026-11-01", "2026-11-01", max);
      const kept = set.columns.date.length;
      assert.equal(set.total, 100);
      assert.ok(kept <= max && kept > max / 2, `max ${max}: kept ${kept}`);
      for (const key of ["time", "satellite", "frp", "weight", "night"]) assert.equal(set.columns[key].length, kept, key);
      assert.equal(set.columns.points.length, 2 * kept);
    }
    const tenth = await collectPoints(rows, "2026-11-01", "2026-11-01", 10);
    assert.deepEqual(tenth.columns.time, [1000, 1016, 1032, 1048, 1004, 1020, 1036]);
  });
});
