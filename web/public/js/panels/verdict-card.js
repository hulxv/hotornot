import { MONTH_LONG } from "../calendar/transform.js";
import { formatCount } from "../verdict.js";
import { h, skeleton } from "./dom.js";

/**
 * @typedef {import("../verdict.js").Verdict} Verdict
 * @typedef {import("../verdict.js").MonthSummary} MonthSummary
 * @typedef {{ year: number, value: number }} YearTotal
 * @typedef {{ card: HTMLElement, where: HTMLElement, body: HTMLElement }} VerdictElements
 */

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * The bars of the year chart, oldest first: each bar's height as a percent of the tallest, the
 * usual level on the same scale, and the year with the most fires. A nonzero year never draws
 * thinner than 2% so it stays visible next to a record year.
 * @param {YearTotal[]} history
 * @param {number | null} median
 */
export function yearBars(history, median) {
  const top = Math.max(...history.map((entry) => entry.value), isNumber(median) ? median : 0);
  const percent = (value) => (top > 0 ? (100 * value) / top : 0);
  const busiest = history.reduce((best, entry) => (entry.value > best.value ? entry : best), history[0]);
  return {
    bars: history.map(({ year, value }) => ({ year, value, height: value > 0 ? Math.max(2, percent(value)) : 0 })),
    medianHeight: isNumber(median) ? percent(median) : null,
    busiest,
  };
}

/**
 * This month's total against the same days of every earlier year, as a bar per year with the
 * chosen year lit. The sentence above says the same in words, so the plot is hidden from
 * assistive technology and only its caption is read.
 * @param {MonthSummary & { history?: YearTotal[] }} summary
 */
function yearChart({ month, year, days_covered: days, median, history }) {
  if (!history || history.length < 4) return null;
  const { bars, medianHeight, busiest } = yearBars(history, median);
  const span = days ? `${MONTH_LONG[month - 1]} 1–${days}` : `Every ${MONTH_LONG[month - 1]}`;
  const plot = h(
    "div",
    { class: "years__plot", "aria-hidden": "true" },
    ...bars.map((bar) =>
      h("span", {
        class: `years__bar${bar.year === year ? " years__bar--now" : ""}`,
        style: `height: ${bar.height.toFixed(1)}%`,
        title: `${bar.year}: ${formatCount(bar.value)}`,
      }),
    ),
    medianHeight === null
      ? null
      : h("span", { class: "years__usual", style: `bottom: ${medianHeight.toFixed(1)}%` }, h("span", { text: `usual ${formatCount(median)}` })),
  );
  return h(
    "figure",
    { class: "years" },
    h(
      "figcaption",
      { class: "years__caption" },
      `${span}, ${bars[0].year} to ${bars.at(-1).year}`,
      h("span", { class: "years__peak", text: `Most: ${busiest.year}, ${formatCount(busiest.value)}` }),
    ),
    plot,
    h("div", { class: "years__axis", "aria-hidden": "true" }, h("span", { text: String(bars[0].year) }), h("span", { text: String(bars.at(-1).year) })),
  );
}

/**
 * The verdict card: area and period next to the "Hot or not?" heading, the word, the sentence,
 * its notes and the year chart. `onLatest`, when given, adds a button back to the newest month.
 * @param {VerdictElements} elements
 * @param {{ status: "loading", area: string } | { status: "empty", area: string, text: string }
 *   | { status: "ready", area: string, verdict: Verdict, summary?: MonthSummary & { history?: YearTotal[] }, onLatest?: () => void }} view
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
  if (view.summary) parts.push(yearChart(view.summary));
  if (view.onLatest) parts.push(h("button", { type: "button", class: "link-button", text: "Back to today", onclick: view.onLatest }));
  body.replaceChildren(...parts.filter(Boolean));
}
