// Calendar analytics, computed from the monthly series of one snapped AOI.
import { SERIES, TIME, yearMonthToYm } from "./contracts.js";

/** @typedef {import("./contracts.js").CalendarMonth} CalendarMonth */
/** @typedef {import("./contracts.js").CurrentMonthResponse} CurrentMonthResponse */
/** @typedef {import("./contracts.js").Series} Series */
/**
 * `cells` summed over the covered snapped cells for one month. Extra fields such as `points`
 * are ignored.
 * @typedef {{ ym: number, harmonized: number, modis_raw: number, viirs_raw: number }} MonthSums
 */
/**
 * A row of the `months` table. Every month in it is a covered month.
 * @typedef {{ ym: number, terra_only: number, viirs_source: string | null, viirs_missing_days: number,
 *   provisional: number, days_covered: number }} MonthFlags
 */
/**
 * `cell_days` summed over the covered snapped cells for one day.
 * @typedef {{ year: number, day: number, harmonized: number }} DayTotal
 */

const { start_year: BASELINE_START, end_year: BASELINE_END } = TIME.BASELINE;
const VIIRS_START_YM = yearMonthToYm(TIME.SNPP_START.slice(0, 7));
// Sums of float weights pick up noise in the last bits; 4 decimals is far below a hotspot.
const DIGITS = 4;

const roundTo = (x, digits = DIGITS) => {
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return r === 0 ? 0 : r;
};
const yearOf = (ym) => Math.floor(ym / 100);
const nextYm = (ym) => (ym % 100 === 12 ? ym + 89 : ym + 1);
const toYm = (value) => (typeof value === "string" ? yearMonthToYm(value) : value);
const inBaseline = (year) => year >= BASELINE_START && year <= BASELINE_END;
const partialCoverage = (flag) => Boolean(flag.terra_only) || flag.viirs_missing_days > 0;

/** @param {number[]} values */
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return roundTo(sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

/** 1 = highest; ties share the best rank. */
const rankAmong = (value, peers) => 1 + peers.filter((peer) => peer > value).length;

/**
 * Harmonized value of every covered month, 0 where no `cells` row exists.
 * @param {Iterable<MonthSums>} monthlySums
 * @param {Iterable<MonthFlags>} monthFlags
 */
function monthValues(monthlySums, monthFlags) {
  const harmonized = new Map();
  for (const row of monthlySums) harmonized.set(row.ym, row.harmonized);
  const values = new Map();
  for (const flag of monthFlags) values.set(flag.ym, roundTo(harmonized.get(flag.ym) ?? 0));
  return values;
}

/** @param {Map<number, number>} values */
function mediansOf(values) {
  const byMonth = Array.from({ length: 12 }, () => []);
  for (const [ym, value] of values) if (inBaseline(yearOf(ym))) byMonth[(ym % 100) - 1].push(value);
  return byMonth.map(median);
}

/**
 * Median value of each calendar month over the baseline years, January first; null for a
 * month with no baseline data.
 * @param {Iterable<MonthSums>} monthlySums
 * @param {Iterable<MonthFlags>} monthFlags
 * @returns {(number | null)[]}
 */
export function baselineMedians(monthlySums, monthFlags) {
  return mediansOf(monthValues(monthlySums, monthFlags));
}

/**
 * Calendar months, ascending, whose median is above the mean of the medians. A southern season
 * comes back as e.g. [1, 2, 12].
 * @param {(number | null)[]} medians twelve medians, January first
 * @returns {number[]}
 */
export function fireSeason(medians) {
  const known = medians.flatMap((value, i) => (value === null || value === undefined ? [] : [[i + 1, value]]));
  if (known.length === 0) return [];
  const mean = known.reduce((sum, [, value]) => sum + value, 0) / known.length;
  return known.filter(([, value]) => value > mean).map(([month]) => month);
}

/**
 * The calendar's `months` array, one entry per month from `range.start` to `range.end`
 * (default: the first and last covered month). Statistics always use every covered month, so
 * `monthlySums` must span the whole record even when the range is shorter.
 * @param {Iterable<MonthSums>} monthlySums
 * @param {MonthFlags[]} monthFlags
 * @param {Series} mode
 * @param {{ start?: string | number, end?: string | number }} [range] YYYY-MM or ym
 * @returns {CalendarMonth[]}
 */
export function buildMonths(monthlySums, monthFlags, mode, range = {}) {
  if (!SERIES.includes(mode)) throw new TypeError(`mode must be "harmonized" or "raw", got ${mode}`);
  const sums = new Map();
  for (const row of monthlySums) sums.set(row.ym, row);
  const flags = new Map(monthFlags.map((flag) => [flag.ym, flag]));
  const values = monthValues(sums.values(), monthFlags);
  const medians = mediansOf(values);

  const peers = Array.from({ length: 12 }, () => []);
  for (const [ym, value] of values) if (yearOf(ym) >= BASELINE_START) peers[(ym % 100) - 1].push([yearOf(ym), value]);

  const covered = [...flags.keys()];
  const first = toYm(range.start) ?? Math.min(...covered);
  const last = toYm(range.end) ?? Math.max(...covered);
  const months = [];
  for (let ym = first; ym <= last; ym = nextYm(ym)) {
    const year = yearOf(ym);
    const month = ym % 100;
    const flag = flags.get(ym);
    const row = sums.get(ym);
    const entry = {
      year,
      month,
      value: null,
      modis_raw: flag ? (row?.modis_raw ?? 0) : null,
      viirs_raw: flag && ym >= VIIRS_START_YM ? (row?.viirs_raw ?? 0) : null,
      median: null,
      anomaly_log2: null,
      difference: null,
      rank: null,
      of_years: null,
      provisional: flag ? Boolean(flag.provisional) : false,
      partial_coverage: flag ? partialCoverage(flag) : false,
    };
    if (flag && mode === "harmonized") {
      const value = values.get(ym);
      const med = medians[month - 1];
      entry.value = value;
      if (med !== null) {
        entry.median = med;
        entry.anomaly_log2 = med < 1 ? null : roundTo(Math.log2((value + 1) / (med + 1)));
        entry.difference = roundTo(value - med);
      }
      if (year >= BASELINE_START) {
        const rivals = peers[month - 1].filter(([peerYear]) => peerYear <= year).map(([, peer]) => peer);
        entry.rank = rankAmong(value, rivals);
        entry.of_years = rivals.length;
      }
    }
    months.push(entry);
  }
  return months;
}

/**
 * Days 1 to `days_covered` of the last covered month, against the same days of that calendar
 * month in earlier years: the median over baseline years, the rank over 2003 to this year, and
 * each of those years' totals in `history`.
 * @param {Iterable<DayTotal>} dayTotals
 * @param {MonthFlags[]} monthFlags
 * @returns {CurrentMonthResponse}
 */
export function currentMonth(dayTotals, monthFlags) {
  if (monthFlags.length === 0) throw new RangeError("monthFlags is empty");
  const flag = monthFlags.reduce((latest, row) => (row.ym > latest.ym ? row : latest));
  const year = yearOf(flag.ym);
  const month = flag.ym % 100;
  const days = flag.days_covered;

  const totals = new Map();
  for (const row of monthFlags) if (row.ym % 100 === month) totals.set(yearOf(row.ym), 0);
  for (const { year: dayYear, day, harmonized } of dayTotals) {
    if (day >= 1 && day <= days && totals.has(dayYear)) totals.set(dayYear, totals.get(dayYear) + harmonized);
  }
  const value = roundTo(totals.get(year));
  const baseline = [];
  const history = [];
  for (const [peerYear, total] of totals) {
    if (inBaseline(peerYear)) baseline.push(roundTo(total));
    if (peerYear >= BASELINE_START && peerYear <= year) history.push({ year: peerYear, value: roundTo(total) });
  }
  history.sort((a, b) => a.year - b.year);
  const rivals = history.map((entry) => entry.value);
  return {
    year,
    month,
    days_covered: days,
    value,
    median: median(baseline),
    rank: rankAmong(value, rivals),
    of_years: rivals.length,
    provisional: Boolean(flag.provisional),
    partial_coverage: partialCoverage(flag),
    history,
  };
}
