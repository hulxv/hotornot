import { TIME } from "../shared/contracts.js";
import { MONTH_LONG } from "./calendar/transform.js";

/**
 * @typedef {"HOT" | "NOT" | "NORMAL"} VerdictWord
 * @typedef {{
 *   year: number,
 *   month: number,
 *   value: number | null,
 *   median: number | null,
 *   rank: number | null,
 *   of_years: number | null,
 *   provisional: boolean,
 *   partial_coverage: boolean,
 *   days_covered?: number,
 * }} MonthSummary a `/api/current-month` answer, or one month of a calendar answer (no `days_covered`: the whole month)
 * @typedef {{ word: VerdictWord | null, period: string, sentence: string, notes: string[] }} Verdict
 */

export const MIN_YEARS = 4;

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const daysIn = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/**
 * Whole numbers from 10 up, one decimal below: harmonized counts are sums of fractional weights.
 * @param {number} value at least 0
 */
export function formatCount(value) {
  if (value === 0) return "0";
  if (value < 0.05) return "less than 0.1";
  return value >= 10 ? integer.format(value) : oneDecimal.format(value);
}

/** @param {number} n */
export function ordinal(n) {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : ({ 1: "st", 2: "nd", 3: "rd" })[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/**
 * HOT when the month ranks in the top quarter of its years, NOT in the bottom quarter, NORMAL
 * otherwise; null with fewer than MIN_YEARS years or a missing number.
 * @param {Pick<MonthSummary, "value" | "median" | "rank" | "of_years">} summary
 * @returns {VerdictWord | null}
 */
export function verdictWord({ value, median, rank, of_years: years }) {
  if (![value, median, rank, years].every(isNumber) || years < MIN_YEARS) return null;
  const quarter = years / 4;
  // Tied years share the best rank, so a quiet month tied with many quiet years can rank near
  // the top. Requiring the value to beat the median keeps such ties (zero fires in most years) NORMAL.
  if (rank <= quarter && value > median) return "HOT";
  if (years - rank + 1 <= quarter && value < median) return "NOT";
  return "NORMAL";
}

/** @param {Pick<MonthSummary, "year" | "month" | "days_covered">} summary */
const isPartial = ({ year, month, days_covered: days }) => isNumber(days) && days < daysIn(year, month);

/**
 * "November 2026 so far" while the month is still coming in, else "November 2026".
 * @param {Pick<MonthSummary, "year" | "month" | "days_covered">} summary
 */
export function verdictPeriod(summary) {
  return `${MONTH_LONG[summary.month - 1]} ${summary.year}${isPartial(summary) ? " so far" : ""}`;
}

/** @param {number} rank @param {number} years */
function rankText(rank, years) {
  if (rank === 1) return `the highest of ${years} years`;
  if (rank === years) return `the lowest of ${years} years`;
  return `${ordinal(rank)} highest of ${years} years`;
}

/**
 * "397 fire detections, 6th highest of 24 years (usually 282 by now)."
 * @param {MonthSummary} summary
 */
export function verdictSentence(summary) {
  const { value, median, rank, of_years: years } = summary;
  if (!isNumber(value)) return "No fire data for this month.";
  const count = formatCount(value);
  let sentence = `${count} fire detection${count === "1" ? "" : "s"}`;
  if (isNumber(rank) && isNumber(years) && years >= 2) sentence += `, ${rankText(rank, years)}`;
  if (isNumber(median)) sentence += ` (usually ${formatCount(median)}${isPartial(summary) ? " by now" : ""})`;
  return `${sentence}.`;
}

/**
 * Short lines under the sentence: why there is no verdict word, early numbers, missing passes.
 * @param {MonthSummary} summary
 */
export function verdictNotes(summary) {
  const notes = [];
  if (isNumber(summary.value) && verdictWord(summary) === null) {
    if (!isNumber(summary.rank) || !isNumber(summary.of_years)) {
      notes.push(`Months before ${TIME.BASELINE.start_year} are not ranked, so there is no verdict.`);
    } else if (summary.of_years < MIN_YEARS) {
      notes.push(`Only ${summary.of_years} year${summary.of_years === 1 ? "" : "s"} to compare, too few for a verdict.`);
    } else {
      notes.push("No usual level to compare with, so there is no verdict.");
    }
  }
  if (summary.provisional) notes.push("Early numbers, may still change.");
  if (summary.partial_coverage) notes.push("Some satellite passes are missing, so the count may be low.");
  return notes;
}

/**
 * @param {MonthSummary} summary
 * @returns {Verdict}
 */
export function verdict(summary) {
  return {
    word: verdictWord(summary),
    period: verdictPeriod(summary),
    sentence: verdictSentence(summary),
    notes: verdictNotes(summary),
  };
}

/**
 * The month the verdict is about, as YYYY-MM: the last month the calendar shows, or the newest
 * month with data when the range runs to today.
 * @param {string | null} end the range's last month, null for the end of the record
 * @param {string} latest the newest month with data
 */
export function verdictMonth(end, latest) {
  return end && end < latest ? end : latest;
}

/**
 * @typedef {{
 *   year: number, value: number | null, median: number | null, rank: number | null,
 *   of_years: number | null, complete: boolean, history: { year: number, value: number }[],
 * }} YearSummary
 */

const round4 = (value) => Math.round(value * 1e4) / 1e4;

/** @param {number[]} values non-empty */
function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return round4(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * One calendar year's total against the other years, from a harmonized calendar's months. The
 * usual level is the median of the whole baseline years; the rank, like a month's, is among the
 * whole years from the baseline's start up to this one, tied years sharing the best rank. A year
 * the record holds only part of (the first, or this one) is not ranked.
 * @param {{ year: number, value: number | null }[]} months
 * @param {number} year
 * @returns {YearSummary}
 */
export function yearSummary(months, year) {
  /** @type {Map<number, { value: number, months: number }>} */
  const totals = new Map();
  for (const month of months) {
    if (!isNumber(month.value)) continue;
    const entry = totals.get(month.year) ?? { value: 0, months: 0 };
    entry.value += month.value;
    entry.months += 1;
    totals.set(month.year, entry);
  }
  const whole = (y) => totals.get(y)?.months === 12;
  const { start_year: first, end_year: last } = TIME.BASELINE;
  const baseline = [...totals].filter(([y]) => y >= first && y <= last && whole(y)).map(([, entry]) => entry.value);
  const own = totals.get(year);
  const complete = whole(year);
  let rank = null;
  let ofYears = null;
  if (own && complete && year >= first) {
    const rivals = [...totals].filter(([y]) => y >= first && y <= year && whole(y)).map(([, entry]) => round4(entry.value));
    const mine = round4(own.value);
    rank = 1 + rivals.filter((value) => value > mine).length;
    ofYears = rivals.length;
  }
  return {
    year,
    value: own ? round4(own.value) : null,
    median: baseline.length ? medianOf(baseline) : null,
    rank,
    of_years: ofYears,
    complete,
    history: [...totals]
      .filter(([y]) => y >= first)
      .sort((a, b) => a[0] - b[0])
      .map(([y, entry]) => ({ year: y, value: round4(entry.value) })),
  };
}

/**
 * The verdict for a whole year: the word only for a whole, ranked year.
 * @param {YearSummary} summary
 * @returns {Verdict}
 */
export function yearVerdict(summary) {
  const { year, value, complete, of_years: years } = summary;
  const word = complete ? verdictWord(summary) : null;
  const notes = [];
  if (!isNumber(value)) notes.push(`No fire data for ${year}.`);
  else if (!complete && year === summary.history.at(-1)?.year) notes.push(`${year} is not over yet, so it is not compared with whole years.`);
  else if (!complete) notes.push(`${year} is only partly in the record, so it is not compared with whole years.`);
  else if (year < TIME.BASELINE.start_year) notes.push(`Years before ${TIME.BASELINE.start_year} are not ranked.`);
  else if (word === null && isNumber(years) && years < MIN_YEARS) notes.push(`Only ${years} year${years === 1 ? "" : "s"} to compare, too few for a verdict.`);
  const count = isNumber(value) ? formatCount(value) : null;
  return {
    word,
    period: complete ? String(year) : `${year} so far`,
    sentence: count === null ? `No fire data for ${year}.` : `${count} fire detection${count === "1" ? "" : "s"} in ${year}.`,
    notes,
  };
}
