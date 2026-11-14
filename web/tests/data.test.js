import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { DataError, DataSource, LATEST_TTL_MS, getDataSource, resetDataSource } from "../lib/data/source.js";
import { openServing } from "../lib/data/serving.js";
import { readTileRows } from "../lib/data/tiles.js";
import { boxToPolygon, snap } from "../public/shared/aoi.js";
import {
  REGION_IDS,
  TILE_COLUMNS,
  checkLatest,
  checkMeta,
  checkRegionCells,
  checkTileRow,
} from "../public/shared/contracts.js";
import { cellsInBbox, tileOf } from "../public/shared/grid.js";
import { CURRENT_MONTH, FIXTURE_TILES, FIXTURE_VERSION } from "../scripts/make-fixture.js";
import { fixtureDir } from "./fixtures/fixture.js";

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = fixtureDir();
const temps = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "hotornot-data-test-"));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const ymOf = (date) => Number(date.slice(0, 4) + date.slice(5, 7));
const isDataError = (code) => (error) => error instanceof DataError && error.code === code;
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);

/** An independent reading of a fixture tile, to check the reader against. */
function parseTileFile(path) {
  const [header, ...lines] = gunzipSync(readFileSync(path)).toString("utf8").trimEnd().split("\n");
  assert.equal(header, TILE_COLUMNS.join(","));
  return lines.map((line) => {
    const f = Object.fromEntries(line.split(",").map((value, i) => [TILE_COLUMNS[i], value]));
    return {
      ...f,
      lat: Number(f.lat),
      lon: Number(f.lon),
      frp_mw: Number(f.frp_mw),
      fire_type: f.fire_type === "" ? null : Number(f.fire_type),
      in_series: f.in_series === "true",
      weight: f.weight === "" ? null : Number(f.weight),
      cell_id: Number(f.cell_id),
    };
  });
}

const tileRowsOnDisk = Object.fromEntries(
  FIXTURE_TILES.map((tile) => [tile, parseTileFile(join(FIXTURE, FIXTURE_VERSION, "points", "nile_delta", `${tile}.csv.gz`))]),
);
const nileRows = FIXTURE_TILES.flatMap((tile) => tileRowsOnDisk[tile]);

function expectedSums(rows, cellIds, ymStart = 0, ymEnd = 999999) {
  const cells = new Set(cellIds);
  const months = new Map();
  for (const row of rows) {
    const ym = ymOf(row.acq_date);
    if (!cells.has(row.cell_id) || ym < ymStart || ym > ymEnd) continue;
    const m = months.get(ym) ?? { ym, harmonized: 0, modis_raw: 0, viirs_raw: 0, points: 0 };
    months.set(ym, m);
    m.points += 1;
    if (row.sensor === "MODIS" && row.weight !== null) m.modis_raw += 1;
    if (row.in_series) {
      m.harmonized += row.weight;
      if (row.sensor === "VIIRS_375") m.viirs_raw += 1;
    }
  }
  return [...months.values()].sort((a, b) => a.ym - b.ym);
}

function assertSums(actual, expected) {
  assert.deepEqual(
    actual.map(({ harmonized, ...rest }) => rest),
    expected.map(({ harmonized, ...rest }) => rest),
  );
  actual.forEach((m, i) => near(m.harmonized, expected[i].harmonized, `harmonized ${m.ym}`));
}

async function collect(iterable) {
  const rows = [];
  for await (const row of iterable) rows.push(row);
  return rows;
}

/** A static server over `root`, counting requests per path; `routes` override single paths. */
async function serve(root) {
  const hits = new Map();
  const routes = new Map();
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (routes.has(path)) return routes.get(path)(request, response);
    try {
      const body = await readFile(join(root, path));
      response.writeHead(200, { "content-length": body.length });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    hits,
    routes,
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

describe("fixture (scripts/make-fixture.js)", () => {
  const db = new DatabaseSync(join(FIXTURE, FIXTURE_VERSION, "serving.sqlite"), { readOnly: true });
  after(() => db.close());

  it("has the published tables, columns and keys", () => {
    const tables = {
      meta: [["key", "value"], ["key"]],
      regions: [["region_id", "name", "bbox", "sp_until", "nrt_until", "tiles"], ["region_id"]],
      region_cells: [["region_id", "cell_id", "covered"], ["region_id", "cell_id"], true],
      cells: [
        ["region_id", "cell_id", "ym", "harmonized", "modis_raw", "viirs_raw", "points"],
        ["region_id", "cell_id", "ym"],
        true,
      ],
      months: [
        ["region_id", "ym", "terra_only", "viirs_source", "viirs_missing_days", "provisional", "days_covered"],
        ["region_id", "ym"],
      ],
      cell_days: [["region_id", "cell_id", "year", "day", "harmonized"], ["region_id", "cell_id", "year", "day"], true],
    };
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    assert.deepEqual(names.map((t) => t.name), Object.keys(tables).sort());
    for (const [table, [columns, pk, withoutRowid = false]] of Object.entries(tables)) {
      const info = db.prepare(`PRAGMA table_info(${table})`).all();
      assert.deepEqual(info.map((c) => c.name), columns, table);
      assert.deepEqual(info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name), pk, table);
      const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table);
      assert.equal(/WITHOUT ROWID/i.test(sql), withoutRowid, table);
    }
  });

  it("has latest.json and meta values that pass the contracts.js checks", () => {
    const latest = JSON.parse(readFileSync(join(FIXTURE, "latest.json"), "utf8"));
    assert.deepEqual(checkLatest(latest), []);
    assert.equal(latest.version, FIXTURE_VERSION);
    const keys = [];
    for (const { key, value } of db.prepare("SELECT key, value FROM meta").all()) {
      keys.push(key);
      assert.deepEqual(checkMeta(key, JSON.parse(value)), [], key);
    }
    assert.deepEqual(keys.sort(), [
      "attribution",
      "current_month",
      "detection_curve",
      "k_table",
      "metadata",
      "validation:nile_delta",
      "validation_summary",
    ]);
    const metadata = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'metadata'").get().value);
    assert.equal(metadata.data_version, latest.version);
  });

  it("lists every cell centered in each bbox, uncovered only in n_argentina", () => {
    for (const { region_id, bbox } of db.prepare("SELECT region_id, bbox FROM regions").all()) {
      const rows = db.prepare("SELECT cell_id, covered FROM region_cells WHERE region_id = ? ORDER BY cell_id").all(region_id);
      assert.deepEqual(rows.map((r) => r.cell_id), cellsInBbox(JSON.parse(bbox)), region_id);
      const uncovered = rows.filter((r) => r.covered === 0).length;
      assert.ok(region_id === "n_argentina" ? uncovered > 0 : uncovered === 0, region_id);
    }
  });

  it("has tiles in the published form: header, row shapes, order, tile names", () => {
    for (const [tile, rows] of Object.entries(tileRowsOnDisk)) {
      assert.ok(rows.length > 1000, tile);
      rows.forEach((row, i) => {
        assert.deepEqual(checkTileRow(row), [], `${tile} row ${i}`);
        assert.equal(tileOf(row.cell_id), tile);
        if (i > 0) {
          const prev = rows[i - 1];
          assert.ok(prev.cell_id < row.cell_id || (prev.cell_id === row.cell_id && prev.acq_utc <= row.acq_utc));
        }
      });
    }
    const roles = new Set(nileRows.map((r) => `${r.satellite}:${r.in_series}:${r.weight === null}`));
    for (const role of ["Terra:true:false", "Aqua:false:false", "S-NPP:true:false", "NOAA-20:true:false", "NOAA-20:false:false", "S-NPP:false:true"]) {
      assert.ok(roles.has(role), role);
    }
  });

  it("aggregates nile_delta cells and cell_days from its tile rows", () => {
    const cells = db.prepare("SELECT * FROM cells WHERE region_id = 'nile_delta' ORDER BY cell_id, ym").all();
    const byCell = new Map();
    for (const row of nileRows) byCell.set(row.cell_id, [...(byCell.get(row.cell_id) ?? []), row]);
    let total = 0;
    for (const [cellId, rows] of byCell) {
      const expected = expectedSums(rows, [cellId]);
      const actual = cells.filter((c) => c.cell_id === cellId).map(({ region_id, cell_id, ...m }) => m);
      assertSums(actual, expected);
      total += actual.length;
    }
    assert.equal(total, cells.length);
    const days = db.prepare("SELECT cell_id, year, day, harmonized FROM cell_days WHERE region_id = 'nile_delta'").all();
    const expectedDays = new Map();
    for (const row of nileRows) {
      if (!row.in_series || Number(row.acq_date.slice(5, 7)) !== CURRENT_MONTH.month) continue;
      const key = `${row.cell_id}:${row.acq_date.slice(0, 4)}:${Number(row.acq_date.slice(8))}`;
      expectedDays.set(key, (expectedDays.get(key) ?? 0) + row.weight);
    }
    assert.equal(days.length, expectedDays.size);
    for (const d of days) near(d.harmonized, expectedDays.get(`${d.cell_id}:${d.year}:${d.day}`), "cell_days");
  });

  it("keeps cell_days equal to the current calendar month of cells, in every region", () => {
    const pairs = db
      .prepare(
        `SELECT c.region_id, c.cell_id, c.ym, c.harmonized, (SELECT TOTAL(d.harmonized) FROM cell_days d
           WHERE d.region_id = c.region_id AND d.cell_id = c.cell_id AND d.year = c.ym / 100) AS days
         FROM cells c WHERE c.ym % 100 = ?`,
      )
      .all(CURRENT_MONTH.month);
    assert.ok(pairs.length > 1000);
    for (const p of pairs) near(p.days, p.harmonized, `${p.region_id} ${p.cell_id} ${p.ym}`);
    const late = db.prepare("SELECT count(*) AS n FROM cell_days WHERE year = ? AND day > ?").get(CURRENT_MONTH.year, CURRENT_MONTH.days_covered);
    assert.equal(late.n, 0);
  });

  it("has one months row per region from 2000-11 to 2026-11", () => {
    for (const region of REGION_IDS) {
      const months = db.prepare("SELECT * FROM months WHERE region_id = ? ORDER BY ym").all(region);
      assert.equal(months.length, 313);
      assert.equal(months[0].ym, 200011);
      assert.equal(months.at(-1).ym, 202611);
      assert.equal(months.at(-1).days_covered, CURRENT_MONTH.days_covered);
    }
  });
});

describe("DataSource with a directory", () => {
  it("resolves relative paths from web/ and reads DATA_BASE_URL", () => {
    const saved = process.env.DATA_BASE_URL;
    try {
      delete process.env.DATA_BASE_URL;
      assert.equal(new DataSource().base, join(WEB_DIR, "public", "data"));
      process.env.DATA_BASE_URL = "./tests/fixtures/data";
      assert.equal(new DataSource().base, join(WEB_DIR, "tests", "fixtures", "data"));
      resetDataSource();
      assert.equal(getDataSource().base, join(WEB_DIR, "tests", "fixtures", "data"));
      assert.equal(getDataSource(), getDataSource());
    } finally {
      if (saved === undefined) delete process.env.DATA_BASE_URL;
      else process.env.DATA_BASE_URL = saved;
      resetDataSource();
    }
  });

  it("opens the version in latest.json once, read-only, even for concurrent first calls", async () => {
    const source = new DataSource({ baseUrl: FIXTURE });
    const [a, b] = await Promise.all([source.open(), source.open()]);
    assert.equal(a, b);
    assert.equal(await source.open(), a);
    assert.equal(a.version, FIXTURE_VERSION);
    assert.equal(a.remote, false);
    assert.equal(a.locate("points/nile_delta/n30e030.csv.gz"), join(FIXTURE, FIXTURE_VERSION, "points", "nile_delta", "n30e030.csv.gz"));
    assert.throws(() => a.db.exec("DELETE FROM meta"), /readonly/);
    source.close();
  });

  it("reports a missing latest.json, and does not remember the failure", async () => {
    const dir = tempDir();
    const source = new DataSource({ baseUrl: dir });
    await assert.rejects(source.open(), isDataError("missing_latest"));
    cpSync(FIXTURE, dir, { recursive: true });
    assert.equal((await source.open()).version, FIXTURE_VERSION);
    source.close();
  });

  it("rejects a malformed latest.json and a missing database", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "latest.json"), '{"version": "3"}');
    await assert.rejects(new DataSource({ baseUrl: dir }).open(), isDataError("bad_latest"));
    writeFileSync(join(dir, "latest.json"), "not json");
    await assert.rejects(new DataSource({ baseUrl: dir }).open(), isDataError("bad_latest"));
    writeFileSync(join(dir, "latest.json"), JSON.stringify({ version: "v9", published_at: "2026-11-13T00:00:00Z" }));
    await assert.rejects(new DataSource({ baseUrl: dir }).open(), isDataError("bad_database"));
  });

  it("re-reads latest.json after the TTL and closes all but the two newest versions", async () => {
    const dir = tempDir();
    cpSync(FIXTURE, dir, { recursive: true });
    for (const v of ["v4", "v5"]) cpSync(join(dir, FIXTURE_VERSION), join(dir, v), { recursive: true });
    const point = (version) => writeFileSync(join(dir, "latest.json"), JSON.stringify({ version, published_at: "2026-11-13T00:00:00Z" }));
    let clock = 0;
    const source = new DataSource({ baseUrl: dir, now: () => clock });
    const v3 = await source.open();
    point("v4");
    clock += LATEST_TTL_MS - 1;
    assert.equal(await source.open(), v3);
    clock += 1;
    const v4 = await source.open();
    assert.equal(v4.version, "v4");
    point("v5");
    clock += LATEST_TTL_MS;
    assert.equal((await source.open()).version, "v5");
    await new Promise((resolve) => setImmediate(resolve));
    assert.throws(() => v3.db.prepare("SELECT 1"), /not open/);
    assert.equal(v4.db.prepare("SELECT count(*) AS n FROM regions").get().n, 4);
    source.close();
  });
});

describe("DataSource with a URL", () => {
  let server;
  before(async () => {
    server = await serve(FIXTURE);
  });
  after(() => server.close());

  it("downloads serving.sqlite once for two concurrent first opens", async () => {
    const cacheDir = tempDir();
    server.hits.clear();
    const source = new DataSource({ baseUrl: `${server.url}/`, cacheDir });
    const [a, b] = await Promise.all([source.open(), source.open()]);
    assert.equal(a, b);
    assert.equal(a.remote, true);
    assert.equal(a.locate("points/nile_delta/n30e030.csv.gz"), `${server.url}/${FIXTURE_VERSION}/points/nile_delta/n30e030.csv.gz`);
    assert.equal(server.hits.get("/latest.json"), 1);
    assert.equal(server.hits.get(`/${FIXTURE_VERSION}/serving.sqlite`), 1);
    assert.equal(a.db.prepare("SELECT count(*) AS n FROM regions").get().n, 4);
    assert.equal(await source.open(), a);
    assert.equal(server.hits.get("/latest.json"), 1);
    source.close();

    const again = new DataSource({ baseUrl: server.url, cacheDir });
    await again.open();
    assert.equal(server.hits.get(`/${FIXTURE_VERSION}/serving.sqlite`), 1, "an earlier download is reused");
    again.close();
  });

  it("reports a missing latest.json", async () => {
    const empty = await serve(tempDir());
    try {
      await assert.rejects(new DataSource({ baseUrl: empty.url, cacheDir: tempDir() }).open(), isDataError("missing_latest"));
    } finally {
      await empty.close();
    }
  });

  it("keeps the last version when a refresh fails", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    let clock = 0;
    const source = new DataSource({ baseUrl: server.url, cacheDir: tempDir(), now: () => clock });
    const first = await source.open();
    server.routes.set("/latest.json", (_, response) => {
      response.writeHead(500);
      response.end();
    });
    try {
      clock += LATEST_TTL_MS;
      assert.equal(await source.open(), first);
      assert.equal(warn.mock.callCount(), 1);
    } finally {
      server.routes.delete("/latest.json");
      source.close();
    }
  });

  it("leaves nothing behind after a bad or cut-off download, then retries", async () => {
    const cacheDir = tempDir();
    const path = `/${FIXTURE_VERSION}/serving.sqlite`;
    const source = new DataSource({ baseUrl: server.url, cacheDir });
    try {
      server.routes.set(path, (_, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<html>an error page</html>");
      });
      await assert.rejects(source.open(), isDataError("bad_database"));
      server.routes.set(path, (_, response) => {
        response.writeHead(200, { "content-length": 100000 });
        response.write(Buffer.alloc(1000));
        setImmediate(() => response.socket.destroy());
      });
      await assert.rejects(source.open(), isDataError("fetch_failed"));
      assert.deepEqual(readdirSync(cacheDir, { recursive: true }).filter((f) => f.endsWith("sqlite") || f.endsWith(".part")), []);
      server.routes.delete(path);
      assert.equal((await source.open()).version, FIXTURE_VERSION);
    } finally {
      server.routes.delete(path);
      source.close();
    }
  });
});

describe("Serving", () => {
  let source;
  let serving;
  before(async () => {
    source = new DataSource({ baseUrl: FIXTURE });
    serving = await openServing(source);
  });
  after(() => source.close());

  it("is one instance per version", async () => {
    assert.equal(await openServing(source), serving);
    assert.equal(serving.version, FIXTURE_VERSION);
  });

  it("getMeta parses each key and gives undefined for an absent one", () => {
    for (const key of ["metadata", "current_month", "validation_summary", "validation:nile_delta", "detection_curve", "k_table", "attribution"]) {
      assert.deepEqual(checkMeta(key, serving.getMeta(key)), [], key);
    }
    assert.deepEqual(serving.getMeta("current_month"), CURRENT_MONTH);
    assert.equal(serving.getMeta("validation:california"), undefined);
  });

  it("getRegions matches the metadata regions", () => {
    const regions = serving.getRegions();
    assert.deepEqual(regions.map((r) => r.region_id), [...REGION_IDS].sort());
    for (const meta of serving.getMeta("metadata").regions) {
      const region = serving.getRegion(meta.id);
      assert.deepEqual(region.bbox, meta.bbox);
      assert.equal(region.name, meta.name);
      assert.equal(region.sp_until, meta.coverage.sp_until);
      assert.equal(region.nrt_until, meta.coverage.nrt_until);
    }
    assert.deepEqual(serving.getRegion("nile_delta").tiles, [...FIXTURE_TILES]);
    assert.ok(Object.isFrozen(regions) && Object.isFrozen(regions[0]));
  });

  it("getRegionCells returns {cell_id, covered} rows, cached", () => {
    const cells = serving.getRegionCells("n_argentina");
    assert.equal(cells.length, 46800);
    assert.deepEqual(checkRegionCells({ region_id: "n_argentina", cells }), []);
    assert.deepEqual(Object.keys(cells[0]), ["cell_id", "covered"]);
    assert.equal(serving.getRegionCells("n_argentina"), cells);
    assert.ok(Object.isFrozen(cells));
  });

  it("throws unknown_region for a region that is not published", () => {
    const unknown = isDataError("unknown_region");
    assert.throws(() => serving.getRegion("atlantis"), unknown);
    assert.throws(() => serving.getRegionCells("atlantis"), unknown);
    assert.throws(() => serving.sumCells("atlantis", [1]), unknown);
    assert.throws(() => serving.getMonths("atlantis"), unknown);
    assert.throws(() => serving.sumCellDays("atlantis", [1]), unknown);
    assert.throws(() => serving.tileRows({ regionId: "atlantis" }), unknown);
  });

  it("sumCells matches the tile rows for a snapped AOI and a ym range", () => {
    const { coveredCells } = snap(boxToPolygon(30.8, 30.6, 31.4, 31.1), serving.getRegionCells("nile_delta"), serving.getRegion("nile_delta").bbox);
    assert.ok(coveredCells.length > 100);
    const all = serving.sumCells("nile_delta", coveredCells, 200011, 202611);
    assertSums(all, expectedSums(nileRows, coveredCells));
    assert.deepEqual(Object.keys(all[0]), ["ym", "harmonized", "modis_raw", "viirs_raw", "points"]);
    assertSums(serving.sumCells("nile_delta", coveredCells, 201110, 201203), expectedSums(nileRows, coveredCells, 201110, 201203));
  });

  it("sumCells counts duplicate ids once, takes any iterable, and is empty without cells", () => {
    const cells = [...new Set(nileRows.map((r) => r.cell_id))].slice(0, 20);
    const expected = serving.sumCells("nile_delta", cells);
    assert.deepEqual(serving.sumCells("nile_delta", [...cells, ...cells]), expected);
    assert.deepEqual(serving.sumCells("nile_delta", new Set(cells)), expected);
    assert.deepEqual(serving.sumCells("nile_delta", Int32Array.from(cells)), expected);
    assert.deepEqual(serving.sumCells("nile_delta", []), []);
    assert.deepEqual(serving.sumCells("nile_delta", cells, 203001, 203012), []);
  });

  it("getMonths returns the months table rows", () => {
    const months = serving.getMonths("nile_delta");
    assert.equal(months.length, 313);
    assert.deepEqual(months[0], {
      region_id: "nile_delta",
      ym: 200011,
      terra_only: 1,
      viirs_source: null,
      viirs_missing_days: 0,
      provisional: 0,
      days_covered: 30,
    });
    assert.equal(months.find((m) => m.ym === 201201).viirs_missing_days, 19);
    assert.deepEqual(months.at(-1), {
      region_id: "nile_delta",
      ym: 202611,
      terra_only: 0,
      viirs_source: "SNPP+N20",
      viirs_missing_days: 0,
      provisional: 1,
      days_covered: 13,
    });
  });

  it("sumCellDays sums cell_days per year and day", () => {
    const cells = serving.getRegionCells("nile_delta").map((c) => c.cell_id);
    const days = serving.sumCellDays("nile_delta", cells);
    const expected = new Map();
    for (const row of nileRows) {
      if (!row.in_series || Number(row.acq_date.slice(5, 7)) !== CURRENT_MONTH.month) continue;
      const key = `${row.acq_date.slice(0, 4)}-${Number(row.acq_date.slice(8))}`;
      expected.set(key, (expected.get(key) ?? 0) + row.weight);
    }
    assert.equal(days.length, expected.size);
    for (const d of days) near(d.harmonized, expected.get(`${d.year}-${d.day}`), `${d.year}-${d.day}`);
    assert.deepEqual(Object.keys(days[0]), ["year", "day", "harmonized"]);
    assert.ok(days.every((d, i) => i === 0 || days[i - 1].year < d.year || days[i - 1].day < d.day));
    const november = serving.sumCells("nile_delta", cells, 202611, 202611)[0].harmonized;
    near(days.filter((d) => d.year === 2026).reduce((sum, d) => sum + d.harmonized, 0), november, "2026-11");
    assert.deepEqual(serving.sumCellDays("nile_delta", []), []);
  });

  it("sumCells over 40,000 cells takes under 300 ms warm", (t) => {
    const cells = serving
      .getRegionCells("se_australia")
      .slice(0, 40000)
      .map((c) => c.cell_id);
    const rows = serving.sumCells("se_australia", cells);
    const times = [];
    for (let i = 0; i < 5; i += 1) {
      const started = performance.now();
      serving.sumCells("se_australia", cells);
      times.push(performance.now() - started);
    }
    const median = times.sort((a, b) => a - b)[2];
    t.diagnostic(`sumCells over 40,000 cells: ${median.toFixed(1)} ms (median of 5 warm runs), ${rows.length} months`);
    assert.ok(median < 300, `${median} ms`);
  });
});

describe("tiles", () => {
  let source;
  let serving;
  before(async () => {
    source = new DataSource({ baseUrl: FIXTURE });
    serving = await openServing(source);
  });
  after(() => source.close());

  it("streams the rows of the cell set and ym range, tile by tile in published order", async () => {
    const cells = new Set(nileRows.filter((_, i) => i % 7 === 0).map((r) => r.cell_id));
    const rows = await collect(serving.tileRows({ regionId: "nile_delta", tileIds: [...FIXTURE_TILES], cellIds: cells, ymStart: 201201, ymEnd: 202611 }));
    const expected = nileRows.filter((r) => cells.has(r.cell_id) && ymOf(r.acq_date) >= 201201);
    assert.ok(expected.length > 200);
    assert.deepEqual(rows, expected);
    for (const row of rows.slice(0, 50)) assert.deepEqual(checkTileRow(row), []);
  });

  it("reads every listed tile without tileIds, and skips unlisted ones", async () => {
    assert.equal((await collect(serving.tileRows({ regionId: "nile_delta" }))).length, nileRows.length);
    const one = await collect(serving.tileRows({ regionId: "nile_delta", tileIds: ["n31e031", "n30e031"] }));
    assert.deepEqual(one, tileRowsOnDisk.n30e031);
    assert.deepEqual(await collect(serving.tileRows({ regionId: "se_australia", tileIds: ["s38e145"] })), []);
    assert.deepEqual(await collect(serving.tileRows({ regionId: "nile_delta", cellIds: [] })), []);
  });

  it("can be abandoned after the first row", async () => {
    for await (const row of serving.tileRows({ regionId: "nile_delta" })) {
      assert.equal(row.hotspot_id, nileRows[0].hotspot_id);
      break;
    }
  });

  it("reads CRLF line endings and quoted fields", async () => {
    const dir = tempDir();
    const text = gunzipSync(readFileSync(join(FIXTURE, FIXTURE_VERSION, "points", "nile_delta", "n30e030.csv.gz"))).toString();
    const lines = text.trimEnd().split("\n");
    const quoted = lines.map((line, i) => (i === 0 ? line : line.replace(/^([^,]*),([^,]*),/, '"$1","$2",')));
    mkdirTile(dir, "n30e030", gzipSync(`${quoted.join("\r\n")}\r\n`));
    const dataset = { remote: false, locate: (p) => join(dir, p) };
    assert.deepEqual(await collect(readTileRows(dataset, { regionId: "nile_delta", tileIds: ["n30e030"] })), tileRowsOnDisk.n30e030);
  });

  it("rejects a wrong header, a bad in_series, a bad tile id and a missing listed tile", async () => {
    const dir = tempDir();
    const dataset = { remote: false, locate: (p) => join(dir, p) };
    const read = (tileId) => collect(readTileRows(dataset, { regionId: "nile_delta", tileIds: [tileId] }));
    const header = TILE_COLUMNS.join(",");
    mkdirTile(dir, "n30e030", gzipSync(`${header.replace("weight_method", "method")}\n`));
    await assert.rejects(read("n30e030"), isDataError("bad_tile"));
    const row = "0123456789abcdef,Aqua,MODIS,2020-01-01T10:10Z,2020-01-01,30.1,30.1,D,5,50,0,SP,True,1,ratio_v1,17294420";
    mkdirTile(dir, "n30e031", gzipSync(`${header}\n${row}\n`));
    await assert.rejects(read("n30e031"), isDataError("bad_tile"));
    mkdirTile(dir, "n31e031", gzipSync(""));
    await assert.rejects(read("n31e031"), isDataError("bad_tile"));
    mkdirTile(dir, "n31e030", Buffer.from("not gzip"));
    await assert.rejects(read("n31e030"), isDataError("bad_tile"));
    await assert.rejects(read("../../x"), isDataError("bad_tile"));
    await assert.rejects(read("n29e029"), isDataError("missing_tile"));
  });

  it("reads tiles over HTTP, gzipped or already decoded by Content-Encoding", async () => {
    const server = await serve(FIXTURE);
    const tilePath = `/${FIXTURE_VERSION}/points/nile_delta/n30e031.csv.gz`;
    server.routes.set(tilePath, async (_, response) => {
      response.writeHead(200, { "content-encoding": "gzip" });
      response.end(await readFile(join(FIXTURE, tilePath)));
    });
    const remote = new DataSource({ baseUrl: server.url, cacheDir: tempDir() });
    try {
      const over = await openServing(remote);
      const rows = await collect(over.tileRows({ regionId: "nile_delta", cellIds: nileRows.map((r) => r.cell_id) }));
      assert.deepEqual(rows, nileRows);
      assert.equal(server.hits.get(tilePath), 1);
      const dataset = await remote.open();
      await assert.rejects(collect(readTileRows(dataset, { regionId: "nile_delta", tileIds: ["n29e029"] })), isDataError("missing_tile"));
    } finally {
      remote.close();
      await server.close();
    }
  });
});

function mkdirTile(dir, tile, body) {
  const folder = join(dir, "points", "nile_delta");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${tile}.csv.gz`), body);
}
