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
