// The story tour: each step's title and page state, the page state through url-state.js, and the
// story card on the real index.html in the a11y checker's small DOM.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkDocument, parseHtml } from "../scripts/a11y-check.js";
import { CHAPTERS } from "../public/js/story/chapters.js";
import { createStory } from "../public/js/story/story.js";
import { DEFAULT_STATE, parseState, serializeState, seriesForView } from "../public/js/url-state.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

/** The seven steps the user approved: their titles and the page each one shows. */
function approvedTable() {
  return [
    ["A satellite goes quiet", "Nile Delta, Fire count, today"],
    ["The fake explosion", "California, raw MODIS and VIIRS, today"],
    ["One scale", "California, Fire count, today"],
    ["Black Summer", "SE Australia, Compared with normal, years to 2019-12"],
    ["California 2020", "California, Fire count, years to 2020-09"],
    ["The black cloud", "Nile Delta, Fire count, today"],
    ["Hot or not, today?", "California, Fire count, today"],
  ].map(([title, page], i) => ({ number: i + 1, title, page }));
}

const PLACES = { "Nile Delta": "nile_delta", California: "california", "SE Australia": "se_australia" };
const VIEWS = { "Fire count": "harmonized", "Compared with normal": "anomaly", "raw MODIS and VIIRS": "raw" };

/** The state the table's "Page state" column describes, e.g. "SE Australia, Compared with normal, years to 2019-12". */
function stateFromTable(page) {
  const [place, view, when] = page.split(", ");
  assert.ok(PLACES[place] && VIEWS[view], page);
  const end = when === "today" ? null : /^years to (\d{4}-\d{2})$/.exec(when)?.[1];
  assert.notEqual(end, undefined, page);
  return { ...DEFAULT_STATE, region: PLACES[place], view: VIEWS[view], series: seriesForView(VIEWS[view]), end };
}

describe("the story's wording and page states", () => {
  const table = approvedTable();

  it("has the seven approved steps, each with a body and a one-line takeaway", () => {
    assert.equal(CHAPTERS.length, table.length);
    table.forEach((row, i) => {
      assert.equal(CHAPTERS[i].title, row.title, `step ${row.number} title`);
      assert.ok(CHAPTERS[i].body.length > 80, `step ${row.number} body`);
      assert.ok(CHAPTERS[i].caption.length > 10 && !CHAPTERS[i].caption.includes("\n"), `step ${row.number} caption`);
    });
  });

  it("gives every step a page state that url-state.js parses into the table's view", () => {
    table.forEach((row, i) => {
      const state = parseState(CHAPTERS[i].query);
      assert.deepEqual(state, stateFromTable(row.page), `step ${row.number}: ${row.page}`);
      assert.deepEqual(parseState(serializeState(state)), state, `step ${row.number} round-trips`);
    });
  });

  it("links only step 3 to the test on the method page", () => {
    assert.deepEqual(
      CHAPTERS.map((chapter) => chapter.link ?? null),
      [null, null, { text: "See the test", href: "/method.html#seam" }, null, null, null, null],
    );
    assert.match(readFileSync(`${PUBLIC_DIR}/method.html`, "utf8"), /<section id="seam"/);
  });
});

/** The real index.html in the checker's DOM, with the story wired to a recorded page state. */
function setup({ initial = DEFAULT_STATE } = {}) {
  const doc = parseHtml(readFileSync(`${PUBLIC_DIR}/index.html`, "utf8"));
  let state = initial;
  /** @type {import("../public/js/url-state.js").AppState[]} */
  const applied = [];
  const story = createStory(/** @type {any} */ (doc), {
    getState: () => state,
    applyState: (next) => {
      state = next;
      applied.push(next);
    },
  });
  const el = (id) => doc.getElementById(id);
  const text = (id) => el(id).textContent;
  return { doc, story, applied, el, text, state: () => state };
}

describe("the story card", () => {
  it("starts closed with the button enabled, and opens on step 1", () => {
    const { story, el, text, applied, doc } = setup();
    assert.equal(el("story").hidden, true);
    assert.equal(el("story-start").disabled, false);
    assert.equal(el("story-start").getAttribute("aria-expanded"), "false");
    assert.equal(story.step, 0);

    el("story-start").click();
    assert.equal(el("story").hidden, false);
    assert.equal(el("story-start").getAttribute("aria-expanded"), "true");
    assert.equal(text("story-step"), "Step 1 of 7");
    assert.equal(text("story-title"), "A satellite goes quiet");
    assert.equal(text("story-body"), CHAPTERS[0].body);
    assert.equal(text("story-caption"), CHAPTERS[0].caption);
    assert.deepEqual(applied, [parseState(CHAPTERS[0].query)]);
    assert.equal(doc.activeElement, el("story"));
    assert.deepEqual(checkDocument(doc), [], "the page passes the checker with the story open");
  });

  it("reads title, body, then the takeaway, inside one polite live region", () => {
    const { el } = setup();
    const live = el("story-caption").closest("[aria-live]");
    assert.equal(live?.getAttribute("aria-live"), "polite");
    assert.equal(live.getAttribute("aria-atomic"), "true");
    const order = live.children.map((child) => child.id);
    assert.deepEqual(order, ["story-step", "story-title", "story-body", "story-caption"]);
  });

  it("steps with Back and Next, stopping at both ends, and applies each step's state", () => {
    const { story, el, text, applied, doc } = setup();
    el("story-start").click();
    assert.equal(el("story-back").disabled, true);
    el("story-back").click();
    assert.equal(story.step, 1);

    for (let i = 1; i < CHAPTERS.length; i += 1) {
      el("story-next").focus();
      el("story-next").click();
      assert.equal(text("story-step"), `Step ${i + 1} of 7`);
      assert.equal(text("story-title"), CHAPTERS[i].title);
      assert.equal(text("story-body"), CHAPTERS[i].body);
      assert.equal(text("story-caption"), CHAPTERS[i].caption);
      assert.equal(el("story-more").hidden, i !== 2, `See the test on step ${i + 1}`);
      assert.deepEqual(checkDocument(doc), [], `step ${i + 1}`);
    }
    assert.equal(el("story-next").disabled, true);
    assert.equal(el("story-back").disabled, false);
    assert.equal(doc.activeElement, el("story-back"), "focus leaves the disabled Next");
    el("story-next").click();
    assert.equal(story.step, 7);
    assert.deepEqual(applied, CHAPTERS.map((chapter) => parseState(chapter.query)));

    el("story-back").click();
    assert.equal(story.step, 6);
    assert.deepEqual(applied.at(-1), parseState(CHAPTERS[5].query));
  });

  it("shows See the test on step 3, linking to the method page", () => {
    const { el } = setup();
    el("story-start").click();
    assert.equal(el("story-more").hidden, true);
    el("story-next").click();
    el("story-next").click();
    assert.equal(el("story-more").hidden, false);
    assert.equal(el("story-link").textContent, "See the test");
    assert.equal(el("story-link").getAttribute("href"), "/method.html#seam");
  });

  it("returns to the state before the tour on Close and on Escape", () => {
    /** @type {import("../public/js/url-state.js").AppState} */
    const before = { ...DEFAULT_STATE, region: "n_argentina", area: { kind: "box", bbox: [-62, -25, -60, -23] }, view: "anomaly", start: "2010-01" };
    const { story, el, applied, state, doc } = setup({ initial: before });
    el("story-start").click();
    el("story-next").click();
    el("story-close").click();
    assert.equal(el("story").hidden, true);
    assert.equal(el("story-start").getAttribute("aria-expanded"), "false");
    assert.deepEqual(state(), before);
    assert.deepEqual(applied.at(-1), before);
    assert.equal(doc.activeElement, el("story-start"));
    assert.equal(story.step, 0);

    el("story-start").click();
    assert.equal(el("story-step").textContent, "Step 1 of 7", "a new tour starts at step 1");
    el("story-next").click();
    el("story").dispatchEvent({ type: "keydown", key: "Enter" });
    assert.equal(el("story").hidden, false);
    el("story").dispatchEvent({ type: "keydown", key: "Escape" });
    assert.equal(el("story").hidden, true);
    assert.deepEqual(state(), before);
  });
});
