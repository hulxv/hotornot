import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baselineMedians, buildMonths, currentMonth, fireSeason } from "../public/shared/analytics.js";
import { checkCalendarResponse, checkCurrentMonthResponse } from "../public/shared/contracts.js";

function* yms(first, last) {
  for (let ym = first; ym <= last; ym = ym % 100 === 12 ? ym + 89 : ym + 1) yield ym;
}

const MONTH_DAYS = (ym) => new Date(Date.UTC(Math.floor(ym / 100), ym % 100, 0)).getUTCDate();

/** `months` rows from 2000-11 to 2026-11, the last month 13 days long. */
function makeFlags({ last = 202611, missing = { 201905: 2, 202611: 3 } } = {}) {
  return [...yms(200011, last)].map((ym) => ({
    ym,
    terra_only: ym < 200207 ? 1 : 0,
    viirs_source: ym >= 201201 ? "SNPP" : null,
    viirs_missing_days: missing[ym] ?? 0,
    provisional: ym > 202606 ? 1 : 0,
    days_covered: ym === last ? 13 : MONTH_DAYS(ym),
  }));
}

/**
 * October: value = year - 2000, except 2010 and 2011 tie at 30.
 * January: 7 every year, 15 in 2020.
 * February: 0, with 5 in 2005, 2015 and 2020, so its median is 0.
 * March 2015: no row at all.
 * Other months: the month number.
 */
function octoberValue(year) {
  return year === 2010 || year === 2011 ? 30 : year - 2000;
}
function harmonizedFor(ym) {
  const year = Math.floor(ym / 100);
  const month = ym % 100;
  if (month === 10) return octoberValue(year);
  if (month === 1) return year === 2020 ? 15 : 7;
  if (month === 2) return [2005, 2015, 2020].includes(year) ? 5 : 0;
  return month;
}
function makeSums(flags) {
  return flags
    .filter(({ ym }) => ym !== 201503)
    .map(({ ym }) => ({
      ym,
      harmonized: harmonizedFor(ym),
      modis_raw: 10 * (ym % 100),
      viirs_raw: ym >= 201201 ? 70 * (ym % 100) : 0,
      points: 0,
    }));
}

const FLAGS = makeFlags();
const SUMS = makeSums(FLAGS);
const MONTHS = buildMonths(SUMS, FLAGS, "harmonized");
const byYm = (months, ym) => months.find((m) => m.year * 100 + m.month === ym);

describe("buildMonths", () => {
  it("returns one entry per covered month, 2000-11 to 2026-11", () => {
    assert.equal(MONTHS.length, 313);
    assert.deepEqual([MONTHS[0].year, MONTHS[0].month], [2000, 11]);
    assert.deepEqual([MONTHS.at(-1).year, MONTHS.at(-1).month], [2026, 11]);
  });

  it("passes the calendar shape check", () => {
    const response = {
      region_id: "nile_delta",
      units: "modis_equivalent_hotspots",
      data_version: "v1",
      weight_method: "ratio_v1",
      clipped_fraction: 0,
      aoi: { cells: 120, covered_cells: 120, area_km2: 3196.5, snapped_fraction: 1 },
      baseline: { start_year: 2003, end_year: 2025 },
      fire_season: fireSeason(baselineMedians(SUMS, FLAGS)),
      months: MONTHS,
    };
    assert.deepEqual(checkCalendarResponse(response), []);
    assert.deepEqual(
      checkCalendarResponse({ ...response, fire_season: [], months: buildMonths(SUMS, FLAGS, "raw") }),
      [],
    );
  });

  it("takes the October median over 2003 to 2025 only", () => {
    // Sorted 2003-2025 Octobers: 3..9, 12..25, 30, 30. The 12th of 23 is 16.
    for (const ym of [200110, 200510, 202510, 202610]) assert.equal(byYm(MONTHS, ym).median, 16);
    const oct2025 = byYm(MONTHS, 202510);
    assert.equal(oct2025.value, 25);
    assert.equal(oct2025.difference, 9);
    assert.equal(oct2025.anomaly_log2, Math.round(Math.log2(26 / 17) * 1e4) / 1e4);
  });

  it("gives tied months the best rank", () => {
    assert.deepEqual(pick(byYm(MONTHS, 201010), "rank", "of_years"), { rank: 1, of_years: 8 });
    assert.deepEqual(pick(byYm(MONTHS, 201110), "rank", "of_years"), { rank: 1, of_years: 9 });
    assert.deepEqual(pick(byYm(MONTHS, 201210), "rank", "of_years"), { rank: 3, of_years: 10 });
    // Every January but 2020 ties at 7.
    assert.deepEqual(pick(byYm(MONTHS, 201901), "rank", "of_years"), { rank: 1, of_years: 17 });
    assert.deepEqual(pick(byYm(MONTHS, 202001), "rank", "of_years"), { rank: 1, of_years: 18 });
    assert.deepEqual(pick(byYm(MONTHS, 202101), "rank", "of_years"), { rank: 2, of_years: 19 });
  });

  it("ranks among 2003 up to the month's own year", () => {
    assert.deepEqual(pick(byYm(MONTHS, 200310), "rank", "of_years"), { rank: 1, of_years: 1 });
    assert.deepEqual(pick(byYm(MONTHS, 200410), "rank", "of_years"), { rank: 1, of_years: 2 });
    assert.deepEqual(pick(byYm(MONTHS, 202510), "rank", "of_years"), { rank: 3, of_years: 23 });
    assert.deepEqual(pick(byYm(MONTHS, 202610), "rank", "of_years"), { rank: 3, of_years: 24 });
  });

  it("leaves rank null before 2003 but keeps the median and anomaly", () => {
    const oct2002 = byYm(MONTHS, 200210);
    assert.deepEqual(pick(oct2002, "value", "median", "difference", "rank", "of_years"), {
      value: 2,
      median: 16,
      difference: -14,
      rank: null,
      of_years: null,
    });
    assert.equal(oct2002.anomaly_log2, Math.round(Math.log2(3 / 17) * 1e4) / 1e4);
    assert.equal(byYm(MONTHS, 200111).rank, null);
    assert.equal(byYm(MONTHS, 200212).of_years, null);
  });

  it("nulls the anomaly, not the difference, when the median is below 1", () => {
    const feb2020 = byYm(MONTHS, 202002);
    assert.deepEqual(pick(feb2020, "value", "median", "anomaly_log2", "difference", "rank"), {
      value: 5,
      median: 0,
      anomaly_log2: null,
      difference: 5,
      rank: 1,
    });
    assert.equal(byYm(MONTHS, 202102).anomaly_log2, null);
  });

  it("computes log2((value + 1) / (median + 1))", () => {
    assert.equal(byYm(MONTHS, 202001).anomaly_log2, 1);
    assert.equal(byYm(MONTHS, 202101).anomaly_log2, 0);
    assert.equal(byYm(MONTHS, 202101).difference, 0);
  });

  it("uses 0 for a covered month without a cells row", () => {
    const mar2015 = byYm(MONTHS, 201503);
    assert.deepEqual(pick(mar2015, "value", "modis_raw", "viirs_raw", "median", "difference"), {
      value: 0,
      modis_raw: 0,
      viirs_raw: 0,
      median: 3,
      difference: -3,
    });
  });

  it("returns nulls for months outside the covered months", () => {
    const months = buildMonths(SUMS, FLAGS, "harmonized", { start: "2000-01", end: "2026-12" });
    assert.equal(months.length, 27 * 12);
    const outside = [...months.slice(0, 10), months.at(-1)];
    for (const m of outside) {
      assert.deepEqual(m, {
        year: m.year,
        month: m.month,
        value: null,
        modis_raw: null,
        viirs_raw: null,
        median: null,
        anomaly_log2: null,
        difference: null,
        rank: null,
        of_years: null,
        provisional: false,
        partial_coverage: false,
      });
    }
    assert.deepEqual([months[10].year, months[10].month, months[10].value], [2000, 11, 11]);
  });

  it("trims to the range but keeps statistics over the whole record", () => {
    const months = buildMonths(SUMS, FLAGS, "harmonized", { start: "2025-01", end: 202512 });
    assert.equal(months.length, 12);
    assert.deepEqual(months[9], byYm(MONTHS, 202510));
  });

  it("fills raw counts, with viirs_raw null before 2012", () => {
    assert.deepEqual(pick(byYm(MONTHS, 201112), "modis_raw", "viirs_raw"), { modis_raw: 120, viirs_raw: null });
    assert.deepEqual(pick(byYm(MONTHS, 201201), "modis_raw", "viirs_raw"), { modis_raw: 10, viirs_raw: 70 });
  });

  it("nulls the value and analytics in raw mode", () => {
    const raw = buildMonths(SUMS, FLAGS, "raw");
    assert.equal(raw.length, 313);
    for (const m of raw) {
      assert.deepEqual(pick(m, "value", "median", "anomaly_log2", "difference", "rank", "of_years"), {
        value: null,
        median: null,
        anomaly_log2: null,
        difference: null,
        rank: null,
        of_years: null,
      });
    }
    assert.deepEqual(pick(byYm(raw, 202510), "modis_raw", "viirs_raw"), { modis_raw: 100, viirs_raw: 700 });
  });

  it("sets provisional and partial_coverage from the month flags", () => {
    const flags = (ym) => pick(byYm(MONTHS, ym), "provisional", "partial_coverage");
    assert.deepEqual(flags(200206), { provisional: false, partial_coverage: true });
    assert.deepEqual(flags(200207), { provisional: false, partial_coverage: false });
    assert.deepEqual(flags(201905), { provisional: false, partial_coverage: true });
    assert.deepEqual(flags(202606), { provisional: false, partial_coverage: false });
    assert.deepEqual(flags(202607), { provisional: true, partial_coverage: false });
    assert.deepEqual(flags(202611), { provisional: true, partial_coverage: true });
  });

  it("removes float noise from summed weights", () => {
    const flags = makeFlags();
    const sums = [{ ym: 202510, harmonized: 0.1 + 0.2, modis_raw: 0, viirs_raw: 0 }];
    const oct = byYm(buildMonths(sums, flags, "harmonized"), 202510);
    assert.equal(oct.value, 0.3);
  });

  it("rejects an unknown mode", () => {
    assert.throws(() => buildMonths(SUMS, FLAGS, "modis"), TypeError);
  });

  it("builds 320 months in under 5 ms", () => {
    const flags = makeFlags({ last: 202706 });
    const sums = makeSums(flags).map((row) => ({ ...row, harmonized: row.harmonized + (row.ym % 7) * 0.37 }));
    assert.equal(flags.length, 320);
    buildMonths(sums, flags, "harmonized");
    const times = [];
    for (let i = 0; i < 21; i += 1) {
      const t0 = performance.now();
      buildMonths(sums, flags, "harmonized");
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    assert.ok(times[10] < 5, `buildMonths took ${times[10].toFixed(2)} ms`);
    console.log(`buildMonths: 320 months, median ${times[10].toFixed(3)} ms`);
  });
});

describe("fireSeason", () => {
  it("picks October and November for Nile Delta medians", () => {
    // Mean of these medians is 401.7 / 12 = 33.475.
    assert.deepEqual(fireSeason([1, 0.5, 0.7, 2.5, 10, 16, 8, 12, 25, 210, 110, 6]), [10, 11]);
  });

  it("wraps a southern season from December to February", () => {
    // Mean 234 / 12 = 19.5.
    assert.deepEqual(fireSeason([60, 40, 14, 13, 12, 3, 2, 3, 6, 12, 14, 55]), [1, 2, 12]);
  });

  it("finds the southern season from monthly sums", () => {
    const flags = makeFlags();
    const sums = flags.map(({ ym }) => ({ ym, harmonized: [80, 50, 6, 4, 3, 1, 0, 1, 2, 5, 9, 70][(ym % 100) - 1] }));
    assert.deepEqual(baselineMedians(sums, flags), [80, 50, 6, 4, 3, 1, 0, 1, 2, 5, 9, 70]);
    assert.deepEqual(fireSeason(baselineMedians(sums, flags)), [1, 2, 12]);
  });

  it("is empty when no month stands out and ignores months without a median", () => {
    assert.deepEqual(fireSeason(Array(12).fill(0)), []);
    assert.deepEqual(fireSeason(Array(12).fill(null)), []);
    assert.deepEqual(fireSeason([null, null, 1, 1, 1, 1, 1, 1, 1, 1, 1, 12]), [12]);
  });

  it("matches the medians buildMonths reports", () => {
    const medians = baselineMedians(SUMS, FLAGS);
    for (let month = 1; month <= 12; month += 1) assert.equal(byYm(MONTHS, 202500 + month).median, medians[month - 1]);
    // January ties at 7, February at 0, October is 16, the rest sit at their month number.
    // Their mean is 88 / 12 = 7.33.
    assert.deepEqual(medians, [7, 0, 3, 4, 5, 6, 7, 8, 9, 16, 11, 12]);
    assert.deepEqual(fireSeason(medians), [8, 9, 10, 11, 12]);
  });
});

describe("currentMonth", () => {
  // November, days 1 to 13 of each year: (year - 2000) / 13 a day, so year - 2000 in total.
  // Days 14 to 30 carry 100 a day and must be ignored. 2026 has only its 13 days, at 0.5.
  const dayTotals = [];
  for (let year = 2000; year <= 2026; year += 1) {
    const days = year === 2026 ? 13 : 30;
    for (let day = 1; day <= days; day += 1) {
      const harmonized = year === 2026 ? 0.5 : day <= 13 ? (year - 2000) / 13 : 100;
      dayTotals.push({ year, day, harmonized });
    }
  }

  it("compares a 13-day month with the same 13 days of earlier years", () => {
    const result = currentMonth(dayTotals, FLAGS);
    // Value 6.5. Median of 3..25 is 14. Of 2003-2026, the 19 years 7..25 are higher.
    assert.deepEqual(result, {
      year: 2026,
      month: 11,
      days_covered: 13,
      value: 6.5,
      median: 14,
      rank: 20,
      of_years: 24,
      provisional: true,
      partial_coverage: true,
      history: Array.from({ length: 24 }, (_, i) => ({ year: 2003 + i, value: i === 23 ? 6.5 : 3 + i })),
    });
    assert.deepEqual(checkCurrentMonthResponse(result), []);
  });

  it("uses a year with no rows as 0", () => {
    const result = currentMonth(
      dayTotals.filter((row) => row.year !== 2026),
      FLAGS,
    );
    assert.deepEqual(pick(result, "value", "rank", "of_years"), { value: 0, rank: 24, of_years: 24 });
  });

  it("skips years before the record starts in that calendar month", () => {
    const flags = makeFlags({ last: 202603, missing: {} });
    const march = [2000, 2001, 2003, 2026].map((year) => ({ year, day: 1, harmonized: 4 }));
    const result = currentMonth(march, flags);
    assert.deepEqual(pick(result, "year", "month", "value", "median", "rank", "of_years", "partial_coverage"), {
      year: 2026,
      month: 3,
      value: 4,
      median: 0,
      rank: 1,
      of_years: 24,
      partial_coverage: false,
    });
  });

  it("agrees with the calendar's last month when it covers the same days", () => {
    const sums = [{ ym: 202611, harmonized: 13 * 0.5, modis_raw: 0, viirs_raw: 0 }];
    assert.equal(buildMonths(sums, FLAGS, "harmonized").at(-1).value, currentMonth(dayTotals, FLAGS).value);
  });
});

function pick(object, ...keys) {
  return Object.fromEntries(keys.map((key) => [key, object[key]]));
}
