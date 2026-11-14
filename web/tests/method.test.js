import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { GET, methodBody } from "../api/method.js";
import { DataSource, resetDataSource } from "../lib/data/source.js";
import { contrastRatio, deltaE2000, simulateCvd } from "../public/js/calendar/color.js";
import {
  chartCardHtml,
  dataTableHtml,
  detectionNumbersHtml,
  escapeHtml,
  kTableHtml,
  legendHtml,
  lineLegendItems,
  n20ScoresHtml,
  scorecardHtml,
  seamNumbersHtml,
  statusHtml,
} from "../public/js/method/html.js";
import { CHART_HEIGHT, detectionOption, n20Option, seamOption, yearStep } from "../public/js/method/option.js";
import { renderMethodPage } from "../public/js/method/page.js";
import { METHOD_PALETTE as P } from "../public/js/method/palette.js";
import {
  detectionModel,
  driftText,
  foldBands,
  foldLabel,
  formatMultiple,
  frpAtProbability,
  kModel,
  methodView,
  monthX,
  n20Model,
  rawMultiplesText,
  scorecard,
  seamModel,
  shortFoldLabel,
} from "../public/js/method/transform.js";
import { checkKTable, checkMeta } from "../public/shared/contracts.js";
import { createAppServer } from "../server.js";
import { fixtureDir } from "./fixtures/fixture.js";
import detectionCurve from "../mocks/detection_curve.json" with { type: "json" };
import metadata from "../mocks/metadata.json" with { type: "json" };
import validationNile from "../mocks/validation-nile_delta.json" with { type: "json" };
import validationSummary from "../mocks/validation_summary.json" with { type: "json" };

const MOCK_KEYS = ["metadata", "validation_summary", "validation:nile_delta", "detection_curve"];
const REGIONS = metadata.regions.map(({ id, name }) => ({ id, name }));
const clone = (value) => structuredClone(value);

const scratch = mkdtempSync(join(tmpdir(), "hotornot-method-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let variants = 0;

/** An empty directory: no latest.json, so no published data. */
function emptyDir() {
  const dir = join(scratch, `empty-${variants++}`);
  mkdirSync(dir);
  return dir;
}

/**
 * A copy of the W02 fixture whose meta table is changed by `edit(set, remove)`.
 * @param {(set: (key: string, value: unknown) => void, remove: (...keys: string[]) => void) => void} edit
 */
function fixtureVariant(edit) {
  const dir = join(scratch, `fixture-${variants++}`);
  cpSync(fixtureDir(), dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "v3", "serving.sqlite"));
  try {
    const set = (key, value) =>
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, typeof value === "string" ? value : JSON.stringify(value));
    const remove = (...keys) => {
      for (const key of keys) db.prepare("DELETE FROM meta WHERE key = ?").run(key);
    };
    edit(set, remove);
  } finally {
    db.close();
  }
  return dir;
}

const bodyFrom = (dir) => methodBody(new DataSource({ baseUrl: dir }));

/** Runs `fn` with console.warn captured. */
async function withWarnings(fn) {
  const warnings = [];
  const saved = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = saved;
  }
}

function assertArtifactShapes(body) {
  if (body.validation_summary) assert.deepEqual(checkMeta("validation_summary", body.validation_summary), []);
  for (const [id, value] of Object.entries(body.validation)) if (value) assert.deepEqual(checkMeta(`validation:${id}`, value), []);
  if (body.detection_curve) assert.deepEqual(checkMeta("detection_curve", body.detection_curve), []);
  if (body.k_table) assert.deepEqual(checkKTable(body.k_table), []);
}

describe("/api/method", () => {
  let fixtureBody;
  before(async () => {
    fixtureBody = await bodyFrom(fixtureDir());
  });

  it("serves the W01 mocks when no data version is published", async () => {
    const body = await bodyFrom(emptyDir());
    assert.equal(body.data_version, null);
    assert.equal(body.published_at, null);
    assert.deepEqual(body.mock, MOCK_KEYS);
    assert.deepEqual(body.method, metadata.method);
    assert.deepEqual(body.regions, REGIONS);
    assert.equal(body.attribution, metadata.attribution);
    assert.deepEqual(body.validation_summary, validationSummary);
    assert.deepEqual(body.validation, { nile_delta: validationNile, california: null, se_australia: null, n_argentina: null });
    assert.deepEqual(body.detection_curve, detectionCurve);
    assert.equal(body.k_table, null);
    assertArtifactShapes(body);
  });

  it("serves the published artifacts from the W02 fixture", async () => {
    const body = fixtureBody;
    assert.equal(body.data_version, "v3");
    assert.equal(body.published_at, "2026-11-13T12:00:00Z");
    assert.deepEqual(body.mock, []);
    assert.deepEqual(body.regions, REGIONS);
    assert.deepEqual(body.validation_summary, validationSummary);
    assert.deepEqual(body.validation.nile_delta, validationNile);
    assert.equal(body.validation.california, null);
    assert.deepEqual(body.detection_curve, detectionCurve);
    assert.equal(body.k_table.length, 4 * 12 * 2);
    assertArtifactShapes(body);
  });

  it("mocks only the validation set after a first ratio_v1 publish without validation", async () => {
    const dir = fixtureVariant((set, remove) => {
      remove("validation_summary", "validation:nile_delta", "detection_curve");
      set("metadata", { ...metadata, method: { ...metadata.method, weight_method: "ratio_v1", model_version: null } });
    });
    const body = await bodyFrom(dir);
    assert.equal(body.data_version, "v3");
    assert.deepEqual(body.mock, ["validation_summary", "validation:nile_delta", "detection_curve"]);
    assert.equal(body.method.weight_method, "ratio_v1");
    assert.deepEqual(body.validation_summary, validationSummary);
    assert.deepEqual(body.k_table, fixtureBody.k_table);
  });

  it("never mocks a missing artifact once validation is published", async () => {
    const summary = clone(validationSummary);
    summary.decision.method = "ratio_v1";
    for (const row of [...summary.lyo_2012_2019, ...summary.block_2020_2025]) {
      row.annual_error_pct.model = null;
      row.monthly_r.model = null;
    }
    const nile = clone(validationNile);
    for (const month of nile.months) month.model = null;
    const dir = fixtureVariant((set, remove) => {
      set("validation_summary", summary);
      set("validation:nile_delta", nile);
      remove("detection_curve");
    });
    const body = await bodyFrom(dir);
    assert.deepEqual(body.mock, []);
    assert.equal(body.detection_curve, null);
    assert.deepEqual(body.validation_summary, summary);
    assert.equal(body.validation.california, null);
    assertArtifactShapes(body);
  });

  it("drops a malformed artifact with a warning instead of mocking it", async () => {
    const dir = fixtureVariant((set) => {
      set("k_table", { not: "a list" });
      set("detection_curve", "{not json");
    });
    const { result: body, warnings } = await withWarnings(() => bodyFrom(dir));
    assert.equal(body.k_table, null);
    assert.equal(body.detection_curve, null);
    assert.deepEqual(body.mock, []);
    assert.equal(warnings.length, 2);
    assert.match(warnings.join("\n"), /k_table.*shape check/);
    assert.match(warnings.join("\n"), /detection_curve.*not JSON/);
  });

  it("answers GET with cache headers from DATA_BASE_URL", async () => {
    const saved = process.env.DATA_BASE_URL;
    try {
      process.env.DATA_BASE_URL = fixtureDir();
      resetDataSource();
      const published = await GET();
      assert.equal(published.status, 200);
      assert.equal(published.headers.get("cache-control"), "public, max-age=600");
      assert.deepEqual(await published.json(), fixtureBody);

      process.env.DATA_BASE_URL = emptyDir();
      resetDataSource();
      const mocked = await GET();
      assert.equal(mocked.headers.get("cache-control"), "no-store");
      assert.deepEqual((await mocked.json()).mock, MOCK_KEYS);
    } finally {
      if (saved === undefined) delete process.env.DATA_BASE_URL;
      else process.env.DATA_BASE_URL = saved;
      resetDataSource();
    }
  });
});

describe("served over HTTP", () => {
  let server;
  let port;
  const saved = process.env.DATA_BASE_URL;
  before(async () => {
    process.env.DATA_BASE_URL = fixtureDir();
    resetDataSource();
    server = createAppServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (saved === undefined) delete process.env.DATA_BASE_URL;
    else process.env.DATA_BASE_URL = saved;
    resetDataSource();
  });

  const fetchPath = (path, method = "GET") =>
    new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, method }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });

  it("serves /api/method", async () => {
    const res = await fetchPath("/api/method");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /application\/json/);
    const body = JSON.parse(res.body);
    assert.equal(body.data_version, "v3");
    assert.equal((await fetchPath("/api/method", "POST")).status, 405);
  });

  it("serves the page and every module and stylesheet it loads", async () => {
    const page = await fetchPath("/method.html");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /text\/html/);
    const assets = [...page.body.matchAll(/(?:src|href)="(\/(?:js|css|vendor)\/[^"?]+)[^"]*"/g)].map((m) => m[1]);
    const imports = [...page.body.matchAll(/from "(\/js\/[^"]+)"/g)].map((m) => m[1]);
    assert.ok(assets.includes("/vendor/echarts.min.js"));
    assert.ok(imports.includes("/js/method/page.js"));
    const seen = new Set();
    const queue = [...assets, ...imports];
    while (queue.length > 0) {
      const path = queue.shift();
      if (seen.has(path)) continue;
      seen.add(path);
      const res = await fetchPath(path);
      assert.equal(res.status, 200, path);
      if (path.endsWith(".js") && !path.startsWith("/vendor/")) {
        assert.match(res.headers["content-type"], /text\/javascript/, path);
        for (const [, spec] of res.body.matchAll(/^import [^;]*? from "([^"]+)";/gms)) queue.push(new URL(spec, `http://x${path}`).pathname);
      }
      if (path.endsWith(".css")) assert.match(res.headers["content-type"], /text\/css/, path);
    }
    for (const module of ["/js/method/transform.js", "/js/method/option.js", "/js/method/html.js", "/js/method/palette.js", "/js/calendar/color.js"]) {
      assert.ok(seen.has(module), module);
    }
  });
});

describe("seam transforms", () => {
  const lyo = validationSummary.lyo_2012_2019[0];
  const block = validationSummary.block_2020_2025[0];
  const model = seamModel(validationNile, { regionId: "nile_delta", name: "Nile Delta, Egypt", shipped: "model_v1", lyo, block });

  it("labels folds", () => {
    assert.equal(foldLabel(2012, 2013), "2012–13");
    assert.equal(foldLabel(2020, 2025), "2020–25");
    assert.equal(foldLabel(1999, 2000), "1999–2000");
    assert.equal(foldLabel(2018, 2018), "2018");
    assert.equal(shortFoldLabel(2012, 2013), "12–13");
  });

  it("places months mid-month on a year axis", () => {
    assert.equal(monthX(201201), 2012 + 1 / 24);
    assert.equal(monthX(202512), 2026 - 1 / 24);
  });

  it("turns folds into alternating bands with the 2020-2025 block last", () => {
    const bands = foldBands(validationNile.months);
    assert.deepEqual(
      bands.map((b) => [b.label, b.kind, b.shade, b.start, b.end, b.months]),
      [
        ["2012–13", "lyo", 0, 2012, 2014, 24],
        ["2014–15", "lyo", 1, 2014, 2016, 24],
        ["2016–17", "lyo", 0, 2016, 2018, 24],
        ["2018–19", "lyo", 1, 2018, 2020, 24],
        ["2020–25", "block", 0, 2020, 2026, 72],
      ],
    );
    const gap = foldBands([{ ym: 201203, fold: "2012-2013" }, { ym: 201204, fold: "2012-2013" }]);
    assert.deepEqual([gap[0].start, gap[0].end], [2012 + 2 / 12, 2012 + 4 / 12]);
  });

  it("builds four lines, sorted by month, with the shipped one marked", () => {
    const shuffled = { ...validationNile, months: [...validationNile.months].reverse() };
    const fromShuffled = seamModel(shuffled, { regionId: "nile_delta", name: "Nile", shipped: "model_v1" });
    assert.deepEqual(fromShuffled.months.map((m) => m.ym), validationNile.months.map((m) => m.ym));
    assert.deepEqual(model.series.map((s) => s.key), ["modis", "viirs_raw", "ratio", "model"]);
    assert.deepEqual(model.series.filter((s) => s.shipped).map((s) => s.key), ["model"]);
    assert.equal(model.x.length, 168);
    const sum = (key) => validationNile.months.reduce((total, m) => total + m[key], 0);
    assert.equal(model.totals.modis, sum("modis"));
    assert.equal(model.totals.viirs_raw, sum("viirs_raw"));
    assert.equal(model.peak.modis, Math.max(...validationNile.months.map((m) => m.modis)));
  });

  it("describes the chart for screen readers", () => {
    const ratio = (model.totals.viirs_raw / model.totals.modis).toFixed(1);
    assert.match(model.description, /^Nile Delta, Egypt: monthly hotspots from January 2012 to December 2025 \(168 months\)\./);
    assert.ok(model.description.includes(`Raw VIIRS counted ${ratio} times as many hotspots as MODIS`));
    assert.match(model.description, /Held-out annual error in 2012–2019: raw VIIRS 589\.9%, ratio 8\.5%, model 6\.3%\. In 2020–2025: raw VIIRS 707%, ratio 13\.9%, model 11\.8%\./);
    assert.match(model.description, /MODIS peaked in October 2013 with 904 hotspots/);
    assert.match(model.description, /2018–19, 2020–25\.$/);
  });

  it("drops the model line when only ratio_v1 exists", () => {
    const ratioOnly = clone(validationNile);
    for (const month of ratioOnly.months) delete month.model;
    const m = seamModel(ratioOnly, { regionId: "nile_delta", name: "Nile", shipped: "ratio_v1" });
    assert.equal(m.hasModel, false);
    assert.deepEqual(m.series.map((s) => s.key), ["modis", "viirs_raw", "ratio"]);
    assert.deepEqual(m.series.filter((s) => s.shipped).map((s) => s.key), ["ratio"]);
    assert.doesNotMatch(m.description, /model/);
  });

  it("handles a region with no months", () => {
    const m = seamModel({ months: [], n20: [] }, { regionId: "california", name: "California", shipped: "model_v1" });
    assert.equal(m.description, "California: no validation months.");
    assert.deepEqual(m.folds, []);
  });

  it("formats multiples", () => {
    assert.deepEqual([12.4, 7.94, 1.023, 0.98].map(formatMultiple), ["12", "7.9", "1.02", "0.98"]);
  });
});

describe("NOAA-20 transforms", () => {
  it("compares harmonized S-NPP and NOAA-20", () => {
    const score = validationSummary.n20_seam[0];
    const model = n20Model(validationNile, { regionId: "nile_delta", name: "Nile Delta, Egypt", score });
    assert.equal(model.months.length, 93);
    assert.deepEqual(model.series.map((s) => s.key), ["snpp", "n20"]);
    assert.match(model.description, /April 2018 to December 2025 \(93 months\)/);
    assert.match(model.description, /Annual error 2\.5%, monthly correlation 0\.998\.$/);
  });
});

describe("scorecard", () => {
  const card = scorecard(validationSummary, { regions: REGIONS, shipped: "model_v1" });

  it("marks every score against the decision rule's limits", () => {
    assert.deepEqual(card.methods, ["raw", "ratio", "model"]);
    const [lyo, block] = card.tests;
    assert.deepEqual(lyo.rows.map((row) => row.regionId), ["nile_delta", "california", "se_australia", "n_argentina"]);
    const argentina = lyo.rows[3];
    assert.deepEqual(argentina.annual.map((c) => c.passes), [false, true, false]);
    assert.deepEqual(argentina.r.map((c) => c.passes), [true, true, false]);
    const modelPasses = lyo.rows.filter((row) => row.annual[2].passes && row.r[2].passes).length;
    assert.equal(modelPasses, validationSummary.decision.passed_regions);
    assert.equal(block.rows[0].annual[2].value, 11.8);
    assert.deepEqual(card.n20.map((row) => row.annual.passes), [true, true, true, true]);
  });

  it("states the decision and flags a data version shipped with another method", () => {
    assert.deepEqual(
      { method: card.decision.method, passed: card.decision.passed, of: card.decision.of, agrees: card.decision.agrees },
      { method: "model_v1", passed: 3, of: 4, agrees: true },
    );
    assert.match(card.description, /^The detection model \(model_v1\) ships\. .* in 3 of 4 regions\.$/);
    const other = scorecard(validationSummary, { regions: REGIONS, shipped: "ratio_v1" });
    assert.match(other.description, /published with the ratio method \(ratio_v1\)\.$/);
  });

  it("drops the model column when no model ran", () => {
    const summary = clone(validationSummary);
    for (const row of [...summary.lyo_2012_2019, ...summary.block_2020_2025]) {
      delete row.annual_error_pct.model;
      row.monthly_r.model = null;
    }
    summary.decision = { ...summary.decision, method: "ratio_v1", passed_regions: 0 };
    const ratioCard = scorecard(summary, { regions: REGIONS, shipped: "ratio_v1" });
    assert.deepEqual(ratioCard.methods, ["raw", "ratio"]);
    assert.equal(ratioCard.tests[0].rows[0].annual.length, 2);
    assert.equal(ratioCard.description, "The ratio method (ratio_v1) ships. No detection model was validated, so the ratio method is the only candidate.");
    const html = scorecardHtml(ratioCard);
    assert.ok(html.includes("No detection model was validated") && !html.includes("0 of 4"));
    assert.equal((html.match(/<td class="num (pass|fail)">/g) ?? []).length, 2 * 4 * 4);
    assert.match(driftText(ratioCard), /Nile Delta, Egypt 8\.5% to 13\.9%/);
  });

  it("keeps regions the metadata does not name, after the named ones", () => {
    const partial = scorecard(validationSummary, { regions: REGIONS.slice(0, 2), shipped: "model_v1" });
    assert.deepEqual(partial.tests[0].rows.map((row) => row.name), ["Nile Delta, Egypt", "California and Nevada", "se_australia", "n_argentina"]);
  });

  it("writes the drift caveat from the shipped method's errors", () => {
    assert.match(driftText(card), /^Annual error of the detection model \(model_v1\), 2012–2019 against 2020–2025: Nile Delta, Egypt 6\.3% to 11\.8%; California and Nevada 6\.2% to 8\.4%;/);
    const ratioCard = scorecard(validationSummary, { regions: REGIONS, shipped: "ratio_v1" });
    assert.match(driftText(ratioCard), /Nile Delta, Egypt 8\.5% to 13\.9%/);
  });
});

describe("detection curve", () => {
  it("finds the FRP where a curve crosses a probability, in log FRP", () => {
    assert.equal(frpAtProbability(detectionCurve.frp_mw, detectionCurve.curves[0].p, 0.5), 10);
    assert.ok(Math.abs(frpAtProbability([1, 100], [0.25, 0.75]) - 10) < 1e-9);
    assert.equal(frpAtProbability([1, 10], [0.1, 0.4]), null);
    assert.equal(frpAtProbability([1, 10], [0.6, 0.9]), null);
  });

  it("orders land classes and gives unknown ones their own style", () => {
    const curve = clone(detectionCurve);
    curve.curves.push({ land_class: "peat_bog", p: curve.curves[0].p });
    curve.curves.reverse();
    const model = detectionModel(curve);
    assert.deepEqual(model.lines.map((l) => l.landClass), ["all", "cropland", "forest", "shrubland", "savanna", "grassland", "peat_bog"]);
    assert.equal(model.lines[0].style, P.detection.all);
    assert.equal(model.lines.at(-1).style, P.extraLines[0]);
    assert.equal(model.lines.at(-1).label, "Peat bog");
  });

  it("describes the curve", () => {
    const model = detectionModel(detectionCurve);
    assert.match(model.description, /from 0\.5 to 500 MW, for 5 land classes and all land together\./);
    assert.match(model.description, /Over all land MODIS detects 2% of fires at 0\.5 MW, half at about 10 MW and 99\.4% at 500 MW\./);
    assert.match(model.description, /cropland about 14 MW/);
    const flat = detectionModel({ frp_mw: [1, 10], curves: [{ land_class: "all", p: [0.6, 0.9] }] });
    assert.match(flat.description, /half at below 1 MW/);
  });
});

describe("k table", () => {
  let k;
  let rows;
  before(async () => {
    rows = (await bodyFrom(fixtureDir())).k_table;
    k = kModel(rows, { regions: REGIONS, shipped: "model_v1" });
  });

  it("lays out one row per region and satellite, twelve months each", () => {
    assert.equal(k.rows.length, 8);
    assert.deepEqual(k.rows.slice(0, 2).map((r) => [r.regionId, r.satellite]), [["nile_delta", "S-NPP"], ["nile_delta", "NOAA-20"]]);
    assert.ok(k.rows.every((r) => r.cells.length === 12 && r.cells.every(Boolean)));
    assert.equal(k.count, 96);
    assert.equal(k.levels.region_month + k.levels.pooled_3month + k.levels.region_year, 96);
    assert.equal(k.symbol, "k");
    assert.equal(kModel(rows, { regions: REGIONS, shipped: "ratio_v1" }).symbol, "r");
  });

  it("colors on viridis with readable text", () => {
    const cells = k.rows.flatMap((r) => r.cells);
    const lowest = cells.find((c) => c.value === k.min);
    const highest = cells.find((c) => c.value === k.max);
    assert.equal(lowest.fill, P.sequential[0]);
    assert.equal(highest.fill, P.sequential.at(-1));
    for (const cell of cells) assert.ok(contrastRatio(cell.fill, cell.ink) >= 4.5, `${cell.fill} ${cell.ink}`);
  });

  it("leaves gaps for missing months and describes the extremes", () => {
    const some = rows.filter((row) => !(row.region_id === "california" && row.month === 3));
    const model = kModel(some, { regions: REGIONS, shipped: "model_v1" });
    const california = model.rows.find((r) => r.regionId === "california");
    assert.equal(california.cells[2], null);
    assert.match(k.description, /^Coverage factor k for 8 region and satellite rows by calendar month\. It ranges from 0\.22 \(.*\) to 0\.42 \(.*\)\. Of 96 values, /);
  });
});

describe("method view", () => {
  it("builds every section from the mock body", async () => {
    const view = methodView(await bodyFrom(emptyDir()));
    assert.deepEqual(view.mock, { any: true, metadata: true, validation: true, detection: true });
    assert.deepEqual(view.seams.map((s) => Boolean(s.model)), [true, false, false, false]);
    assert.deepEqual(view.n20.map((s) => Boolean(s.model)), [true, false, false, false]);
    assert.ok(view.scorecard);
    assert.ok(view.detection);
    assert.equal(view.k, null);
    assert.equal(view.rawMultiples.length, 1);
    assert.match(rawMultiplesText(view.rawMultiples), /^7\.3 times in Nile Delta, Egypt$/);
    assert.equal(rawMultiplesText([{ name: "A", value: 2 }, { name: "B", value: 3 }, { name: "C", value: 4 }]), "2.0 times in A; 3.0 times in B and 4.0 times in C");
  });

  it("builds the k table from the fixture", async () => {
    const view = methodView(await bodyFrom(fixtureDir()));
    assert.equal(view.mock.any, false);
    assert.equal(view.k.rows.length, 8);
    assert.equal(view.dataVersion, "v3");
  });
});

function loadEcharts() {
  const source = readFileSync(new URL("../public/vendor/echarts.min.js", import.meta.url), "utf8");
  const module = { exports: {} };
  new Function("module", "exports", source)(module, module.exports);
  return module.exports;
}

describe("ECharts options (server-side SVG)", () => {
  const echarts = loadEcharts();
  const view = methodView({
    data_version: "v3",
    published_at: null,
    method: metadata.method,
    regions: REGIONS,
    attribution: "x",
    mock: [],
    validation_summary: validationSummary,
    validation: { nile_delta: validationNile },
    detection_curve: detectionCurve,
    k_table: null,
  });
  const seam = view.seams[0].model;

  function render({ option, height }, width) {
    const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width, height });
    try {
      chart.setOption(option);
      return chart.renderToSVGString();
    } finally {
      chart.dispose();
    }
  }
  const texts = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

  it("steps year labels to the width", () => {
    assert.equal(yearStep(14, 900), 1);
    assert.equal(yearStep(14, 400), 2);
    assert.equal(yearStep(14, 120), 5);
  });

  it("draws the seam chart with fold labels that fit the width", () => {
    const wide = seamOption(seam, { width: 460 });
    assert.equal(wide.height, CHART_HEIGHT.seam);
    assert.equal(wide.option.aria.label.description, seam.description);
    const wideTexts = texts(render(wide, 460));
    for (const label of ["2012–13", "2014–15", "2016–17", "2018–19", "2020–25", "2012", "2026"]) assert.ok(wideTexts.includes(label), label);
    const narrowTexts = texts(render(seamOption(seam, { width: 340 }), 340));
    for (const label of ["12–13", "18–19", "2020–25"]) assert.ok(narrowTexts.includes(label), label);
  });

  it("hides raw VIIRS on request, which rescales the y axis", () => {
    const all = seamOption(seam, { width: 600 });
    const harmonizedOnly = seamOption(seam, { width: 600, showRaw: false });
    assert.deepEqual(all.option.series.map((s) => s.id), ["folds", "modis", "viirs_raw", "ratio", "model"]);
    assert.deepEqual(harmonizedOnly.option.series.map((s) => s.id), ["folds", "modis", "ratio", "model"]);
    const top = (svg) => Math.max(...texts(svg).filter((t) => /^\d+(\.\d)?K?$/.test(t)).map((t) => parseFloat(t) * (t.endsWith("K") ? 1000 : 1)));
    assert.ok(top(render(harmonizedOnly, 600)) < top(render(all, 600)));
    const model = all.option.series.find((s) => s.id === "model");
    assert.equal(model.lineStyle.width, P.seam.model.width + 1);
  });

  it("formats the seam tooltip", () => {
    const { option } = seamOption(seam, { width: 600 });
    const html = option.tooltip.formatter([
      { dataIndex: 0, seriesId: "modis", seriesName: "MODIS", marker: "", value: [monthX(201201), 2] },
      { dataIndex: 0, seriesId: "model", seriesName: "Harmonized, model", marker: "", value: [monthX(201201), 4.5] },
      { dataIndex: 0, seriesId: "folds", seriesName: "x", marker: "", value: [monthX(201201), null] },
    ]);
    assert.equal(html, "<b>January 2012</b><br>MODIS: 2<br>Harmonized, model: 4.5");
  });

  it("draws the NOAA-20 chart", () => {
    const model = view.n20[0].model;
    const svgTexts = texts(render(n20Option(model, { width: 460 }), 460));
    assert.ok(svgTexts.includes("2018") && svgTexts.includes("2026"));
  });

  it("draws the detection curve with the 50% guide", () => {
    const built = detectionOption(view.detection, { width: 720 });
    assert.equal(built.option.xAxis.type, "log");
    const svgTexts = texts(render(built, 720));
    for (const label of ["50%", "≈ 10 MW", "Chance MODIS detects it", "VIIRS fire strength (radiative power), MW, log scale", "100%", "0.5", "500"]) {
      assert.ok(svgTexts.includes(label), label);
    }
    assert.ok(texts(render(detectionOption(view.detection, { width: 340 }), 340)).includes("Fire strength, MW (log)"));
    const tip = built.option.tooltip.formatter([{ dataIndex: 6, seriesName: "All <land>", marker: "", value: [10, 0.5] }]);
    assert.equal(tip, "<b>10 MW</b><br>All &lt;land&gt;: 50%");
  });
});

describe("HTML", () => {
  const card = scorecard(validationSummary, { regions: REGIONS, shipped: "model_v1" });

  it("escapes text", () => {
    assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    const table = dataTableHtml({ columns: [{ label: "<b>" }], rows: [["<i>"], [null]] });
    assert.ok(table.includes("&lt;b&gt;") && table.includes("&lt;i&gt;") && table.includes("<th scope=\"row\">—</th>"));
  });

  it("frames charts and placeholders", () => {
    const chart = chartCardHtml({ id: "seam-nile_delta", title: "Nile", height: 260 });
    for (const id of ["chart-seam-nile_delta", "numbers-seam-nile_delta", "numbers-body-seam-nile_delta"]) assert.ok(chart.includes(`id="${id}"`), id);
    assert.ok(chart.includes("height:260px"));
    const empty = chartCardHtml({ id: "seam-x", title: "X", height: 260, placeholder: "Nothing <yet>" });
    assert.ok(!empty.includes("chart-seam-x") && empty.includes("Nothing &lt;yet&gt;"));
  });

  it("draws legend swatches in each line's color and dash", () => {
    const seam = methodView({ ...methodBodyLike(), validation: { nile_delta: validationNile } }).seams[0].model;
    const html = legendHtml(lineLegendItems(seam.series));
    assert.ok(html.includes(`stroke="${P.seam.ratio.color}"`) && html.includes('stroke-dasharray="6 4"'));
    assert.ok(html.includes("Corrected, detection model (in use)"));
  });

  it("writes the scorecard with the decision and a mark on every score", () => {
    const html = scorecardHtml(card);
    assert.match(html, /Decision: the app uses <strong>the detection model \(model_v1\)<\/strong>\./);
    assert.match(html, /<strong>3 of 4<\/strong> regions/);
    assert.ok(html.includes(escapeHtml(validationSummary.decision.rule)));
    assert.equal((html.match(/<td class="num (pass|fail)">/g) ?? []).length, 2 * 4 * 6);
    assert.equal((html.match(/✓/g) ?? []).length, (html.match(/meets the/g) ?? []).length);
    assert.ok(html.includes("16.8%<span class=\"mark\" aria-hidden=\"true\">✗</span>"));
    assert.ok(!html.includes("published with"));
    assert.ok(scorecardHtml(scorecard(validationSummary, { regions: REGIONS, shipped: "ratio_v1" })).includes("published with"));
    assert.equal((n20ScoresHtml(card).match(/<tr><th scope="row">/g) ?? []).length, 4);
  });

  it("writes the k table as a heatmap", async () => {
    const rows = (await bodyFrom(fixtureDir())).k_table;
    const html = kTableHtml(kModel(rows, { regions: REGIONS, shipped: "model_v1" }));
    assert.equal((html.match(/<abbr title=/g) ?? []).length, 12);
    assert.equal((html.match(/<td class="level-/g) ?? []).length, 96);
    assert.equal((html.match(/<th scope="rowgroup" rowspan="2"/g) ?? []).length, 4);
    assert.ok(html.includes("pooled with the two adjacent months"));
    assert.match(html, /<caption>Coverage factor k by region, satellite and calendar month<\/caption>/);
  });

  it("puts the numbers behind each chart in a table", () => {
    const view = methodView({ ...methodBodyLike(), validation: { nile_delta: validationNile } });
    const seamTable = seamNumbersHtml(view.seams[0].model);
    assert.equal((seamTable.match(/<tr>/g) ?? []).length, 169);
    assert.ok(seamTable.includes("<th scope=\"row\">January 2012</th>"));
    const detection = detectionNumbersHtml(view.detection);
    assert.equal((detection.match(/<tr>/g) ?? []).length, detectionCurve.frp_mw.length + 1);
  });

  it("says when the numbers are mocks", async () => {
    const mocked = statusHtml(methodView(await bodyFrom(emptyDir())));
    assert.match(mocked, /Preview with mock numbers/);
    const published = statusHtml(methodView(await bodyFrom(fixtureDir())));
    assert.match(published, /^<p class="muted">Data version v3, published 13 November 2026\. The calendar uses the detection model \(model_v1\)\.<\/p>$/);
    const partial = statusHtml(methodView({ ...methodBodyLike(), mock: ["validation_summary", "validation:nile_delta"] }));
    assert.match(partial, /The seam charts, scorecard and NOAA-20 comparison below use development mocks/);
  });
});

function methodBodyLike() {
  return {
    data_version: "v3",
    published_at: "2026-11-13T12:00:00Z",
    method: metadata.method,
    regions: REGIONS,
    attribution: metadata.attribution,
    mock: [],
    validation_summary: validationSummary,
    validation: {},
    detection_curve: detectionCurve,
    k_table: null,
  };
}

describe("palette", () => {
  const charts = {
    seam: Object.values(P.seam),
    n20: Object.values(P.n20),
    detection: [...Object.values(P.detection), ...P.extraLines],
  };
  const vision = [null, "deuteranopia", "protanopia"];
  const distance = (a, b, kind) => (kind ? deltaE2000(simulateCvd(a, kind), simulateCvd(b, kind)) : deltaE2000(a, b));

  it("keeps every line at least 3:1 against the chart background", () => {
    for (const [chart, lines] of Object.entries(charts)) {
      for (const line of lines) assert.ok(contrastRatio(line.color, P.background) >= 3, `${chart} ${line.color}`);
    }
  });

  it("separates lines that share a dash pattern by at least ΔE00 20, with color-vision deficiency too", (t) => {
    let closest = Infinity;
    for (const [chart, lines] of Object.entries(charts)) {
      for (let i = 0; i < lines.length; i += 1) {
        for (let j = i + 1; j < lines.length; j += 1) {
          if (String(lines[i].dash) !== String(lines[j].dash)) continue;
          for (const kind of vision) {
            const d = distance(lines[i].color, lines[j].color, kind);
            closest = Math.min(closest, d);
            assert.ok(d >= 20, `${chart}: ${lines[i].color} and ${lines[j].color} under ${kind ?? "normal vision"}: ${d.toFixed(1)}`);
          }
        }
      }
    }
    t.diagnostic(`closest same-dash pair: ΔE00 ${closest.toFixed(1)}`);
  });

  it("keeps fold labels readable on the fold shades", () => {
    for (const shade of P.foldShades) assert.ok(contrastRatio(P.muted, shade) >= 4.5, shade);
  });
});

describe("page", () => {
  const html = readFileSync(new URL("../public/method.html", import.meta.url), "utf8");

  /** A document stub: elements exist when method.html or inserted HTML declares their id. */
  function fakeDocument() {
    const elements = new Map();
    const attributes = (tag) => Object.fromEntries([...tag.matchAll(/([a-z-]+)(?:="([^"]*)")?/g)].slice(1).map((m) => [m[1], m[2] ?? ""]));
    const make = (attrs = {}) => {
      const listeners = {};
      const element = {
        attrs,
        hidden: "hidden" in attrs,
        textContent: "",
        innerHTML: "",
        clientWidth: 480,
        open: false,
        checked: "checked" in attrs,
        get childElementCount() {
          return element.innerHTML ? 1 : 0;
        },
        classList: { toggle: (name, on) => (element.classes = { ...element.classes, [name]: on }) },
        getAttribute: (name) => attrs[name] ?? null,
        setAttribute: (name, value) => (attrs[name] = String(value)),
        addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
        dispatch: (type) => (listeners[type] ?? []).forEach((fn) => fn()),
        querySelector: () => null,
      };
      return element;
    };
    const statics = [...html.matchAll(/<[a-z]+\s[^>]*>/g)].map((m) => make(attributes(m[0])));
    for (const element of statics) if (element.attrs.id) elements.set(element.attrs.id, element);
    return {
      elements,
      getElementById(id) {
        if (elements.has(id)) return elements.get(id);
        for (const element of elements.values()) {
          if (element.innerHTML.includes(`id="${id}"`)) {
            const created = make({ id });
            elements.set(id, created);
            return created;
          }
        }
        return null;
      },
      querySelectorAll(selector) {
        const match = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
        return statics.filter((element) => match[1] in element.attrs && (match[2] === undefined || element.attrs[match[1]] === match[2]));
      },
    };
  }

  function stubEcharts() {
    const charts = [];
    globalThis.echarts = {
      init(element) {
        const chart = { element, options: [], setOption: (option) => chart.options.push(option), resize() {} };
        charts.push(chart);
        return chart;
      },
    };
    return charts;
  }

  it("renders the mock body: charts where there is data, placeholders elsewhere", async () => {
    const charts = stubEcharts();
    try {
      const doc = fakeDocument();
      renderMethodPage(await bodyFrom(emptyDir()), /** @type {any} */ (doc));
      assert.deepEqual(charts.map((c) => c.element.attrs.id), ["chart-seam-nile_delta", "chart-detection", "chart-n20-nile_delta"]);
      for (const chart of charts) assert.ok(chart.options[0].aria.label.description.length > 50);
      assert.match(doc.getElementById("method-status").innerHTML, /Preview with mock numbers/);
      assert.match(doc.getElementById("seam-charts").innerHTML, /Nile Delta only/);
      assert.match(doc.getElementById("k-table").innerHTML, /no mock table/);
      assert.match(doc.getElementById("scorecard").innerHTML, /Decision:/);
      assert.match(doc.getElementById("drift-numbers").innerHTML, /6\.3% to 11\.8%/);
      assert.match(doc.getElementById("raw-multiples").innerHTML, /7\.3 times/);
      assert.equal(doc.getElementById("attribution").textContent, metadata.attribution);
      assert.ok(doc.querySelectorAll("[data-mock]").every((element) => !element.hidden));
      assert.ok(doc.querySelectorAll('[data-method="ratio_v1"]').every((element) => element.hidden));
      assert.ok(doc.querySelectorAll('[data-method="model_v1"]').every((element) => !element.hidden));
      assert.ok(doc.querySelectorAll('[data-fill="viirs-switch"]').every((element) => element.textContent === "2 November 2026"));

      const details = doc.getElementById("numbers-seam-nile_delta");
      details.open = true;
      details.dispatch("toggle");
      assert.match(doc.getElementById("numbers-body-seam-nile_delta").innerHTML, /January 2012/);

      const toggle = doc.getElementById("show-raw");
      toggle.checked = false;
      toggle.dispatch("change");
      const seamChart = charts[0];
      assert.equal(seamChart.options.length, 2);
      assert.ok(!seamChart.options[1].series.some((s) => s.id === "viirs_raw"));
    } finally {
      delete globalThis.echarts;
    }
  });

  it("renders the fixture body with the k table and a ratio_v1 data version", async () => {
    stubEcharts();
    try {
      const body = await bodyFrom(fixtureDir());
      const doc = fakeDocument();
      renderMethodPage({ ...body, method: { ...body.method, weight_method: "ratio_v1" }, detection_curve: null }, /** @type {any} */ (doc));
      assert.match(doc.getElementById("k-table").innerHTML, /Ratio factor r by region/);
      assert.match(doc.getElementById("detection").innerHTML, /No detection model in data version v3/);
      assert.match(doc.getElementById("method-status").innerHTML, /Data version v3/);
      assert.ok(doc.querySelectorAll("[data-mock]").every((element) => element.hidden));
      assert.ok(doc.querySelectorAll('[data-method="model_v1"]').every((element) => element.hidden));
    } finally {
      delete globalThis.echarts;
    }
  });
});
