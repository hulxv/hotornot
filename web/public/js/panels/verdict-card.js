import { formatCount } from "../verdict.js";
import { h, skeleton } from "./dom.js";

/**
 * @typedef {import("../verdict.js").Verdict} Verdict
 * @typedef {import("../verdict.js").MonthSummary} MonthSummary
 * @typedef {{ card: HTMLElement, where: HTMLElement, body: HTMLElement }} VerdictElements
 */

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * Three readouts (this month, the usual level, the rank) and a scale with one tick per year,
 * quietest on the left, with this month's tick lit. The sentence above says the same in words,
 * so the scale is hidden from assistive technology.
 * @param {MonthSummary} summary
 */
function readouts({ value, median, rank, of_years: years, days_covered: days }) {
  const stat = (label, number, unit) =>
    h("div", { class: "stat" }, h("dt", { text: label }), h("dd", {}, number, unit ? h("span", { class: "stat__unit", text: unit }) : null));
  const ranked = isNumber(rank) && isNumber(years) && years >= 2;
  const stats = h(
    "dl",
    { class: "stats" },
    isNumber(value) ? stat("Fire detections", formatCount(value)) : null,
    isNumber(median) ? stat(days ? "Usual by now" : "Usual", formatCount(median)) : null,
    ranked ? stat("Rank", String(rank), ` of ${years}`) : null,
  );
  if (!ranked) return [stats];
  const lit = years - rank;
  const quarter = years / 4;
  const ticks = Array.from({ length: years }, (_, i) =>
    h("span", { class: `gauge__tick${i === lit ? " gauge__tick--now" : i < Math.floor(quarter) ? " gauge__tick--not" : i >= years - Math.floor(quarter) ? " gauge__tick--hot" : ""}` }),
  );
  const gauge = h(
    "div",
    { class: "gauge", "aria-hidden": "true" },
    h("div", { class: "gauge__ticks" }, ...ticks),
    h("div", { class: "gauge__ends" }, h("span", { text: "Quietest year" }), h("span", { text: "Busiest year" })),
  );
  return [stats, gauge];
}

/**
 * The verdict card: area and period next to the "Hot or not?" heading, the word, the sentence
 * and its notes. `onLatest`, when given, adds a button back to the newest month.
 * @param {VerdictElements} elements
 * @param {{ status: "loading", area: string } | { status: "empty", area: string, text: string }
 *   | { status: "ready", area: string, verdict: Verdict, summary?: MonthSummary, onLatest?: () => void }} view
 */
export function renderVerdict({ card, where, body }, view) {
  body.setAttribute("aria-busy", String(view.status === "loading"));
  card.dataset.verdict = view.status === "ready" && view.verdict.word ? view.verdict.word.toLowerCase() : "none";
  if (view.status !== "ready") {
    where.textContent = view.area;
    body.replaceChildren(
      view.status === "loading"
        ? skeleton(["8rem", "95%", "70%"])
        : h("p", { class: "verdict__sentence muted", text: view.text }),
    );
    return;
  }
  const { word, period, sentence, notes } = view.verdict;
  where.textContent = [view.area, period].filter(Boolean).join(" · ");
  const parts = [h("p", { class: "verdict__sentence", text: sentence }), ...notes.map((note) => h("p", { class: "verdict__note", text: note }))];
  if (word) parts.unshift(h("p", { class: "verdict__word" }, h("span", { class: "visually-hidden", text: "Verdict: " }), word));
  if (view.summary) parts.push(...readouts(view.summary));
  if (view.onLatest) parts.push(h("button", { type: "button", class: "link-button", text: "Back to today", onclick: view.onLatest }));
  body.replaceChildren(...parts);
}
