import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  contrastRatio,
  deltaE2000,
  markColor,
  rampColor,
  simulateCvd,
  toLab,
} from "../public/js/calendar/color.js";
import { createCalendar } from "../public/js/calendar/index.js";
import { buildOption, cellShapes, hatchSegments, stripeSegments } from "../public/js/calendar/option.js";
import { CALENDAR_PALETTE as P } from "../public/js/calendar/palette.js";
import {
  MONTH_LONG,
  VIEWS,
  anomalyLimit,
  anomalyPosition,
  anomalyTicks,
  buildCalendar,
  columnMonths,
  describeCalendar,
  logBounds,
  logPosition,
  logTicks,
  monthColumn,
  rowLabel,
  rowYear,
  seasonRuns,
  seasonText,
  tooltipLines,
} from "../public/js/calendar/transform.js";
import nileHarmonized from "../mocks/calendar-nile_delta-harmonized.json" with { type: "json" };
import nileRaw from "../mocks/calendar-nile_delta-raw.json" with { type: "json" };
import seHarmonized from "../mocks/calendar-se_australia-harmonized.json" with { type: "json" };

const MOCKS = [
  ["calendar-nile_delta-harmonized", nileHarmonized],
  ["calendar-nile_delta-raw", nileRaw],
  ["calendar-se_australia-harmonized", seHarmonized],
];

const month = (year, m, fields = {}) => ({
  year,
  month: m,
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
  ...fields,
});

const response = (months, extra = {}) => ({
  ...structuredClone(nileHarmonized),
  months,
  fire_season: [],
  ...extra,
});

const cellAt = (panel, year, m) => panel.cells.find((cell) => cell.year === year && cell.month === m);
const ym = (cell) => cell.year * 100 + cell.month;

describe("July start", () => {
  it("orders the columns January to December, or July to June", () => {
    assert.deepEqual(columnMonths(false), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.deepEqual(columnMonths(true), [7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6]);
    for (const julyStart of [false, true]) {
      columnMonths(julyStart).forEach((m, col) => assert.equal(monthColumn(m, julyStart), col));
    }
  });

  it("puts January to June in the row of the season that began the July before", () => {
    assert.equal(rowYear(2001, 3, true), 2000);
    assert.equal(rowYear(2000, 7, true), 2000);
    assert.equal(rowYear(2000, 12, true), 2000);
    assert.equal(rowYear(2001, 3, false), 2001);
    assert.equal(rowLabel(2000, true), "2000–01");
    assert.equal(rowLabel(2099, true), "2099–00");
    assert.equal(rowLabel(2000, false), "2000");
  });

  it("gives calendar rows 2000 to 2026, with January to October 2000 as no data and no future months", () => {
    const model = buildCalendar(nileHarmonized, { view: "harmonized" });
    assert.equal(model.rows[0].label, "2000");
    assert.equal(model.rows.at(-1).label, "2026");
    assert.equal(model.rows.length, 27);
    const [panel] = model.panels;
    assert.equal(panel.cells.length, 27 * 12 - 1);
    for (let m = 1; m <= 10; m += 1) assert.equal(cellAt(panel, 2000, m).kind, "no_data");
    assert.equal(cellAt(panel, 2000, 11).value, 93);
    assert.equal(cellAt(panel, 2026, 12), undefined);
  });

  it("gives July-to-June rows 2000–01 to 2026–27 and moves every month to its season", () => {
    const model = buildCalendar(nileHarmonized, { view: "harmonized", julyStart: true });
    assert.equal(model.rows[0].label, "2000–01");
    assert.equal(model.rows.at(-1).label, "2026–27");
    assert.deepEqual(
      model.columns.map((c) => c.label),
      ["Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun"],
    );
    const [panel] = model.panels;
    assert.equal(panel.cells.length, 26 * 12 + 5);
    const march2001 = cellAt(panel, 2001, 3);
    assert.deepEqual([march2001.row, march2001.col], [0, 8]);
    assert.equal(march2001.value, nileHarmonized.months.find((m) => m.year === 2001 && m.month === 3).value);
    for (const m of [7, 8, 9, 10]) assert.equal(cellAt(panel, 2000, m).kind, "no_data");
    const last = panel.cells.at(-1);
    assert.deepEqual([last.year, last.month, last.row, last.col], [2026, 11, 26, 4]);
  });

  it("places every response month exactly once in both layouts", () => {
    const expected = nileHarmonized.months.map((m) => m.year * 100 + m.month).sort();
    for (const julyStart of [false, true]) {
      const [panel] = buildCalendar(nileHarmonized, { julyStart }).panels;
      const placed = panel.cells.filter((cell) => cell.source).map(ym).sort();
      assert.deepEqual(placed, expected);
      const positions = new Set(panel.cells.map((cell) => `${cell.row},${cell.col}`));
      assert.equal(positions.size, panel.cells.length);
    }
  });
});

describe("NULL handling", () => {
  const months = [
    month(2000, 11, { value: 5, modis_raw: 5, anomaly_log2: 0.5, median: 3, difference: 2 }),
    month(2000, 12, { value: 0, modis_raw: 0, median: 0.4, difference: -0.4 }),
    month(2001, 1, { value: null, modis_raw: null }),
    month(2001, 3, { value: 2, modis_raw: 2, median: 0.2, difference: 1.8 }),
    month(2001, 4, {
      value: 3,
      modis_raw: 1,
      viirs_raw: 9,
      anomaly_log2: 1,
      median: 1,
      difference: 2,
      provisional: true,
      partial_coverage: true,
    }),
    month(2001, 5),
    month(2001, 6),
  ];
  const synthetic = response(months);

  it("keeps NULL, zero, missing and positive months apart in the harmonized view", () => {
    const [panel] = buildCalendar(synthetic, { view: "harmonized" }).panels;
    assert.equal(cellAt(panel, 2000, 11).kind, "value");
    assert.equal(cellAt(panel, 2000, 12).kind, "zero");
    assert.equal(cellAt(panel, 2000, 12).color, P.zero);
    assert.equal(cellAt(panel, 2001, 1).kind, "no_data");
    assert.equal(cellAt(panel, 2001, 2).kind, "no_data");
    assert.equal(cellAt(panel, 2001, 2).source, null);
    assert.equal(cellAt(panel, 2001, 4).kind, "value");
    assert.notEqual(cellAt(panel, 2001, 4).color, cellAt(panel, 2000, 11).color);
  });

  it("does not grow the grid for NULL months padded after the last month with data", () => {
    const [panel] = buildCalendar(synthetic).panels;
    assert.equal(panel.cells.at(-1).month, 4);
    assert.equal(cellAt(panel, 2001, 5), undefined);
  });

  it("shows NULL anomalies as not enough history and NULL values as no data in the anomaly view", () => {
    const [panel] = buildCalendar(synthetic, { view: "anomaly" }).panels;
    assert.equal(cellAt(panel, 2000, 11).kind, "value");
    assert.equal(cellAt(panel, 2000, 12).kind, "no_history");
    assert.equal(cellAt(panel, 2001, 3).kind, "no_history");
    assert.equal(cellAt(panel, 2001, 1).kind, "no_data");
    assert.equal(cellAt(panel, 2001, 2).kind, "no_data");
  });

  it("splits the raw view into MODIS and VIIRS, each with its own NULLs", () => {
    const model = buildCalendar(synthetic, { view: "raw" });
    assert.deepEqual(model.panels.map((p) => p.id), ["modis", "viirs"]);
    const [modis, viirs] = model.panels;
    assert.equal(cellAt(modis, 2000, 12).kind, "zero");
    assert.equal(cellAt(viirs, 2000, 12).kind, "no_data");
    assert.equal(cellAt(viirs, 2001, 4).value, 9);
    assert.equal(modis.cells.length, viirs.cells.length);
  });

  it("carries the provisional and partial-coverage flags only from response months", () => {
    const [panel] = buildCalendar(synthetic).panels;
    assert.equal(cellAt(panel, 2001, 4).provisional, true);
    assert.equal(cellAt(panel, 2001, 4).partial, true);
    assert.equal(cellAt(panel, 2001, 2).provisional, false);
    assert.equal(cellAt(panel, 2001, 2).partial, false);
  });

  it("draws a raw response as no data, without a color scale, in the harmonized and anomaly views", () => {
    for (const view of ["harmonized", "anomaly"]) {
      const model = buildCalendar(nileRaw, { view });
      assert.equal(model.scale, null);
      assert.ok(model.panels[0].cells.every((cell) => cell.kind === "no_data"));
    }
  });

  it("handles a response without months", () => {
    const model = buildCalendar(response([]), { view: "raw" });
    assert.equal(model.rows.length, 0);
    assert.equal(model.scale, null);
    assert.match(describeCalendar(model), /no months/);
    const { height } = buildOption(model, { width: 600 });
    assert.ok(height > 0);
  });

  it("rejects an unknown view", () => {
    assert.throws(() => buildCalendar(nileHarmonized, { view: "linear" }), RangeError);
  });

  it("writes the tooltip from the numbers, with dashes and notes for NULLs", () => {
    const model = buildCalendar(nileHarmonized, { view: "anomaly" });
    const [panel] = model.panels;
    const ranked = panel.cells.find((cell) => cell.source?.rank != null && cell.source.anomaly_log2 != null);
    const lines = tooltipLines(ranked, model, panel.id);
    assert.equal(lines[0], `${MONTH_LONG[ranked.month - 1]} ${ranked.year}`);
    assert.ok(lines.includes(`Rank ${ranked.source.rank} of ${ranked.source.of_years}`));
    assert.ok(lines.some((line) => line.startsWith("Value: ") && line.endsWith("MODIS-equivalent hotspots")));
    assert.ok(lines.some((line) => line.startsWith("Median 2003–2025: ")));
    assert.ok(lines.some((line) => line.startsWith("Difference: ")));
    assert.ok(lines.some((line) => line.startsWith("Anomaly: ") && line.includes("× the median")));

    const early = tooltipLines(cellAt(panel, 2001, 1), model, panel.id);
    assert.ok(early.includes("Rank: not ranked before 2003"));
    const history = tooltipLines(panel.cells.find((cell) => cell.kind === "no_history"), model, panel.id);
    assert.ok(history.includes("Anomaly: not enough history (median below 1)"));
    assert.deepEqual(tooltipLines(cellAt(panel, 2000, 1), model, panel.id), [
      "January 2000",
      "No data: the record starts in November 2000",
    ]);
    const latest = tooltipLines(panel.cells.at(-1), model, panel.id);
    assert.ok(latest.some((line) => line.startsWith("Provisional")));
    assert.ok(latest.some((line) => line.startsWith("Partial coverage")));

    const synth = buildCalendar(synthetic, { view: "harmonized" });
    const noMedian = tooltipLines(cellAt(synth.panels[0], 2001, 3), synth, "harmonized");
    assert.ok(noMedian.includes("Difference: +1.8"));
    assert.ok(noMedian.includes("Rank: not ranked before 2003"));
  });

  it("shows both raw counts in the raw view and skips the NULL analytics of a raw response", () => {
    const model = buildCalendar(nileRaw, { view: "raw" });
    const [modis, viirs] = model.panels;
    const lines = tooltipLines(cellAt(viirs, 2001, 5), model, "viirs");
    assert.ok(lines.some((line) => line.startsWith("MODIS raw: ") && line.endsWith("hotspots")));
    assert.ok(lines.some((line) => line.startsWith("VIIRS raw: no data")));
    assert.ok(!lines.some((line) => line.startsWith("Median")));
    assert.ok(tooltipLines(cellAt(modis, 2020, 5), model, "modis").some((line) => /^VIIRS raw: [\d,]+ hotspots$/.test(line)));
  });
});

describe("log scale", () => {
  it("bounds the scale by the smallest and largest positive values", () => {
    assert.deepEqual(logBounds([0, null, undefined, Number.NaN, -1, 0.1, 321.8, 4]), { min: 0.1, max: 321.8 });
    assert.equal(logBounds([0, null, 0]), null);
    assert.equal(logBounds([]), null);
  });

  it("widens a range narrower than a decade evenly around its middle", () => {
    const { min, max } = logBounds([5]);
    assert.ok(Math.abs(max / min - 10) < 1e-9);
    assert.ok(Math.abs(Math.sqrt(min * max) - 5) < 1e-9);
    const narrow = logBounds([4, 16]);
    assert.ok(Math.abs(narrow.max / narrow.min - 10) < 1e-9);
    assert.ok(Math.abs(Math.sqrt(narrow.min * narrow.max) - 8) < 1e-9);
  });

  it("spans at most four decades below the maximum", () => {
    assert.deepEqual(logBounds([0.00001, 1000]), { min: 0.1, max: 1000 });
  });

  it("maps the bounds to the ends of the ramp and clamps outside them", () => {
    const bounds = { min: 0.1, max: 1000 };
    assert.equal(logPosition(0.1, bounds), 0);
    assert.equal(logPosition(1000, bounds), 1);
    assert.equal(logPosition(10, bounds), 0.5);
    assert.equal(logPosition(0.001, bounds), 0);
    assert.equal(logPosition(1e6, bounds), 1);
  });

  it("labels decades when three fit, and 1-2-5 steps otherwise", () => {
    assert.deepEqual(logTicks({ min: 0.1, max: 321.8 }).map((t) => t.label), ["0.1", "1", "10", "100"]);
    assert.deepEqual(logTicks({ min: 1, max: 3618 }).map((t) => t.label), ["1", "10", "100", "1,000"]);
    assert.deepEqual(logTicks({ min: 3, max: 25 }).map((t) => t.value), [5, 10, 20]);
    for (const bounds of [{ min: 0.3, max: 1149.6 }, { min: 3, max: 25 }, logBounds([7])]) {
      const ts = logTicks(bounds).map((t) => t.t);
      assert.ok(ts.length >= 2);
      assert.ok(ts.every((t, i) => t >= 0 && t <= 1 && (i === 0 || t > ts[i - 1])));
    }
  });

  it("colors the mock's extremes with the ends of viridis", () => {
    const model = buildCalendar(nileHarmonized, { view: "harmonized" });
    const values = model.panels[0].cells.filter((c) => c.kind === "value");
    const top = values.reduce((a, b) => (b.value > a.value ? b : a));
    const bottom = values.reduce((a, b) => (b.value < a.value ? b : a));
    assert.deepEqual([model.scale.min, model.scale.max], [0.1, 321.8]);
    assert.equal(top.color, P.sequential.at(-1));
    assert.equal(bottom.color, P.sequential[0]);
  });

  it("puts MODIS and VIIRS on one shared scale in the raw view", () => {
    const model = buildCalendar(nileHarmonized, { view: "raw" });
    const counts = nileHarmonized.months.flatMap((m) => [m.modis_raw, m.viirs_raw]).filter((v) => v > 0);
    assert.equal(model.scale.max, Math.max(...counts));
    assert.equal(model.scale.min, Math.min(...counts));
    for (const panel of model.panels) {
      for (const cell of panel.cells.filter((c) => c.kind === "value")) {
        assert.equal(cell.color, rampColor(P.sequential, logPosition(cell.value, model.scale)));
      }
    }
  });
});

describe("anomaly scale", () => {
  it("rounds the largest absolute anomaly up to a whole log2 step between 1 and 4", () => {
    assert.equal(anomalyLimit([]), 1);
    assert.equal(anomalyLimit([0.2, null]), 1);
    assert.equal(anomalyLimit([2]), 2);
    assert.equal(anomalyLimit([2.12, -1.95]), 3);
    assert.equal(anomalyLimit([-4.8]), 4);
    assert.equal(buildCalendar(seHarmonized, { view: "anomaly" }).scale.limit, 4);
  });

  it("centers the ramp on zero", () => {
    assert.equal(anomalyPosition(0, 3), 0.5);
    assert.equal(anomalyPosition(-3, 3), 0);
    assert.equal(anomalyPosition(9, 3), 1);
    assert.equal(rampColor(P.diverging, anomalyPosition(0, 2)), P.diverging[(P.diverging.length - 1) / 2]);
  });

  it("labels ticks as multiples of the median", () => {
    assert.deepEqual(anomalyTicks(3).map((t) => t.label), ["1/8×", "1/4×", "1/2×", "median", "2×", "4×", "8×"]);
    assert.deepEqual(anomalyTicks(4).map((t) => t.label), ["1/16×", "1/4×", "median", "4×", "16×"]);
  });
});

describe("fire-season band", () => {
  it("covers adjacent month columns, splitting a December-to-January season only without a July start", () => {
    assert.deepEqual(seasonRuns([10, 11], false), [{ from: 9, to: 10 }]);
    assert.deepEqual(seasonRuns([10, 11], true), [{ from: 3, to: 4 }]);
    assert.deepEqual(seasonRuns([1, 2, 12], false), [{ from: 0, to: 1 }, { from: 11, to: 11 }]);
    assert.deepEqual(seasonRuns([1, 2, 12], true), [{ from: 5, to: 7 }]);
    assert.deepEqual(seasonRuns([6, 7], true), [{ from: 0, to: 0 }, { from: 11, to: 11 }]);
    assert.deepEqual(seasonRuns([], false), []);
    assert.deepEqual(seasonRuns([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], true), [{ from: 0, to: 11 }]);
  });

  it("names the season, wrapping December to January", () => {
    assert.equal(seasonText([10, 11]), "Oct–Nov");
    assert.equal(seasonText([1, 2, 12]), "Dec–Feb");
    assert.equal(seasonText([3, 7]), "Mar, Jul");
    assert.equal(seasonText([]), "");
    assert.equal(seasonText([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), "all year");
  });

  it("comes from the response's fire_season", () => {
    assert.deepEqual(buildCalendar(seHarmonized, { julyStart: true }).seasonRuns, [{ from: 5, to: 7 }]);
    assert.deepEqual(buildCalendar(nileRaw, { view: "raw" }).seasonRuns, []);
  });
});

describe("cell marks", () => {
  it("clips the provisional hatching to the cell", () => {
    const [x, y, w, h] = [10, 20, 40, 15];
    const segments = hatchSegments(x, y, w, h, 5);
    assert.ok(segments.length >= 8);
    for (const [x1, y1, x2, y2] of segments) {
      for (const [px, py] of [[x1, y1], [x2, y2]]) {
        assert.ok(px >= x - 1e-9 && px <= x + w + 1e-9 && py >= y - 1e-9 && py <= y + h + 1e-9);
      }
      assert.ok(Math.abs(x1 + y1 - (x2 + y2)) < 1e-9);
      assert.ok(x2 > x1);
    }
    assert.equal(stripeSegments(0, 0, 10, 10, 3).length, 3);
  });

  it("draws hatching, stripes and dots only where the flags and kinds call for them", () => {
    const types = (cell) => cellShapes({ provisional: false, partial: false, color: "#21918c", kind: "value", ...cell }, 0, 0, 40, 15).map((s) => s.type);
    assert.deepEqual(types({}), ["rect"]);
    assert.ok(types({ provisional: true }).filter((t) => t === "line").length > 3);
    assert.deepEqual(types({ partial: true }), ["rect", "circle"]);
    assert.ok(types({ kind: "no_history", color: P.noHistory.fill }).includes("line"));
    assert.deepEqual(types({ kind: "no_data", provisional: true, partial: true }), ["rect"]);
  });

  it("picks black marks on light fills and white marks on dark ones", () => {
    assert.equal(markColor(P.sequential.at(-1)), "#000000");
    assert.equal(markColor(P.sequential[0]), "#ffffff");
    assert.equal(markColor(P.zero), "#000000");
  });
});

describe("palette", () => {
  const KINDS = ["normal", "deuteranopia", "protanopia", "tritanopia"];
  const sim = (hex, kind) => (kind === "normal" ? hex : simulateCvd(hex, kind));
  const samples = (stops, n) => Array.from({ length: n }, (_, i) => rampColor(stops, i / (n - 1)));
  const viridis = samples(P.sequential, 101);
  const fills = [...viridis, ...samples(P.diverging, 101), P.zero, P.noData.fill, P.noHistory.fill];
  const fixed = (v, digits = 2) => v.toFixed(digits);
  // Simulated colors are rounded to 8-bit hex, which moves L* by up to about 0.2.
  const L_TOLERANCE = 0.3;

  it("meets WCAG contrast for text and marks", (t) => {
    const text = contrastRatio(P.text, P.background);
    const muted = contrastRatio(P.muted, P.background);
    const outline = contrastRatio(P.noData.stroke, P.background);
    const stripes = contrastRatio(P.noHistory.stroke, P.noHistory.fill);
    const band = contrastRatio(P.season, P.background);
    const marks = Math.min(...fills.map((fill) => contrastRatio(markColor(fill, P.marksDark, P.marksLight), fill)));
    t.diagnostic(
      `contrast: text ${fixed(text)}, muted text ${fixed(muted)}, no-data outline ${fixed(outline)}, ` +
        `history stripes ${fixed(stripes)}, season band ${fixed(band)}, hatch/dot marks min ${fixed(marks)}, ` +
        `zero gray vs background ${fixed(contrastRatio(P.zero, P.background))}`,
    );
    assert.ok(text >= 4.5 && muted >= 4.5);
    assert.ok(outline >= 3 && stripes >= 3 && band >= 3);
    assert.ok(marks >= 4.5);
  });

  it("keeps viridis ordered by lightness under normal vision and every simulated dichromacy", (t) => {
    const report = [];
    for (const kind of KINDS) {
      const lightness = viridis.map((hex) => toLab(sim(hex, kind))[0]);
      assert.ok(lightness.every((L, i) => i === 0 || L > lightness[i - 1] - L_TOLERANCE), `${kind}: L* not increasing`);
      const steps = samples(P.sequential, 11);
      const minStep = Math.min(...steps.slice(1).map((hex, i) => deltaE2000(sim(steps[i], kind), sim(hex, kind))));
      report.push(`${kind} L* ${fixed(lightness[0], 1)}→${fixed(lightness.at(-1), 1)}, min ΔE00 between tenths ${fixed(minStep, 1)}`);
      assert.ok(minStep >= 3);
    }
    t.diagnostic(`viridis: ${report.join("; ")}`);
  });

  it("keeps the zero gray and no-data fill apart from every viridis color", (t) => {
    const report = [];
    for (const kind of KINDS) {
      const zero = Math.min(...viridis.map((hex) => deltaE2000(sim(P.zero, kind), sim(hex, kind))));
      const empty = Math.min(...viridis.map((hex) => deltaE2000(sim(P.noData.fill, kind), sim(hex, kind))));
      const zeroVsEmpty = deltaE2000(sim(P.zero, kind), sim(P.noData.fill, kind));
      report.push(`${kind} zero ${fixed(zero, 1)}, no-data fill ${fixed(empty, 1)}, zero vs no-data ${fixed(zeroVsEmpty, 1)}`);
      assert.ok(zero >= (kind === "tritanopia" ? 8 : 15), `${kind}: zero gray too close to viridis`);
      assert.ok(empty >= 8);
    }
    t.diagnostic(`min ΔE00 to viridis: ${report.join("; ")}`);
  });

  it("keeps blue and orange anomalies of the same size apart under every simulated dichromacy", (t) => {
    const report = [];
    for (const kind of KINDS) {
      const pairs = [0.25, 0.5, 0.75, 1].map((size) =>
        deltaE2000(sim(rampColor(P.diverging, 0.5 - size / 2), kind), sim(rampColor(P.diverging, 0.5 + size / 2), kind)),
      );
      const half = samples(P.diverging, 101);
      const lightness = half.map((hex) => toLab(sim(hex, kind))[0]);
      const towardCenter =
        lightness.slice(0, 51).every((L, i) => i === 0 || L > lightness[i - 1] - L_TOLERANCE) &&
        lightness.slice(50).every((L, i) => i === 0 || L < lightness[50 + i - 1] + L_TOLERANCE);
      report.push(`${kind} ΔE00 at ±1/4,±1/2,±3/4,±1 of the limit ${pairs.map((d) => fixed(d, 1)).join("/")}`);
      assert.ok(towardCenter, `${kind}: lightness not peaking at the center`);
      assert.ok(Math.min(...pairs) >= 20, `${kind}: blue and orange too close`);
    }
    t.diagnostic(`diverging: ${report.join("; ")}`);
  });
});

function loadEcharts() {
  const source = readFileSync(new URL("../public/vendor/echarts.min.js", import.meta.url), "utf8");
  const module = { exports: {} };
  new Function("module", "exports", source)(module, module.exports);
  return module.exports;
}

describe("ECharts render (server-side SVG)", () => {
  const echarts = loadEcharts();
  const LEGEND = ["No data", "Provisional (near-real-time)", "Partial coverage"];

  for (const [name, mock] of MOCKS) {
    for (const view of VIEWS) {
      for (const julyStart of [false, true]) {
        it(`renders ${name} in the ${view} view${julyStart ? " from July" : ""} with title and legend`, () => {
          const model = buildCalendar(mock, { view, julyStart });
          const title = `Test title ${name} ${view}`;
          const { option, height } = buildOption(model, { width: 760, title });
          const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: 760, height });
          try {
            chart.setOption(option);
            const svg = decodeURIComponent(chart.getDataURL({ type: "svg" }).replace(/^data:image\/svg\+xml;charset=UTF-8,/, ""));
            assert.ok(svg.includes(title));
            for (const label of LEGEND) assert.ok(svg.includes(label), label);
            assert.equal(svg.includes("Fire season"), model.seasonRuns.length > 0);
            if (model.scale) for (const tick of model.scale.ticks) assert.ok(svg.includes(`>${tick.label}<`), tick.label);
            for (const row of [model.rows[0], model.rows.at(-1)]) assert.ok(svg.includes(`>${row.label}<`), row.label);
            const cellCount = model.panels.reduce((sum, panel) => sum + panel.cells.length, 0);
            assert.ok((svg.match(/ecmeta_series_index/g) ?? []).length >= cellCount);
          } finally {
            chart.dispose();
          }
        });
      }
    }
  }

  it("formats tooltips for cells and for the fire-season band", () => {
    const model = buildCalendar(seHarmonized, { view: "harmonized" });
    const { option } = buildOption(model, { width: 760 });
    const cell = option.tooltip.formatter({ seriesId: "cells-0", dataIndex: model.panels[0].cells.length - 1 });
    assert.match(cell, /^<b>November 2026<\/b><br>Value: /);
    assert.match(cell, /Rank 17 of 24/);
    assert.match(cell, /Provisional/);
    const band = option.tooltip.formatter({ seriesId: "season-0", dataIndex: 0 });
    assert.match(band, /Fire season: Dec–Feb/);
  });

  it("describes the chart for screen readers", () => {
    const model = buildCalendar(nileHarmonized, { view: "harmonized" });
    const { option } = buildOption(model, { width: 760 });
    assert.equal(option.aria.enabled, true);
    assert.match(option.aria.label.description, /nile_delta, harmonized view, 2000 to 2026/);
    assert.match(option.aria.label.description, /Fire season: Oct–Nov/);
  });

  it("fits narrow containers", () => {
    const model = buildCalendar(nileHarmonized, { view: "raw", julyStart: true });
    const narrow = buildOption(model, { width: 360 });
    const wide = buildOption(model, { width: 1000 });
    assert.ok(narrow.height >= wide.height);
    assert.deepEqual(narrow.option.xAxis[0].data.slice(0, 2), ["J", "A"]);
  });
});

describe("createCalendar", () => {
  function stubEcharts() {
    const calls = [];
    const chart = {
      setOption: (option, opts) => calls.push(["setOption", option, opts]),
      resize: () => calls.push(["resize"]),
      getDataURL: (opts) => (calls.push(["getDataURL", opts]), "data:image/png;base64,AAAA"),
      dispose: () => calls.push(["dispose"]),
    };
    return { calls, echarts: { init: (container, theme, opts) => (calls.push(["init", opts]), chart) } };
  }

  it("needs the ECharts global", () => {
    assert.throws(() => createCalendar({ clientWidth: 800, style: {} }), /ECharts/);
  });

  it("renders at the container's width, sets its height and exports a PNG", () => {
    const { calls, echarts } = stubEcharts();
    globalThis.echarts = echarts;
    try {
      const container = { clientWidth: 800, style: {} };
      const calendar = createCalendar(container);
      assert.throws(() => calendar.toPng(), /render/);
      calendar.render(nileHarmonized, { view: "raw", julyStart: true, title: "Nile Delta, Egypt" });
      const [, option, opts] = calls.find(([name]) => name === "setOption");
      assert.deepEqual(opts, { notMerge: true });
      assert.equal(option.title.text, "Nile Delta, Egypt");
      assert.equal(option.grid.length, 2);
      assert.equal(option.yAxis[0].data[0], "2000–01");
      const expected = buildOption(buildCalendar(nileHarmonized, { view: "raw", julyStart: true }), { width: 800 }).height;
      assert.equal(container.style.height, `${expected}px`);
      assert.equal(calendar.toPng(), "data:image/png;base64,AAAA");
      assert.equal(calls.find(([name]) => name === "getDataURL")[1].type, "png");
      calendar.dispose();
      assert.equal(calls.at(-1)[0], "dispose");
    } finally {
      delete globalThis.echarts;
    }
  });
});
