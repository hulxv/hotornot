import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { POST as postCalendar } from "../api/calendar.js";
import { POST as postCurrentMonth } from "../api/current-month.js";
import { POST as postHotspots } from "../api/export/hotspots.js";
import { POST as postSummary } from "../api/export/summary.js";
import { openServing } from "../lib/data/serving.js";
import { DataSource, resetDataSource } from "../lib/data/source.js";
import { csvStream, handleCurrentMonth, handleHotspotExport, handleSummaryExport } from "../lib/server/exports.js";
import { boxToPolygon, snap } from "../public/shared/aoi.js";
import {
  HOTSPOT_EXPORT_COLUMNS,
  REGION_IDS,
  SUMMARY_EXPORT_COLUMNS,
  checkApiError,
  checkCurrentMonthResponse,
  checkTileRow,
  yearMonthToYm,
} from "../public/shared/contracts.js";
import { cellOf } from "../public/shared/grid.js";
import { createAppServer } from "../server.js";
import { fixtureDir } from "./fixtures/fixture.js";

process.env.DATA_BASE_URL = fixtureDir();
resetDataSource();

const NILE = "nile_delta";
const NILE_AOI = boxToPolygon(30.8, 30.6, 31.4, 31.1);
const FIXTURE_BOX = boxToPolygon(30, 30, 32, 31);
const NILE_BBOX_AOI = boxToPolygon(29.5, 29.8, 32.5, 31.8);
const TRIANGLE = { type: "Polygon", coordinates: [[[30.2, 30.1], [31.9, 30.3], [31.0, 30.95], [30.2, 30.1]]] };
const BOW_TIE = { type: "Polygon", coordinates: [[[30.8, 30.6], [31.4, 31.1], [31.4, 30.6], [30.8, 31.1], [30.8, 30.6]]] };
const TWO_CELLS = boxToPolygon(30.81, 30.61, 30.86, 30.71);
const SE_AOI = boxToPolygon(148, -37.8, 149.5, -36.5);
const ATLANTIC = boxToPolygon(-30, 10, -29, 11);
const CURRENT = { year: 2026, month: 11, days: 13 };

const post = (body) =>
  new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const exportBody = (aoi, start = "2000-11", end = "2026-11", series = "harmonized") => ({ aoi, start, end, series });
const round4 = (x) => Math.round(x * 1e4) / 1e4;
const sum = (values) => values.reduce((total, x) => total + x, 0);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return round4(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.deepEqual(checkApiError(body), []);
  assert.equal(body.error.code, code);
  return body.error;
}

/** Hotspot CSV rows typed like tile rows, with `cell_id` put back from the coordinates. */
function parseHotspots(text) {
  assert.ok(text.endsWith("\n"));
  const [header, ...lines] = text.slice(0, -1).split("\n");
  assert.equal(header, HOTSPOT_EXPORT_COLUMNS.join(","));
  return lines.map((line) => {
    const f = line.split(",");
    assert.equal(f.length, HOTSPOT_EXPORT_COLUMNS.length, line);
    const row = Object.fromEntries(HOTSPOT_EXPORT_COLUMNS.map((column, i) => [column, f[i]]));
    for (const key of ["lat", "lon", "frp_mw"]) row[key] = Number(row[key]);
    row.fire_type = row.fire_type === "" ? null : Number(row.fire_type);
    row.weight = row.weight === "" ? null : Number(row.weight);
    assert.match(f[12], /^(true|false)$/);
    row.in_series = f[12] === "true";
    row.cell_id = cellOf(row.lat, row.lon);
    assert.deepEqual(checkTileRow(row), []);
    return row;
  });
}

function parseSummary(text) {
  const [header, ...lines] = text.slice(0, -1).split("\n");
  assert.equal(header, SUMMARY_EXPORT_COLUMNS.join(","));
  return lines.map((line) => {
    const f = line.split(",");
    return Object.fromEntries(
      SUMMARY_EXPORT_COLUMNS.map((column, i) => {
        if (f[i] === "") return [column, null];
        if (f[i] === "true" || f[i] === "false") return [column, f[i] === "true"];
        return [column, Number(f[i])];
      }),
    );
  });
}

function copyFixture(edit) {
  const dir = mkdtempSync(join(tmpdir(), "hotornot-w05-"));
  cpSync(fixtureDir(), dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "v3", "serving.sqlite"));
  try {
    edit(db, dir);
  } finally {
    db.close();
  }
  return dir;
}

let serving;
let allRows;
before(async () => {
  serving = await openServing();
  allRows = [];
  for await (const row of serving.tileRows({ regionId: NILE })) allRows.push(row);
});

/** What every number must equal, straight from the published tables and tiles. */
function expected(aoi, start, end, regionCells = serving.getRegionCells(NILE)) {
  const { coveredCells } = snap(aoi, regionCells, serving.getRegion(NILE).bbox);
  const covered = new Set(coveredCells);
  const rows = allRows.filter(
    (row) => covered.has(row.cell_id) && row.acq_date.slice(0, 7) >= start && row.acq_date.slice(0, 7) <= end,
  );
  const sums = serving.sumCells(NILE, coveredCells, yearMonthToYm(start), yearMonthToYm(end));
  return {
    covered,
    rows,
    points: sum(sums.map((m) => m.points)),
    harmonized: sum(sums.map((m) => m.harmonized)),
  };
}

/** The `months` of `POST /api/calendar` for the same body. */
async function calendarMonthsFor(aoi, start, end, series = "harmonized") {
  const response = await postCalendar(post(exportBody(aoi, start, end, series)));
  assert.equal(response.status, 200);
  return (await response.json()).months;
}

describe("POST /api/export/hotspots", () => {
  const cases = [
    ["the W01 box, whole record", NILE_AOI, "2000-11", "2026-11"],
    ["the W01 box, 2025-01 to 2026-11", NILE_AOI, "2025-01", "2026-11"],
    ["a triangle across both tiles", TRIANGLE, "2000-11", "2026-11"],
    ["every fixture hotspot", FIXTURE_BOX, "2000-11", "2026-11"],
    ["the whole region, one year", NILE_BBOX_AOI, "2016-01", "2016-12"],
    ["a NOAA-20 month", FIXTURE_BOX, "2026-11", "2026-11"],
  ];
  for (const [name, aoi, start, end] of cases) {
    it(`matches the calendar and the points count: ${name}`, async () => {
      const want = expected(aoi, start, end);
      const response = await postHotspots(post(exportBody(aoi, start, end)));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
      assert.equal(
        response.headers.get("content-disposition"),
        `attachment; filename="hotornot_hotspots_nile_delta_${start}_${end}.csv"`,
      );
      const rows = parseHotspots(await response.text());

      assert.ok(rows.length > 0);
      assert.equal(rows.length, want.points);
      assert.deepEqual(rows.map((r) => r.hotspot_id).sort(), want.rows.map((r) => r.hotspot_id).sort());
      assert.ok(rows.every((r) => want.covered.has(r.cell_id)));
      assert.ok(rows.every((r) => r.acq_date.slice(0, 7) >= start && r.acq_date.slice(0, 7) <= end));

      const weight = sum(rows.filter((r) => r.in_series).map((r) => r.weight));
      assert.ok(Math.abs(weight - want.harmonized) < 1e-9, `${weight} vs ${want.harmonized}`);
      const calendar = await calendarMonthsFor(aoi, start, end);
      const calendarTotal = sum(calendar.map((m) => m.value ?? 0));
      // The calendar rounds each month's value to 4 decimals.
      assert.ok(Math.abs(weight - calendarTotal) <= calendar.length * 5e-5, `${weight} vs ${calendarTotal}`);
    });
  }

  it("keeps every published field of each row", async () => {
    const response = await postHotspots(post(exportBody(FIXTURE_BOX)));
    const rows = parseHotspots(await response.text());
    assert.equal(rows.length, allRows.length);
    const byId = new Map(allRows.map((row) => [row.hotspot_id, row]));
    for (const row of rows) assert.deepEqual(row, byId.get(row.hotspot_id));
    assert.deepEqual(new Set(rows.map((r) => r.satellite)), new Set(["Terra", "Aqua", "S-NPP", "NOAA-20"]));
    assert.ok(rows.some((r) => !r.in_series && r.weight === null));
    assert.ok(rows.some((r) => !r.in_series && r.weight !== null));
  });

  it("streams the file in chunks", async () => {
    const response = await postHotspots(post(exportBody(FIXTURE_BOX)));
    const chunks = [];
    for await (const chunk of response.body) chunks.push(chunk);
    assert.ok(chunks.length >= 3, `${chunks.length} chunks`);
    assert.ok(chunks.every((chunk) => chunk instanceof Uint8Array && chunk.byteLength < 70_000));
  });

  it("ignores series", async () => {
    const harmonized = await (await postHotspots(post(exportBody(NILE_AOI, "2019-01", "2020-12")))).text();
    const raw = await (await postHotspots(post(exportBody(NILE_AOI, "2019-01", "2020-12", "raw")))).text();
    assert.equal(raw, harmonized);
  });

  it("returns only the header when nothing matches", async () => {
    const header = `${HOTSPOT_EXPORT_COLUMNS.join(",")}\n`;
    assert.equal(await (await postHotspots(post(exportBody(NILE_AOI, "2000-01", "2000-10")))).text(), header);
    const se = await postHotspots(post(exportBody(SE_AOI)));
    assert.match(se.headers.get("content-disposition"), /hotornot_hotspots_se_australia_2000-11_2026-11\.csv/);
    assert.equal(await se.text(), header);
  });

  it("returns 422 too_many_rows above the cap", async () => {
    const want = expected(FIXTURE_BOX, "2000-11", "2026-11");
    const over = await handleHotspotExport(post(exportBody(FIXTURE_BOX)), { maxRows: want.points - 1 });
    const error = await expectError(over, 422, "too_many_rows");
    assert.match(error.message, new RegExp(`${want.points.toLocaleString("en-US")} rows`));
    const at = await handleHotspotExport(post(exportBody(FIXTURE_BOX)), { maxRows: want.points });
    assert.equal(at.status, 200);
    assert.equal(parseHotspots(await at.text()).length, want.points);
  });

  describe("without tiles", () => {
    let dir;
    let source;
    before(() => {
      dir = copyFixture((_db, root) => rmSync(join(root, "v3", "points"), { recursive: true }));
      source = new DataSource({ baseUrl: dir });
    });
    after(() => {
      source.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("refuses an export over the cap before opening any tile", async () => {
      const response = await handleHotspotExport(post(exportBody(FIXTURE_BOX)), { source, maxRows: 10 });
      await expectError(response, 422, "too_many_rows");
    });

    it("answers 503 data_unavailable before the download starts when the first tile is missing", async () => {
      const response = await handleHotspotExport(post(exportBody(FIXTURE_BOX)), { source });
      assert.equal(response.headers.get("retry-after"), "60");
      await expectError(response, 503, "data_unavailable");
    });

    it("does not open tiles for an empty range", async () => {
      const response = await handleHotspotExport(post(exportBody(FIXTURE_BOX, "2000-01", "2000-10")), { source });
      assert.equal(await response.text(), `${HOTSPOT_EXPORT_COLUMNS.join(",")}\n`);
    });
  });

  describe("with uncovered cells", () => {
    let dir;
    let source;
    let uncovered;
    before(() => {
      const busiest = Map.groupBy(allRows, (row) => row.cell_id);
      uncovered = [...busiest.keys()].sort((a, b) => busiest.get(b).length - busiest.get(a).length).slice(0, 5);
      dir = copyFixture((db) => {
        const update = db.prepare("UPDATE region_cells SET covered = 0 WHERE region_id = ? AND cell_id = ?");
        for (const cell of uncovered) update.run(NILE, cell);
      });
      source = new DataSource({ baseUrl: dir });
    });
    after(() => {
      source.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("leaves them out of both exports, which still agree", async () => {
      const copy = await openServing(source);
      const want = expected(FIXTURE_BOX, "2000-11", "2026-11", copy.getRegionCells(NILE));
      assert.ok(want.rows.length < allRows.length);
      const rows = parseHotspots(await (await handleHotspotExport(post(exportBody(FIXTURE_BOX)), { source })).text());
      assert.equal(rows.length, want.rows.length);
      assert.ok(rows.every((r) => !uncovered.includes(r.cell_id)));
      const months = parseSummary(await (await handleSummaryExport(post(exportBody(FIXTURE_BOX)), { source })).text());
      const weight = sum(rows.filter((r) => r.in_series).map((r) => r.weight));
      assert.ok(Math.abs(weight - sum(months.map((m) => m.value ?? 0))) <= months.length * 5e-5);
    });
  });

  it("validates the body like the calendar", async () => {
    await expectError(await postHotspots(post("{not json")), 422, "invalid_aoi");
    await expectError(await postHotspots(post(exportBody(NILE_AOI, "1999-12", "2026-11"))), 400, "bad_range");
    await expectError(await postHotspots(post(exportBody(BOW_TIE))), 422, "invalid_aoi");
    await expectError(await postHotspots(post(exportBody(NILE_AOI, "2026-12", "2026-11"))), 400, "bad_range");
    await expectError(await postHotspots(post(exportBody(NILE_AOI, "2026-01", "2026-11", "both"))), 400, "bad_range");
    await expectError(await postHotspots(post(exportBody(TWO_CELLS))), 422, "too_small");
    const error = await expectError(await postHotspots(post(exportBody(ATLANTIC))), 422, "outside_regions");
    assert.deepEqual(error.regions, [...REGION_IDS]);
    const ring = Array.from({ length: 501 }, (_, i) => [
      31 + 0.2 * Math.cos((2 * Math.PI * i) / 501),
      30.8 + 0.2 * Math.sin((2 * Math.PI * i) / 501),
    ]);
    const many = { type: "Polygon", coordinates: [[...ring, ring[0]]] };
    await expectError(await postHotspots(post(exportBody(many))), 422, "too_many_vertices");
  });
});

describe("POST /api/export/summary", () => {
  for (const series of ["harmonized", "raw"]) {
    it(`has one row per month equal to the calendar months (${series})`, async () => {
      const response = await postSummary(post(exportBody(TRIANGLE, "2011-06", "2026-11", series)));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
      assert.equal(
        response.headers.get("content-disposition"),
        'attachment; filename="hotornot_summary_nile_delta_2011-06_2026-11.csv"',
      );
      const calendar = await calendarMonthsFor(TRIANGLE, "2011-06", "2026-11", series);
      const months = parseSummary(await response.text());
      assert.equal(months.length, 15 * 12 + 6);
      assert.deepEqual(months, calendar);
    });
  }

  it("matches the tiles month by month to the 4th decimal", async () => {
    const want = expected(FIXTURE_BOX, "2000-11", "2026-11");
    const byMonth = Map.groupBy(
      want.rows.filter((r) => r.in_series),
      (r) => r.acq_date.slice(0, 7),
    );
    const months = parseSummary(await (await postSummary(post(exportBody(FIXTURE_BOX)))).text());
    assert.equal(months.length, 313);
    for (const m of months) {
      const key = `${m.year}-${String(m.month).padStart(2, "0")}`;
      assert.equal(m.value, round4(sum((byMonth.get(key) ?? []).map((r) => r.weight))), key);
    }
  });

  it("writes nulls as empty fields and pads months outside the record", async () => {
    const text = await (await postSummary(post(exportBody(NILE_AOI, "2000-10", "2000-11")))).text();
    const [, before, first] = text.trimEnd().split("\n");
    assert.equal(before, "2000,10,,,,,,,,,false,false");
    assert.match(first, /^2000,11,[\d.]+,\d+,,[\d.]+,[-\d.]*,[-\d.]+,,,false,true$/);
  });

  it("validates the body like the calendar", async () => {
    await expectError(await postSummary(post({ ...exportBody(NILE_AOI), aoi: null })), 422, "invalid_aoi");
    await expectError(await postSummary(post(exportBody(NILE_AOI, "2026-11", "2000-11"))), 400, "bad_range");
    await expectError(await postSummary(post(exportBody(TWO_CELLS))), 422, "too_small");
    await expectError(await postSummary(post(exportBody(ATLANTIC))), 422, "outside_regions");
  });
});

describe("POST /api/current-month", () => {
  for (const [name, aoi] of [
    ["the W01 box", NILE_AOI],
    ["every fixture hotspot", FIXTURE_BOX],
    ["a triangle", TRIANGLE],
  ]) {
    it(`compares the first ${CURRENT.days} days with the same days of earlier years: ${name}`, async () => {
      const body = await (await postCurrentMonth(post({ aoi }))).json();
      assert.deepEqual(checkCurrentMonthResponse(body), []);

      const { covered } = expected(aoi, "2000-11", "2026-11");
      const totals = new Map();
      for (let year = 2000; year <= CURRENT.year; year += 1) totals.set(year, 0);
      for (const row of allRows) {
        const [year, month, day] = row.acq_date.split("-").map(Number);
        if (!row.in_series || month !== CURRENT.month || day > CURRENT.days || !covered.has(row.cell_id)) continue;
        totals.set(year, totals.get(year) + row.weight);
      }
      const value = round4(totals.get(CURRENT.year));
      const baseline = [...totals].filter(([y]) => y >= 2003 && y <= 2025).map(([, t]) => round4(t));
      const rivals = [...totals].filter(([y]) => y >= 2003).map(([, t]) => round4(t));
      const months = serving.getMonths(NILE);
      const flag = months.at(-1);
      assert.deepEqual(body, {
        year: CURRENT.year,
        month: CURRENT.month,
        days_covered: CURRENT.days,
        value,
        median: median(baseline),
        rank: 1 + rivals.filter((t) => t > value).length,
        of_years: 24,
        provisional: Boolean(flag.provisional),
        partial_coverage: Boolean(flag.terra_only) || flag.viirs_missing_days > 0,
      });

      const [calendar] = await calendarMonthsFor(aoi, "2026-11", "2026-11");
      assert.equal(body.value, calendar.value);
    });
  }

  it("needs only the aoi and ignores start, end and series", async () => {
    const plain = await (await postCurrentMonth(post({ aoi: NILE_AOI }))).json();
    const extra = await (await postCurrentMonth(post({ aoi: NILE_AOI, start: "bad", end: "", series: 3 }))).json();
    assert.deepEqual(extra, plain);
  });

  it("answers in a region without tiles", async () => {
    const body = await (await postCurrentMonth(post({ aoi: SE_AOI }))).json();
    assert.deepEqual(checkCurrentMonthResponse(body), []);
    assert.ok(body.value > 0);
  });

  it("validates the aoi", async () => {
    await expectError(await postCurrentMonth(post({ aoi: { type: "Polygon", coordinates: [] } })), 422, "invalid_aoi");
    await expectError(await postCurrentMonth(post({ aoi: BOW_TIE })), 422, "invalid_aoi");
    await expectError(await postCurrentMonth(post({ aoi: TWO_CELLS })), 422, "too_small");
    await expectError(await postCurrentMonth(post({ aoi: ATLANTIC })), 422, "outside_regions");
  });
});

describe("before anything is published", () => {
  let dir;
  let source;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "hotornot-w05-empty-"));
    source = new DataSource({ baseUrl: dir });
  });
  after(() => {
    source.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves W01's mocks, marked as mocks", async () => {
    for (const response of [
      await handleCurrentMonth(post({ aoi: NILE_AOI }), { source }),
      await handleSummaryExport(post(exportBody(NILE_AOI, "2025-01", "2026-11")), { source }),
      await handleHotspotExport(post(exportBody(NILE_AOI, "2025-01", "2026-11")), { source }),
    ]) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-hotornot-data"), "mock");
      assert.ok((await response.text()).length > 0);
    }
    await expectError(await handleHotspotExport(post(exportBody(ATLANTIC)), { source }), 422, "outside_regions");
  });
});

describe("csvStream", () => {
  const read = async (stream) => {
    let text = "";
    const decoder = new TextDecoder();
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
    return text;
  };

  it("writes sync and async rows, quoting where needed", async () => {
    const rows = [{ a: 1, b: "x,y" }, { a: null, b: 'say "hi"' }, { a: true, b: undefined }];
    const want = 'a,b\n1,"x,y"\n,"say ""hi"""\ntrue,\n';
    assert.equal(await read(await csvStream(["a", "b"], rows)), want);
    async function* lazy() {
      yield* rows;
    }
    assert.equal(await read(await csvStream(["a", "b"], lazy())), want);
    assert.equal(await read(await csvStream(["a", "b"], [])), "a,b\n");
  });

  it("stops the source when the reader cancels", async () => {
    let finished = false;
    async function* endless() {
      try {
        for (let i = 0; ; i += 1) yield { n: i };
      } finally {
        finished = true;
      }
    }
    const reader = (await csvStream(["n"], endless())).getReader();
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /^n\n0\n1\n/);
    await reader.cancel();
    assert.ok(finished);
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

  const send = (path, body) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("streams the hotspot export over HTTP", async () => {
    const response = await send("/api/export/hotspots", exportBody(FIXTURE_BOX));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("transfer-encoding"), "chunked");
    assert.equal(
      response.headers.get("content-disposition"),
      'attachment; filename="hotornot_hotspots_nile_delta_2000-11_2026-11.csv"',
    );
    assert.equal(parseHotspots(await response.text()).length, allRows.length);
  });

  it("serves the summary and the current month", async () => {
    const summary = await send("/api/export/summary", exportBody(NILE_AOI, "2025-01", "2026-11"));
    assert.equal(summary.status, 200);
    assert.equal(parseSummary(await summary.text()).length, 23);
    const current = await send("/api/current-month", { aoi: NILE_AOI });
    assert.deepEqual(checkCurrentMonthResponse(await current.json()), []);
    await expectError(await send("/api/export/hotspots", exportBody(ATLANTIC)), 422, "outside_regions");
  });
});
