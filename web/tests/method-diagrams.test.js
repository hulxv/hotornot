import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { methodBody } from "../api/method.js";
import { DataSource } from "../lib/data/source.js";
import { checkDocument, parseHtml } from "../scripts/a11y-check.js";
import { formatWeight } from "../public/js/map/point-info.js";
import { STEP_MS, mountDiagrams } from "../public/js/method/diagrams-dom.js";
import {
  allLandCurve,
  cameraCounts,
  cameraSvg,
  cameraView,
  chanceText,
  countedModel,
  curveAt,
  curveSvg,
  describeStep,
  equationHtml,
  factorAt,
  formatMw,
  missText,
  periodText,
  stepText,
  testSteps,
  testSvg,
  timelineHtml,
  timelineLayout,
  yearBlocksHtml,
  yearFraction,
} from "../public/js/method/diagrams.js";
import { CAMERAS, RUN_COUNTS, recordPeriods, roughly, satellites } from "../public/js/method/facts.js";
import { renderMethodPage } from "../public/js/method/page.js";
import { TIME } from "../public/shared/contracts.js";
import { fixtureDir } from "./fixtures/fixture.js";
import detectionCurve from "../mocks/detection_curve.json" with { type: "json" };
import metadata from "../mocks/metadata.json" with { type: "json" };
import validationNile from "../mocks/validation-nile_delta.json" with { type: "json" };
import validationSummary from "../mocks/validation_summary.json" with { type: "json" };

const REGIONS = metadata.regions.map(({ id, name }) => ({ id, name }));
const HTML = readFileSync(new URL("../public/method.html", import.meta.url), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "hotornot-diagrams-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const bodyFrom = (dir) => methodBody(new DataSource({ baseUrl: dir }));
const emptyDir = () => {
  const dir = join(scratch, `empty-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir);
  return dir;
};

/** The widest x a piece of SVG text can reach, at about 7 px per character for 12 px text. */
function textOverflow(svg, width) {
  let worst = 0;
  for (const [, attrs, text] of svg.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)) {
    const x = /\bx="([\d.]+)"/.exec(attrs)[1];
    const anchor = /text-anchor="(\w+)"/.exec(attrs)?.[1];
    const w = text.length * 7;
    const right = anchor === "middle" ? Number(x) + w / 2 : anchor === "end" ? Number(x) : Number(x) + w;
    worst = Math.max(worst, right - width);
  }
  return worst;
}

describe("facts", () => {
  it("rounds the run's counts to two significant digits", () => {
    assert.equal(roughly(RUN_COUNTS.downloaded), "13 million");
    assert.equal(roughly(9_416_699), "9.4 million");
    assert.equal(roughly(908_862), "910,000");
    assert.equal(roughly(11_968), "12,000");
    assert.equal(roughly(48), "48");
    assert.equal(roughly(10_400_000), "10 million");
  });

  it("takes the satellites' dates from the contracts and ends S-NPP at the switch", () => {
    const sats = satellites({ viirsSwitch: "2026-11-02" });
    assert.deepEqual(
      sats.map((sat) => [sat.name, sat.camera, sat.start, sat.end]),
      [
        ["Terra", "MODIS", TIME.RECORD_START, null],
        ["Aqua", "MODIS", TIME.AQUA_START, null],
        ["S-NPP", "VIIRS", TIME.SNPP_START, "2026-11-02"],
        ["NOAA-20", "VIIRS", TIME.N20_START, null],
      ],
    );
    const periods = recordPeriods({ viirsSwitch: "2026-11-02" });
    assert.deepEqual(
      periods.map((period) => [period.start, period.end]),
      [
        ["2000-11-01", "2012-01-01"],
        ["2012-01-01", "2026-11-02"],
        ["2026-11-02", null],
      ],
    );
  });

});

describe("timeline layout", () => {
  it("measures dates in fractional years", () => {
    assert.equal(yearFraction("2012-01-01"), 2012);
    assert.ok(Math.abs(yearFraction("2000-07-02") - 2000.5) < 0.003);
  });

  it("writes periods in whole months unless one starts or ends inside a month", () => {
    assert.equal(periodText("2000-11-01", "2012-01-01"), "November 2000 to December 2011");
    assert.equal(periodText("2012-01-01", "2026-11-02"), "January 2012 to 1 November 2026");
    assert.equal(periodText("2026-11-02", null), "since 2 November 2026");
    assert.equal(periodText("2002-07-04", null, { exact: false }), "July 2002 to today");
    assert.equal(periodText("2012-01-20", "2026-11-02", { exact: false }), "January 2012 to November 2026");
  });

  it("places bars in percent of 2000 to 2027", () => {
    const layout = timelineLayout({ today: "2026-11-13", width: 900 });
    const terra = layout.bars.find((bar) => bar.id === "terra");
    assert.ok(Math.abs(terra.left - ((yearFraction("2000-11-01") - 2000) / 27) * 100) < 1e-9);
    assert.ok(Math.abs(terra.left + terra.width - ((yearFraction("2026-11-13") - 2000) / 27) * 100) < 1e-9);
    const snpp = layout.bars.find((bar) => bar.id === "snpp");
    assert.ok(Math.abs(snpp.left + snpp.width - ((yearFraction("2026-11-02") - 2000) / 27) * 100) < 1e-9);
    assert.ok(Math.abs(layout.switchAt - (12 / 27) * 100) < 1e-9);
    assert.deepEqual(
      layout.bars.map((bar) => bar.info.split(".")[0]),
      ["Terra (MODIS), November 2000 to today", "Aqua (MODIS), July 2002 to today", "S-NPP (VIIRS), January 2012 to November 2026", "NOAA-20 (VIIRS), April 2018 to today"],
    );
  });

  it("gives the 12-day NOAA-20 period a visible width and keeps the strip from overlapping", () => {
    for (const width of [320, 640, 1200]) {
      const { record, trackPx } = timelineLayout({ today: "2026-11-13", width });
      const last = record.at(-1);
      assert.ok((last.width / 100) * trackPx >= 8 - 1e-9, `${width}`);
      assert.ok(last.left + last.width <= 100 + 1e-9);
      for (let i = 1; i < record.length; i += 1) assert.ok(record[i - 1].left + record[i - 1].width <= record[i].left + 1e-9, `${width}: ${i}`);
      assert.equal(record[0].left + record[0].width, record[1].left);
    }
  });

  it("labels every second year when wide and every fifth when narrow, and drops bar text that cannot fit", () => {
    const wide = timelineLayout({ today: "2026-11-13", width: 900 });
    const narrow = timelineLayout({ today: "2026-11-13", width: 320 });
    assert.deepEqual(wide.ticks.filter((tick) => tick.label).map((tick) => tick.year), [2000, 2002, 2004, 2006, 2008, 2010, 2012, 2014, 2016, 2018, 2020, 2022, 2024, 2026]);
    assert.deepEqual(narrow.ticks.filter((tick) => tick.label).map((tick) => tick.year), [2000, 2005, 2010, 2015, 2020, 2025]);
    assert.equal(wide.ticks.length, 27);
    assert.ok(wide.bars.every((bar) => bar.showText));
    assert.equal(narrow.bars.find((bar) => bar.id === "noaa20").showText, false);
    assert.equal(narrow.record.at(-1).showText, false);
  });

  it("draws one button per bar and segment, each named with its years and role", () => {
    const html = timelineHtml(timelineLayout({ today: "2026-11-13", width: 900 }));
    assert.equal((html.match(/<button type="button" class="tl-bar/g) ?? []).length, 4);
    assert.equal((html.match(/<button type="button" class="tl-seg/g) ?? []).length, 3);
    assert.ok(html.includes('class="tl-seg tl-modis"') && html.includes('class="tl-bar tl-viirs"'));
    assert.ok(html.includes("Our record, since 2 November 2026: Fires seen by VIIRS on NOAA-20"));
    const doc = parseHtml(`<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>t</h1>${html}</main></body></html>`);
    assert.deepEqual(checkDocument(doc), []);
  });
});

describe("two cameras", () => {
  it("cuts the 3 km patch into 1 km and 375 m squares with limits in proportion to their area", () => {
    const [modis, viirs] = CAMERAS.map((camera) => cameraView(camera, 10));
    assert.equal(modis.n, 3);
    assert.equal(viirs.n, 8);
    assert.equal(modis.limit, 10);
    assert.equal(viirs.limit, 1.40625);
  });

  it("counts squares, not fires: the three-fire front is one MODIS square and three VIIRS squares", () => {
    const [modis, viirs] = CAMERAS.map((camera) => cameraView(camera, 10));
    assert.deepEqual(modis.flagged.map((square) => [square.col, square.row]), [[0, 0], [1, 1]]);
    assert.ok(Math.abs(modis.flagged[0].mw - 12) < 1e-9);
    assert.equal(viirs.count, 6);
  });

  it("loses weak fires in MODIS first, and VIIRS never sees fewer", () => {
    const table = [1, 1.5, 3, 4, 10, 20, 40, 100].map((mw) => [mw, cameraCounts(mw)]);
    assert.deepEqual(
      table.map(([mw, counts]) => [mw, counts.modis, counts.viirs]),
      [
        [1, 0, 0],
        [1.5, 0, 1],
        [3, 0, 2],
        [4, 0, 5],
        [10, 2, 6],
        [20, 3, 6],
        [40, 4, 6],
        [100, 4, 6],
      ],
    );
    for (let e = 0; e <= 2; e += 0.05) {
      const counts = cameraCounts(10 ** e);
      assert.ok(counts.viirs >= counts.modis, String(10 ** e));
    }
  });

  it("draws each camera's view with its reported squares and a text alternative", () => {
    const view = cameraView(CAMERAS[1], 3);
    const svg = cameraSvg(view);
    assert.equal((svg.match(/class="cam-hit"/g) ?? []).length, 2);
    assert.equal((svg.match(/class="cam-fire"/g) ?? []).length, 6);
    assert.match(svg, /role="img" aria-label="VIIRS view of the same patch in 375 m squares: 2 of 64 squares marked as fire\."/);
    assert.equal(formatMw(10 ** 0.7), "5 MW");
    assert.equal(formatMw(0.126), "0.13 MW");
    assert.equal(formatMw(1000), "1,000 MW");
  });
});

describe("curve lookup", () => {
  const curve = allLandCurve(detectionCurve);
  const kRows = [
    { region_id: "nile_delta", month: 11, satellite: "S-NPP", value: 2, level: "region_month" },
    { region_id: "nile_delta", month: 11, satellite: "NOAA-20", value: 2.1, level: "region_month" },
    { region_id: "california", month: 11, satellite: "S-NPP", value: 0.8, level: "pooled_3month" },
  ];

  it("picks the all-land curve", () => {
    assert.deepEqual(curve.p, detectionCurve.curves.find((c) => c.land_class === "all").p);
    assert.deepEqual(allLandCurve({ frp_mw: [1, 2], curves: [{ land_class: "cropland", p: [0.1, 0.2] }] }).p, [0.1, 0.2]);
  });

  it("reads the curve at its points, between them in log strength, and holds it at the ends", () => {
    const frp = [1, 10, 100];
    const p = [0.1, 0.3, 0.9];
    assert.equal(curveAt(frp, p, 10), 0.3);
    assert.ok(Math.abs(curveAt(frp, p, Math.sqrt(10)) - 0.2) < 1e-12);
    assert.ok(Math.abs(curveAt(frp, p, 10 ** 1.25) - 0.45) < 1e-12);
    assert.equal(curveAt(frp, p, 0.1), 0.1);
    assert.equal(curveAt(frp, p, 1e5), 0.9);
    for (const [i, value] of curve.frp.entries()) assert.ok(Math.abs(curveAt(curve.frp, curve.p, value) - curve.p[i]) < 1e-12);
  });

  it("finds the S-NPP factor for a region and month", () => {
    assert.equal(factorAt(kRows, "nile_delta", 11).value, 2);
    assert.equal(factorAt(kRows, "nile_delta", 11, "NOAA-20").value, 2.1);
    assert.equal(factorAt(kRows, "nile_delta", 5), null);
    assert.equal(factorAt(null, "nile_delta", 11), null);
  });

  it("multiplies the chance by the factor and words it as the map's tooltip does", () => {
    const model = countedModel({ curve, kTable: kRows, regionId: "nile_delta", month: 11, frp: 3 });
    const p = curveAt(curve.frp, curve.p, 3);
    assert.equal(model.p, p);
    assert.equal(model.weight, p * 2);
    assert.equal(model.result, formatWeight(p * 2, "S-NPP"));
    assert.match(model.result, /^Counts as [\d.]+ of a MODIS detection$/);
    assert.equal(model.chance, `MODIS would have seen a fire like this ${chanceText(p)} of the time.`);
    assert.equal(chanceText(0.004), "less than 1%");
    assert.equal(chanceText(0.234), "about 23%");
  });

  it("counts every fire the same under the ratio method, and waits for a factor when none is published", () => {
    const ratio = countedModel({ curve: null, kTable: kRows, regionId: "california", month: 11, frp: 10 });
    assert.equal(ratio.p, null);
    assert.equal(ratio.weight, 0.8);
    assert.equal(ratio.result, "Counts as 0.8 of a MODIS detection");
    const missing = countedModel({ curve, kTable: null, regionId: "nile_delta", month: 11, frp: 10 });
    assert.equal(missing.weight, null);
    assert.equal(missing.result, null);
    assert.ok(equationHtml(missing, { place: "Nile Delta, Egypt in November" }).includes("Not known yet"));
  });

  it("writes the sum as chance × factor = result, read in order by screen readers", () => {
    const model = countedModel({ curve, kTable: kRows, regionId: "nile_delta", month: 11, frp: 10 });
    const html = equationHtml(model, { place: "Nile Delta, Egypt in November" });
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    assert.equal(text, `${Math.round(model.p * 100)}% chance MODIS sees it × times 2.0 factor for Nile Delta, Egypt in November = equals ${model.result} in the calendar`);
    assert.ok(!equationHtml(countedModel({ curve: null, kTable: kRows, regionId: "california", month: 11, frp: 1 }), { place: "x" }).includes("chance MODIS"));
  });

  it("draws the curve with the fire marked, inside its width", () => {
    for (const width of [300, 340, 640]) {
      const p = curveAt(curve.frp, curve.p, 20);
      const svg = curveSvg(curve, { width, frp: 20, p });
      const [, cx, cy] = /<circle class="cv-marker" cx="([\d.]+)" cy="([\d.]+)"/.exec(svg);
      const left = 44;
      const plotW = width - 44 - 20;
      const expected = left + ((Math.log10(20) - Math.log10(curve.frp[0])) / (Math.log10(curve.frp.at(-1)) - Math.log10(curve.frp[0]))) * plotW;
      assert.ok(Math.abs(Number(cx) - expected) < 0.1, `${width}`);
      assert.ok(Math.abs(Number(cy) - (30 + (1 - p) * 124)) < 0.1);
      assert.ok(textOverflow(svg, width) <= 0, `${width}: ${textOverflow(svg, width)}`);
      assert.match(svg, /aria-label="Chance that MODIS sees a fire, by its strength: .* Marked: 20 MW, about \d+%\."/);
    }
  });
});

describe("fold steps", () => {
  const months = (fold, from, to, values) => {
    const rows = [];
    for (let year = from; year <= to; year += 1) {
      for (let month = 1; month <= 12; month += 1) rows.push({ ym: year * 100 + month, fold, ...values(year) });
    }
    return rows;
  };
  const validation = {
    months: [
      ...months("2012-2013", 2012, 2013, (year) => ({ modis: 10, viirs_raw: 80, ratio: 11, model: year === 2012 ? 9 : 10 })),
      ...months("2014-2015", 2014, 2015, () => ({ modis: 10, viirs_raw: 80, ratio: 12, model: 10.5 })),
      ...months("2016-2017", 2016, 2017, () => ({ modis: 10, viirs_raw: 80, ratio: 10, model: 10 })),
      ...months("2018-2019", 2018, 2019, (year) => ({ modis: 10, viirs_raw: 80, ratio: 30, model: year === 2018 ? 16 : 12 })),
      ...months("2020-2025", 2020, 2025, () => ({ modis: 10, viirs_raw: 80, ratio: 10, model: 10 })),
    ],
    n20: [],
  };

  it("makes one step per two hidden calibration years, then the decision", () => {
    const model = testSteps({ validation: { nile_delta: validation }, summary: validationSummary, regions: REGIONS, shipped: "model_v1" });
    assert.deepEqual(model.years, [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019]);
    assert.deepEqual(model.steps.map((step) => step.kind), ["test", "test", "test", "test", "decision"]);
    assert.deepEqual(model.steps.slice(0, 4).map((step) => step.hidden), [[2012, 2013], [2014, 2015], [2016, 2017], [2018, 2019]]);
    assert.deepEqual(model.steps[1].learned, [2012, 2013, 2016, 2017, 2018, 2019]);
    assert.deepEqual(model.steps[0].regions.map((region) => region.regionId), ["nile_delta"]);
  });

  it("compares each hidden year's total with MODIS's, using the shipped method", () => {
    const model = testSteps({ validation: { nile_delta: validation }, summary: null, regions: REGIONS, shipped: "model_v1" });
    const years = (i) => model.steps[i].regions[0].years.map((year) => [year.year, year.modis, Math.round(year.ours * 10) / 10, Math.round(year.errorPct * 10) / 10]);
    assert.deepEqual(years(0), [[2012, 120, 108, -10], [2013, 120, 120, 0]]);
    assert.deepEqual(years(3), [[2018, 120, 192, 60], [2019, 120, 144, 20]]);
    assert.equal(model.steps.length, 4);
    const ratio = testSteps({ validation: { nile_delta: validation }, summary: null, regions: REGIONS, shipped: "ratio_v1" });
    assert.equal(Math.round(ratio.steps[3].regions[0].years[0].errorPct), 200);
  });

  it("averages to the summary's error on real-shaped data", () => {
    const model = testSteps({ validation: { nile_delta: validation }, summary: null, regions: REGIONS, shipped: "model_v1" });
    const errors = model.steps.flatMap((step) => step.regions[0].years.map((year) => Math.abs(year.errorPct)));
    assert.equal(errors.length, 8);
    assert.equal(errors.reduce((sum, e) => sum + e, 0) / 8, (10 + 0 + 5 + 5 + 0 + 0 + 60 + 20) / 8);
  });

  it("reads the decision from the summary, with each region's average against the limits", () => {
    const model = testSteps({ validation: { nile_delta: validation }, summary: validationSummary, regions: REGIONS, shipped: "model_v1" });
    const decision = model.steps.at(-1);
    assert.deepEqual(decision.regions.map((row) => row.regionId), REGIONS.map((region) => region.id));
    for (const row of decision.regions) {
      const source = validationSummary.lyo_2012_2019.find((r) => r.region_id === row.regionId);
      assert.equal(row.errorPct, source.annual_error_pct.model);
      assert.equal(row.passes, source.annual_error_pct.model <= 15 && source.monthly_r.model >= 0.9);
    }
    assert.equal(decision.passed, validationSummary.decision.passed_regions);
    const text = stepText(decision);
    assert.equal(text.title, "The decision");
    assert.match(text.text, /in 3 of 4 regions\. Without the fix, raw VIIRS was off by \d+% to \d+%\. The detection model passed in 3 of 4 regions and beat the simpler ratio method, so the app uses it\.$/);
  });

  it("words a ratio decision and a run with no model", () => {
    const ratioSummary = { ...validationSummary, decision: { ...validationSummary.decision, method: "ratio_v1" } };
    const ratio = testSteps({ validation: {}, summary: ratioSummary, regions: REGIONS, shipped: "ratio_v1" });
    assert.match(stepText(ratio.steps[0]).text, /did not pass the rule, so the app uses the simpler ratio method\.$/);
    const noModel = structuredClone(ratioSummary);
    for (const row of noModel.lyo_2012_2019) {
      row.annual_error_pct.model = null;
      row.monthly_r.model = null;
    }
    assert.match(stepText(testSteps({ validation: {}, summary: noModel, regions: REGIONS, shipped: "ratio_v1" }).steps[0]).text, /No detection model was tested/);
    assert.equal(testSteps({ validation: {}, summary: null, regions: REGIONS, shipped: "model_v1" }), null);
  });

  it("titles each test, marks the hidden years and says the results in words", () => {
    const model = testSteps({ validation: { nile_delta: validation }, summary: validationSummary, regions: REGIONS, shipped: "model_v1" });
    assert.deepEqual(stepText(model.steps[0]), {
      title: "Test 1 of 4: 2012 and 2013 hidden",
      text: "We learn from the other six years, then predict the hidden two and compare with what MODIS really counted.",
    });
    const blocks = yearBlocksHtml(model, model.steps[2]);
    assert.equal((blocks.match(/yr-hidden/g) ?? []).length, 2);
    assert.equal((blocks.match(/yr-learn/g) ?? []).length, 6);
    assert.ok(blocks.includes("<span>2016</span><span class=\"visually-hidden\">, hidden, then predicted</span>"));
    assert.equal((yearBlocksHtml(model, model.steps[4]).match(/yr-tested/g) ?? []).length, 8);
    assert.equal(describeStep(model.steps[0]), "Nile Delta, Egypt: 2012 10% below MODIS, 2013 less than 1% off.");
    assert.equal(missText(37.2), "37% above MODIS");
    assert.equal(missText(-1.7), "2% below MODIS");
    assert.equal(missText(null), "no number");
  });

  it("draws the bars on a ±40% scale, clipped with a tip beyond it, inside the width", () => {
    const model = testSteps({ validation: { nile_delta: validation }, summary: validationSummary, regions: REGIONS, shipped: "model_v1" });
    for (const width of [312, 640]) {
      const test = testSvg(model.steps[3], { width });
      assert.equal((test.match(/<rect class="ts-over"/g) ?? []).length, 2);
      assert.equal((test.match(/<path class="ts-over"/g) ?? []).length, 1, "the 60% bar is clipped at 40% with a tip");
      assert.ok(test.includes("60% above MODIS") && test.includes("20% above MODIS"));
      assert.ok(textOverflow(test, width) <= 0, `${width}: test ${textOverflow(test, width)}`);
      const decision = testSvg(model.steps[4], { width });
      assert.equal((decision.match(/<rect class="ts-ours"/g) ?? []).length, 4);
      assert.equal((decision.match(/<rect class="ts-over"/g) ?? []).length, 4);
      assert.ok(textOverflow(decision.replace(/<text class="dg-label"[^>]*>[^<]*<\/text>/g, ""), width) <= 0, `${width}: decision`);
    }
    const svg = testSvg(model.steps[3], { width: 640 });
    const [, zero] = /<path class="ts-zero" d="M([\d.]+) /.exec(svg);
    const [, tipX] = /<path class="ts-over" d="M([\d.]+) /.exec(svg);
    const [, barX, barW] = /<rect class="ts-over" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/.exec(svg);
    assert.equal(Number(barX), Number(zero));
    assert.equal(Number(barX) + Number(barW), Number(tipX));
    const under = testSvg(model.steps[0], { width: 640 });
    assert.equal((under.match(/<rect class="ts-under"/g) ?? []).length, 1);
    assert.ok(Number(/<rect class="ts-under" x="([\d.]+)"/.exec(under)[1]) < Number(zero));
  });
});

describe("diagrams on the page", () => {
  const echartsStub = () => {
    globalThis.echarts = { init: () => ({ setOption() {}, resize() {} }) };
  };
  const ids = (doc, id) => doc.getElementById(id);
  const fire = (element, type, props = {}) => element.dispatchEvent({ type, ...props });

  it("draws all five on the fixture and answers the controls", async (t) => {
    echartsStub();
    try {
      const body = await bodyFrom(fixtureDir());
      const doc = parseHtml(HTML);
      t.mock.timers.enable({ apis: ["setInterval"] });
      const { diagrams } = renderMethodPage(body, /** @type {any} */ (doc));

      assert.equal(doc.querySelectorAll("#timeline button").length, 7);
      const terra = doc.querySelectorAll("#timeline .tl-bar")[0];
      fire(ids(doc, "timeline"), "focusin", { target: terra });
      assert.match(ids(doc, "timeline-info").textContent, /^Terra \(MODIS\), November 2000 to today\./);

      assert.equal(ids(doc, "cameras-counts").textContent, "MODIS sees 2 · VIIRS sees 6");
      const strength = ids(doc, "cameras-strength");
      strength.value = "0.5";
      fire(strength, "input");
      assert.equal(ids(doc, "cameras-counts").textContent, "MODIS sees 0 · VIIRS sees 2");
      assert.equal(strength.getAttribute("aria-valuetext"), "3.2 MW: MODIS sees 0 · VIIRS sees 2");
      assert.ok(ids(doc, "cameras-modis").querySelector("svg"));

      assert.equal(doc.querySelectorAll("#counted-region option").length, 4);
      assert.equal(doc.querySelector("#counted-month option[selected]").getAttribute("value"), "11");
      const before = ids(doc, "counted-eq").textContent;
      assert.match(before, /Counts as [\d.]+ of a MODIS detection/);
      const region = ids(doc, "counted-region");
      region.value = "california";
      fire(region, "change");
      assert.match(ids(doc, "counted-eq").textContent, /factor for California and Nevada in November/);
      const slider = ids(doc, "counted-strength");
      slider.value = "2";
      fire(slider, "input");
      assert.equal(ids(doc, "counted-strength-value").textContent, "100 MW");
      assert.match(ids(doc, "counted-chance").textContent, /^MODIS would have seen a fire like this about \d+% of the time\.$/);
      assert.ok(ids(doc, "counted-note").hidden);

      assert.equal(doc.querySelector('[data-fill="downloaded"]').textContent, "13 million");

      assert.equal(ids(doc, "test-title").textContent, "Test 1 of 4: 2012 and 2013 hidden");
      assert.ok(ids(doc, "test-back").disabled);
      ids(doc, "test-next").click();
      assert.equal(ids(doc, "test-title").textContent, "Test 2 of 4: 2014 and 2015 hidden");
      assert.ok(!ids(doc, "test-back").disabled);
      ids(doc, "test-play").click();
      assert.equal(ids(doc, "test-play").textContent, "Pause");
      t.mock.timers.tick(STEP_MS * 3);
      assert.equal(ids(doc, "test-title").textContent, "The decision");
      assert.equal(ids(doc, "test-play").textContent, "Play");
      assert.ok(ids(doc, "test-next").disabled);
      assert.equal(diagrams.player.playing, false);
      assert.equal(doc.querySelectorAll("#test-blocks .yr-tested").length, 8);
      ids(doc, "test-play").click();
      assert.equal(ids(doc, "test-title").textContent, "Test 1 of 4: 2012 and 2013 hidden");
      ids(doc, "test-back").click();
      assert.equal(diagrams.player.playing, false);

      assert.deepEqual(checkDocument(doc), []);
    } finally {
      delete globalThis.echarts;
    }
  });

  it("shows the curve without a factor on the mocks, and no slider under the ratio method", async () => {
    echartsStub();
    try {
      const mockDoc = parseHtml(HTML);
      renderMethodPage(await bodyFrom(emptyDir()), /** @type {any} */ (mockDoc));
      assert.ok(mockDoc.getElementById("counted-curve").querySelector("svg"));
      assert.ok(!mockDoc.getElementById("counted-note").hidden);
      assert.match(mockDoc.getElementById("counted-note").textContent, /mocks have none/);
      assert.match(mockDoc.getElementById("counted-eq").textContent, /Not known yet/);
      assert.equal(mockDoc.getElementById("counted-strength").getAttribute("min"), String(Math.log10(0.5)));
      assert.ok(!mockDoc.getElementById("weights").querySelector('[data-mock="detection"]').hidden);

      const body = await bodyFrom(fixtureDir());
      const ratioDoc = parseHtml(HTML);
      renderMethodPage({ ...body, method: { ...body.method, weight_method: "ratio_v1" }, detection_curve: null }, /** @type {any} */ (ratioDoc));
      assert.ok(ratioDoc.getElementById("counted-strength-row").hidden);
      assert.ok(ratioDoc.getElementById("counted-curve").hidden);
      assert.match(ratioDoc.getElementById("counted-chance").textContent, /ratio method/);
      assert.match(ratioDoc.getElementById("counted-eq").textContent, /Counts as [\d.]+ of a MODIS detection/);
      assert.deepEqual(checkDocument(ratioDoc), []);
    } finally {
      delete globalThis.echarts;
    }
  });

  it("still draws the timeline, cameras and widgets when the results do not load", () => {
    const doc = parseHtml(HTML);
    mountDiagrams(null, /** @type {any} */ (doc));
    assert.equal(doc.querySelectorAll("#timeline button").length, 7);
    assert.ok(doc.getElementById("cameras-viirs").querySelector("svg"));
    assert.ok(doc.getElementById("day-map").querySelector("svg"));
    assert.match(doc.getElementById("counted-eq").textContent, /did not load/);
    assert.match(doc.getElementById("test-bars").textContent, /did not load/);
    assert.ok(doc.getElementById("test-controls").hidden);
  });

  it("preloads every diagram module", () => {
    for (const module of ["diagrams-dom.js", "diagrams.js", "facts.js"]) assert.ok(HTML.includes(`<link rel="modulepreload" href="/js/method/${module}">`), module);
    assert.ok(HTML.includes('<link rel="modulepreload" href="/js/map/point-info.js">'));
  });
});
