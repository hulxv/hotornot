import { h, skeleton } from "./dom.js";

/**
 * @typedef {import("../verdict.js").Verdict} Verdict
 * @typedef {{ card: HTMLElement, where: HTMLElement, body: HTMLElement }} VerdictElements
 */

/**
 * The verdict card: area and period next to the "Hot or not?" heading, the word, the sentence
 * and its notes. `onLatest`, when given, adds a button back to the newest month.
 * @param {VerdictElements} elements
 * @param {{ status: "loading", area: string } | { status: "empty", area: string, text: string }
 *   | { status: "ready", area: string, verdict: Verdict, onLatest?: () => void }} view
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
  if (view.onLatest) parts.push(h("button", { type: "button", class: "link-button", text: "Back to today", onclick: view.onLatest }));
  body.replaceChildren(...parts);
}
