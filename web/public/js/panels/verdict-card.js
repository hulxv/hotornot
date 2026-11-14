import { MONTH_LONG } from "../calendar/transform.js";
import { formatCount, ordinal } from "../verdict.js";
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
 * "1.6× usual", or null when there is no usual level to divide by.
 * @param {number} value
 * @param {number | null} median
 */
export function ratioText(value, median) {
  if (!isNumber(median) || median <= 0) return null;
  const ratio = value / median;
  const shown = ratio >= 10 ? Math.round(ratio).toString() : String(Number(ratio.toPrecision(2)));
  return `${shown}× usual`;
}

/** "4th busiest of 24", "Busiest of 24", "Quietest of 24". @param {number} rank @param {number} years */
export function rankText(rank, years) {
  if (rank === 1) return `Busiest of ${years}`;
  if (rank === years) return `Quietest of ${years}`;
  return `${ordinal(rank)} busiest of ${years}`;
}

/**
 * The verdict's numbers as figures: this period and the usual level as two bars on one scale,
 * then the rank among the years. The bars are hidden from assistive technology; each row's label
 * and number read as a pair.
 * @param {MonthSummary} summary
 */
function figures({ year, value, median, rank, of_years: years, days_covered: days }) {
  if (!isNumber(value)) return null;
  const partial = isNumber(days);
  const top = Math.max(value, isNumber(median) ? median : 0);
  const width = (number) => (top > 0 && number > 0 ? Math.max(1.5, (100 * number) / top) : 0);
  const bar = (number, kind) =>
    h("span", { class: "figures__track", "aria-hidden": "true" }, h("span", { class: `figures__bar figures__bar--${kind}`, style: `width: ${width(number).toFixed(1)}%` }));
  const ratio = ratioText(value, median);
  const rows = [
    h("dt", { text: partial ? `${year} so far` : String(year) }),
    h(
      "dd",
      {},
      bar(value, "now"),
      h("span", { class: "figures__value" }, formatCount(value), ratio ? h("span", { class: "figures__ratio", text: ratio }) : null),
    ),
  ];
  if (isNumber(median)) {
    rows.push(h("dt", { text: partial ? "Usual by now" : "Usual" }), h("dd", {}, bar(median, "usual"), h("span", { class: "figures__value", text: formatCount(median) })));
  }
  if (isNumber(rank) && isNumber(years) && years >= 2) {
    rows.push(h("dt", { text: "Rank" }), h("dd", { class: "figures__rank", text: rankText(rank, years) }));
  }
  return h("dl", { class: "figures" }, ...rows);
}

/**
 * This month's total against the same days of every earlier year, as a bar per year with the
 * chosen year lit. Each year is a button: with `onYear`, choosing one shows that year's fires
 * for the same days on the map. Arrow keys move between years with one tab stop for the chart.
 * @param {MonthSummary & { history?: YearTotal[] }} summary
 * @param {((year: number) => void) | undefined} onYear
 */
function yearChart({ month, year, days_covered: days, median, history }, onYear) {
  if (!history || history.length < 4) return null;
  const { bars, medianHeight, busiest } = yearBars(history, median);
  const span = days ? `${MONTH_LONG[month - 1]} 1–${days}` : `Every ${MONTH_LONG[month - 1]}`;
  const columns = bars.map((bar) =>
    h(
      "button",
      {
        type: "button",
        class: "years__col",
        "data-year": bar.year,
        "aria-pressed": "false",
        "aria-label": `${bar.year}: ${formatCount(bar.value)}`,
        title: `${bar.year}: ${formatCount(bar.value)}`,
        tabindex: bar.year === year ? "0" : "-1",
        disabled: !onYear,
        onclick: () => onYear?.(bar.year),
      },
      h("span", { class: `years__bar${bar.year === year ? " years__bar--now" : ""}`, style: `height: ${bar.height.toFixed(1)}%` }),
    ),
  );
  const plot = h(
    "div",
    {
      class: "years__plot",
      role: "group",
      "aria-label": `${span}, each year since ${bars[0].year}. Choose a year to show its fires on the map.`,
      onkeydown: (event) => moveFocus(/** @type {KeyboardEvent} */ (event), columns),
    },
    ...columns,
    medianHeight === null
      ? null
      : h("span", { class: "years__usual", style: `bottom: ${medianHeight.toFixed(1)}%`, "aria-hidden": "true" }, h("span", { text: `usual ${formatCount(median)}` })),
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
    onYear ? h("p", { class: "years__hint", text: "Click a year to see its fires on the map." }) : null,
  );
}

/**
 * Left and right arrows (and Home, End) move focus along the year buttons, so the chart is one
 * tab stop instead of one per year.
 * @param {KeyboardEvent} event
 * @param {HTMLElement[]} columns
 */
function moveFocus(event, columns) {
  const at = columns.indexOf(/** @type {HTMLElement} */ (event.target));
  if (at < 0) return;
  const next = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: columns.length - 1 }[event.key];
  if (next === undefined || next < 0 || next >= columns.length) return;
  event.preventDefault();
  columns[at].setAttribute("tabindex", "-1");
  columns[next].setAttribute("tabindex", "0");
  columns[next].focus();
}

/**
 * Marks the year whose fires the map shows, or none.
 * @param {VerdictElements} elements
 * @param {number | null} year
 */
export function markMapYear({ body }, year) {
  for (const column of body.querySelectorAll(".years__col")) {
    column.setAttribute("aria-pressed", String(column.getAttribute("data-year") === String(year)));
  }
}

/**
 * The verdict card: area and period next to the "Hot or not?" heading, the word, the sentence,
 * its notes and the year chart. `onLatest`, when given, adds a button back to the newest month;
 * `onYear` makes the chart's years choose the map's fires.
 * @param {VerdictElements} elements
 * @param {{ status: "loading", area: string } | { status: "empty", area: string, text: string }
 *   | { status: "ready", area: string, verdict: Verdict, summary?: MonthSummary & { history?: YearTotal[] }, onLatest?: () => void, onYear?: (year: number) => void }} view
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
  const shown = view.summary ? figures(view.summary) : null;
  const parts = [shown ?? h("p", { class: "verdict__sentence", text: sentence }), ...notes.map((note) => h("p", { class: "verdict__note", text: note }))];
  if (word) parts.unshift(h("p", { class: "verdict__word" }, h("span", { class: "visually-hidden", text: "Verdict: " }), word));
  if (view.summary) parts.push(yearChart(view.summary, view.onYear));
  if (view.onLatest) parts.push(h("button", { type: "button", class: "link-button", text: "Back to today", onclick: view.onLatest }));
  body.replaceChildren(...parts.filter(Boolean));
}
