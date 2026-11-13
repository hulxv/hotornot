import { TIME } from "../../shared/contracts.js";
import { MONTH_LONG, MONTH_SHORT } from "../calendar/transform.js";
import { h, skeleton } from "./dom.js";

/**
 * @typedef {import("../../shared/contracts.js").CurrentMonthResponse} CurrentMonthResponse
 * @typedef {import("./messages.js").Message} Message
 */

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

const daysIn = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * Whole numbers from 10 up, one decimal below: harmonized values are sums of fractional weights.
 * @param {number} value at least 0
 */
export function formatValue(value) {
  if (value === 0) return "0";
  if (value < 0.05) return "less than 0.1";
  return value >= 10 ? integer.format(value) : oneDecimal.format(value);
}

/** @param {number} difference */
export function formatDifference(difference) {
  if (Math.abs(difference) < 0.05) return "0";
  return `${difference > 0 ? "+" : "−"}${formatValue(Math.abs(difference))}`;
}

/** @param {number} n */
export function ordinal(n) {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : ({ 1: "st", 2: "nd", 3: "rd" })[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** @param {CurrentMonthResponse} current */
function dayspan(current) {
  if (current.days_covered >= daysIn(current.year, current.month)) return "the month";
  return current.days_covered === 1 ? "the first day" : `the first ${current.days_covered} days`;
}

/**
 * The card's one sentence, in the RFC's form: "November 2026 so far: 96 MODIS-equivalent
 * hotspots, below the median for the first 13 days, 19th of 24."
 * @param {CurrentMonthResponse} current
 */
export function currentMonthSentence(current) {
  const complete = current.days_covered >= daysIn(current.year, current.month);
  const lead = `${MONTH_LONG[current.month - 1]} ${current.year}${complete ? "" : " so far"}`;
  const amount = `${formatValue(current.value)} MODIS-equivalent hotspot${current.value === 1 ? "" : "s"}`;
  let comparison = "with no median to compare against";
  if (current.median !== null && current.median !== undefined) {
    const same = formatValue(current.value) === formatValue(current.median);
    const side = same ? "at" : current.value > current.median ? "above" : "below";
    comparison = `${side} the median for ${dayspan(current)}`;
  }
  const rank = current.rank && current.of_years ? `, ${ordinal(current.rank)} of ${current.of_years}` : "";
  return `${lead}: ${amount}, ${comparison}${rank}.`;
}

/**
 * The supporting lines under the sentence: median, difference and rank with their spans.
 * @param {CurrentMonthResponse} current
 * @returns {[string, string][]}
 */
export function currentMonthDetails(current) {
  const { start_year: from, end_year: to } = TIME.BASELINE;
  const month = MONTH_SHORT[current.month - 1];
  const days = current.days_covered >= daysIn(current.year, current.month) ? month : `1–${current.days_covered} ${month}`;
  const rows = [];
  if (current.median !== null && current.median !== undefined) {
    rows.push([`Median, ${days}, ${from}–${to}`, formatValue(current.median)]);
    rows.push(["Difference", formatDifference(current.value - current.median)]);
  }
  if (current.rank && current.of_years) {
    rows.push([`Rank among ${days}, ${from}–${current.year}`, `${ordinal(current.rank)} of ${current.of_years} (1st is the most active)`]);
  }
  return rows;
}

/** @param {CurrentMonthResponse} current */
export function currentMonthFlags(current) {
  const flags = [];
  if (current.provisional) flags.push({ kind: "provisional", label: "Provisional", text: "Uses near-real-time data, which can still change." });
  if (current.partial_coverage) flags.push({ kind: "partial", label: "Partial coverage", text: "Satellite passes are missing on some days." });
  return flags;
}

/**
 * @param {HTMLElement} container
 * @param {{ status: "loading" } | { status: "empty", text: string } | { status: "error", message: Message }
 *   | { status: "ready", data: CurrentMonthResponse }} view
 */
export function renderCurrentMonth(container, view) {
  container.setAttribute("aria-busy", String(view.status === "loading"));
  if (view.status === "loading") {
    container.replaceChildren(skeleton(["95%", "80%", "60%"]), h("p", { class: "visually-hidden", text: "Loading this month…" }));
    return;
  }
  if (view.status === "empty") {
    container.replaceChildren(h("p", { class: "muted", text: view.text }));
    return;
  }
  if (view.status === "error") {
    container.replaceChildren(h("p", { class: "muted", text: `${view.message.title} ${view.message.detail ?? ""}`.trim() }));
    return;
  }
  const current = view.data;
  const details = h("dl", { class: "month-card__details" });
  for (const [term, value] of currentMonthDetails(current)) details.append(h("div", {}, h("dt", { text: term }), h("dd", { text: value })));
  const flags = currentMonthFlags(current).map((flag) =>
    h("p", { class: `flag flag--${flag.kind}` }, h("strong", { class: "flag__label", text: flag.label }), ` ${flag.text}`),
  );
  container.replaceChildren(h("p", { class: "month-card__sentence", text: currentMonthSentence(current) }), details, ...flags);
}
