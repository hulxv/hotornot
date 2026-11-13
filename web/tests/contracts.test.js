import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_AOI_VERTICES,
  SUMMARY_EXPORT_COLUMNS,
  TILE_COLUMNS,
  checkApiError,
  checkCalendarResponse,
  checkCurrentMonthResponse,
  checkDetectionCurve,
  checkKTable,
  checkLatest,
  checkMeta,
  checkMetadata,
  checkRegionCells,
  checkRegionValidation,
  checkTileRow,
  checkValidationSummary,
  exportFilename,
  validateCalendarRequest,
  validateCurrentMonthRequest,
} from "../public/shared/contracts.js";
import aois from "../mocks/aoi.json" with { type: "json" };
import nileHarmonized from "../mocks/calendar-nile_delta-harmonized.json" with { type: "json" };
import nileRaw from "../mocks/calendar-nile_delta-raw.json" with { type: "json" };
import seHarmonized from "../mocks/calendar-se_australia-harmonized.json" with { type: "json" };
import currentMonth from "../mocks/current-month.json" with { type: "json" };
import detectionCurve from "../mocks/detection_curve.json" with { type: "json" };
import hotspots from "../mocks/hotspots-nile_delta.json" with { type: "json" };
import metadata from "../mocks/metadata.json" with { type: "json" };
import regionCells from "../mocks/region_cells-nile_delta.json" with { type: "json" };
import validationNile from "../mocks/validation-nile_delta.json" with { type: "json" };
import validationSummary from "../mocks/validation_summary.json" with { type: "json" };

const MOCKS = [
  ["metadata.json", checkMetadata, metadata],
  ["calendar-nile_delta-harmonized.json", checkCalendarResponse, nileHarmonized],
  ["calendar-nile_delta-raw.json", checkCalendarResponse, nileRaw],
  ["calendar-se_australia-harmonized.json", checkCalendarResponse, seHarmonized],
  ["current-month.json", checkCurrentMonthResponse, currentMonth],
  ["validation_summary.json", checkValidationSummary, validationSummary],
  ["validation-nile_delta.json", checkRegionValidation, validationNile],
  ["detection_curve.json", checkDetectionCurve, detectionCurve],
  ["region_cells-nile_delta.json", checkRegionCells, regionCells],
  ["hotspots-nile_delta.json", (rows) => rows.flatMap(checkTileRow), hotspots],
];

const clone = (value) => structuredClone(value);

describe("mocks", () => {
  for (const [name, check, data] of MOCKS) {
    it(`${name} passes its shape check`, () => assert.deepEqual(check(data), []));
  }

  it("put the Nile Delta fire season in October and November", () => {
    assert.deepEqual(nileHarmonized.fire_season, [10, 11]);
  });

  it("put the SE Australia fire season across the new year", () => {
    assert.deepEqual(seHarmonized.fire_season, [1, 2, 12]);
  });

  it("run from 2000-11 to 2026-11 with one entry per month", () => {
    for (const calendar of [nileHarmonized, nileRaw, seHarmonized]) {
      const { months } = calendar;
      assert.equal(months.length, 313);
      assert.deepEqual([months[0].year, months[0].month], [2000, 11]);
      assert.deepEqual([months.at(-1).year, months.at(-1).month], [2026, 11]);
    }
  });

  it("leave value and analytics null in raw mode and keep the raw counts", () => {
    for (const m of nileRaw.months) {
      assert.deepEqual([m.value, m.median, m.anomaly_log2, m.difference, m.rank, m.of_years], Array(6).fill(null));
    }
    assert.deepEqual(
      nileRaw.months.map((m) => m.modis_raw),
      nileHarmonized.months.map((m) => m.modis_raw),
    );
  });

  it("cover the null and edge cases the calendar has to draw", () => {
    const { months } = nileHarmonized;
    assert.ok(months.some((m) => m.value === 0), "a zero month");
    assert.ok(months.some((m) => m.median < 1 && m.anomaly_log2 === null), "a median below 1");
    assert.ok(months.filter((m) => m.year < 2003).every((m) => m.rank === null), "no rank before 2003");
    assert.ok(months.some((m) => m.provisional), "a provisional month");
    assert.ok(months.some((m) => m.partial_coverage), "a partial month");
  });

  it("agree between the current month and the calendar's last month", () => {
    const last = nileHarmonized.months.at(-1);
    assert.deepEqual(
      [currentMonth.year, currentMonth.month, currentMonth.value],
      [last.year, last.month, last.value],
    );
  });

  it("describe the AOIs they were built for", () => {
    assert.ok(validateCalendarRequest({ aoi: aois.nile_delta, start: "2000-11", end: "2026-11", series: "raw" }).ok);
    assert.equal(nileHarmonized.aoi.cells, 120);
    assert.equal(seHarmonized.aoi.cells, 780);
  });
});

describe("shape checks", () => {
  it("name the summary columns after the months fields", () => {
    assert.deepEqual(SUMMARY_EXPORT_COLUMNS, Object.keys(nileHarmonized.months[0]));
  });

  it("name the tile row fields after the tile columns", () => {
    assert.deepEqual(Object.keys(hotspots[0]), [...TILE_COLUMNS]);
  });

  it("report missing and unexpected fields with their path", () => {
    const body = clone(metadata);
    delete body.attribution;
    body.regions[0].extra = 1;
    assert.deepEqual(checkMetadata(body), ["metadata.regions[0].extra: unexpected field", "metadata.attribution: missing"]);
  });

  it("reject a rank above of_years", () => {
    const calendar = clone(nileHarmonized);
    Object.assign(calendar.months[100], { rank: 30, of_years: 10 });
    assert.match(checkCalendarResponse(calendar)[0], /^calendar\.months\[100\]: rank and of_years/);
  });

  it("reject a detection curve whose p does not match frp_mw", () => {
    const curve = { frp_mw: [1, 10, 100], curves: [{ land_class: "all", p: [0.1, 0.5] }] };
    assert.equal(checkDetectionCurve(curve).length, 1);
  });

  it("reject dates that do not exist", () => {
    const body = clone(metadata);
    body.regions[0].coverage.nrt_until = "2026-02-30";
    assert.deepEqual(checkMetadata(body), ["metadata.regions[0].coverage.nrt_until: not a real date"]);
  });

  it("accept ratio_v1 artifacts without model numbers", () => {
    const summary = clone(validationSummary);
    summary.decision.method = "ratio_v1";
    summary.lyo_2012_2019[0].annual_error_pct.model = null;
    delete summary.lyo_2012_2019[0].monthly_r.model;
    assert.deepEqual(checkValidationSummary(summary), []);
    const region = { months: [{ ym: 201201, modis: 3, viirs_raw: 20, ratio: 2.8, model: null, fold: "2012-2013" }], n20: [] };
    assert.deepEqual(checkRegionValidation(region), []);
  });

  it("accept an optional drift list in the validation summary", () => {
    const summary = clone(validationSummary);
    summary.drift = [
      { region_id: "nile_delta", year: 2012, modis_snpp_ratio: 0.14 },
      { region_id: "california", year: 2013, modis_snpp_ratio: null },
    ];
    assert.deepEqual(checkValidationSummary(summary), []);
    summary.drift[0].modis_snpp_ratio = -1;
    summary.drift[1].year = "2013";
    assert.equal(checkValidationSummary(summary).length, 2);
  });

  it("check latest.json, errors, the k table and meta keys", () => {
    assert.deepEqual(checkLatest({ version: "v3", published_at: "2026-11-13T18:00:00Z" }), []);
    assert.deepEqual(checkLatest({ version: "v3", published_at: "2026-11-13T18:00:00.123456+00:00" }), []);
    assert.equal(checkLatest({ version: "3", published_at: "2026-11-13" }).length, 2);
    assert.deepEqual(checkApiError({ error: { code: "outside_regions", message: "m", regions: ["nile_delta"] } }), []);
    assert.equal(checkApiError({ error: { code: "teapot", message: "m" } }).length, 1);
    const k = [{ region_id: "nile_delta", month: 10, satellite: "S-NPP", value: 0.14, level: "region_month" }];
    assert.deepEqual(checkKTable(k), []);
    assert.deepEqual(checkMeta("validation:nile_delta", validationNile), []);
    assert.deepEqual(checkMeta("current_month", { year: 2026, month: 11, days_covered: 13 }), []);
    assert.deepEqual(checkMeta("validation:atlantis", {}), ["validation:atlantis: unknown meta key"]);
  });

  it("build export filenames as CONTRACTS spells them", () => {
    assert.equal(exportFilename("summary", "nile_delta", "2000-11", "2026-11"), "hotornot_summary_nile_delta_2000-11_2026-11.csv");
  });
});

describe("request validators", () => {
  const body = { aoi: aois.nile_delta, start: "2000-11", end: "2026-11", series: "harmonized" };
  const ring = aois.nile_delta.coordinates[0];
  const codeOf = (input) => {
    const result = validateCalendarRequest(input);
    return result.ok ? "ok" : result.code;
  };
  const circle = (n) => {
    const points = Array.from({ length: n }, (_, i) => [
      31 + 0.2 * Math.cos((2 * Math.PI * i) / n),
      30.8 + 0.2 * Math.sin((2 * Math.PI * i) / n),
    ]);
    return { type: "Polygon", coordinates: [[...points, points[0]]] };
  };

  it("accept the reference body", () => {
    assert.deepEqual(validateCalendarRequest(body), { ok: true, value: body });
  });

  it("map AOI problems to invalid_aoi", () => {
    assert.equal(codeOf({ ...body, aoi: { type: "Point", coordinates: [31, 30.8] } }), "invalid_aoi");
    assert.equal(codeOf({ ...body, aoi: { type: "Polygon", coordinates: [ring.slice(0, -1)] } }), "invalid_aoi");
    assert.equal(codeOf({ ...body, aoi: { type: "Polygon", coordinates: [ring, ring] } }), "invalid_aoi");
    assert.equal(codeOf({ ...body, aoi: { type: "Polygon", coordinates: [[[31, 95], [31.2, 30], [31.1, 30.2], [31, 95]]] } }), "invalid_aoi");
    assert.equal(codeOf({ ...body, aoi: { type: "Polygon", coordinates: [ring.slice(0, 3)] } }), "invalid_aoi");
    assert.equal(codeOf({ ...body, aoi: undefined }), "invalid_aoi");
    assert.equal(codeOf("not an object"), "invalid_aoi");
    assert.equal(codeOf(null), "invalid_aoi");
  });

  it("allow exactly the vertex limit and refuse one more", () => {
    assert.equal(codeOf({ ...body, aoi: circle(MAX_AOI_VERTICES) }), "ok");
    assert.equal(codeOf({ ...body, aoi: circle(MAX_AOI_VERTICES + 1) }), "too_many_vertices");
  });

  it("map range and series problems to bad_range", () => {
    assert.equal(codeOf({ ...body, start: "2026-11", end: "2000-11" }), "bad_range");
    assert.equal(codeOf({ ...body, start: "2026-13" }), "bad_range");
    assert.equal(codeOf({ ...body, end: undefined }), "bad_range");
    assert.equal(codeOf({ ...body, series: "both" }), "bad_range");
  });

  it("ignore start, end and series for the current month", () => {
    assert.deepEqual(validateCurrentMonthRequest({ aoi: body.aoi, start: "bad", series: 3 }), {
      ok: true,
      value: { aoi: body.aoi },
    });
    assert.equal(validateCurrentMonthRequest({}).code, "invalid_aoi");
  });
});
