import { parseState } from "../url-state.js";
import { CHAPTERS } from "./chapters.js";

/** @typedef {import("../url-state.js").AppState} AppState */

/**
 * The "Tell me the story" tour in index.html's story card. Each step applies its page state;
 * closing applies the state from before the tour.
 * @param {Document} doc
 * @param {{ getState: () => AppState, applyState: (state: AppState) => void }} options
 */
export function createStory(doc, { getState, applyState }) {
  const $ = (id) => /** @type {HTMLElement} */ (doc.getElementById(id));
  const ui = {
    start: /** @type {HTMLButtonElement} */ ($("story-start")),
    card: $("story"),
    step: $("story-step"),
    title: $("story-title"),
    body: $("story-body"),
    caption: $("story-caption"),
    more: $("story-more"),
    link: /** @type {HTMLAnchorElement} */ ($("story-link")),
    back: /** @type {HTMLButtonElement} */ ($("story-back")),
    next: /** @type {HTMLButtonElement} */ ($("story-next")),
    close: /** @type {HTMLButtonElement} */ ($("story-close")),
  };
  const last = CHAPTERS.length - 1;

  let step = 0;
  /** The page state before the tour; null while the tour is closed. @type {AppState | null} */
  let before = null;

  ui.start.addEventListener("click", open);
  ui.back.addEventListener("click", () => go(step - 1));
  ui.next.addEventListener("click", () => go(step + 1));
  ui.close.addEventListener("click", close);
  ui.card.addEventListener("keydown", (event) => {
    if (/** @type {KeyboardEvent} */ (event).key !== "Escape") return;
    event.preventDefault();
    close();
  });
  ui.start.disabled = false;

  function open() {
    if (!before) {
      before = getState();
      ui.card.hidden = false;
      ui.start.setAttribute("aria-expanded", "true");
      go(0);
    }
    ui.card.focus();
  }

  function close() {
    if (!before) return;
    const restore = before;
    before = null;
    ui.card.hidden = true;
    ui.start.setAttribute("aria-expanded", "false");
    applyState(restore);
    ui.start.focus();
  }

  /** @param {number} index */
  function go(index) {
    if (!before || index < 0 || index > last) return;
    step = index;
    applyState(parseState(CHAPTERS[step].query));
    render();
  }

  function render() {
    const chapter = CHAPTERS[step];
    ui.step.textContent = `Step ${step + 1} of ${CHAPTERS.length}`;
    ui.title.textContent = chapter.title;
    ui.body.textContent = chapter.body;
    ui.caption.textContent = chapter.caption;
    ui.more.hidden = !chapter.link;
    if (chapter.link) {
      ui.link.textContent = chapter.link.text;
      ui.link.setAttribute("href", chapter.link.href);
    }
    ui.back.disabled = step === 0;
    ui.next.disabled = step === last;
    const focused = doc.activeElement;
    if (focused === ui.back && ui.back.disabled) ui.next.focus();
    if (focused === ui.next && ui.next.disabled) ui.back.focus();
  }

  return {
    /** 1 to 7 while the tour is open, 0 while closed. */
    get step() {
      return before ? step + 1 : 0;
    },
  };
}
