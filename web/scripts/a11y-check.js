// Accessibility check of the served pages, with no packages: parses each page's HTML into a small
// DOM, renders it with the page's own modules (against the same server's API, with stand-ins for
// MapLibre, terra-draw and ECharts, which need a real browser), and checks landmarks, headings,
// names of controls, buttons, links and images, id references, and the contrast of the CSS
// custom-property palette in the light and dark schemes. With --transfer it also lists every
// file and first API response a page loads, with its size and Cache-Control.
//
//   node scripts/a11y-check.js                     # starts server.js in-process (mocks or DATA_BASE_URL)
//   node scripts/a11y-check.js http://localhost:3030 --transfer
//   node scripts/a11y-check.js <base> --pages=/,/method.html,/dev/map.html
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { contrastRatio, edgeColor, markColor, parseHex, toHex } from "../public/js/calendar/color.js";
import { calendarBody } from "../public/js/client-api.js";
import { areaPolygon, parseState } from "../public/js/url-state.js";

/** @typedef {{ rule: string, message: string }} Finding */

export const DEFAULT_PAGES = ["/", "/method.html"];

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", mdash: "—", ndash: "–", times: "×", hellip: "…", deg: "°", minus: "−", middot: "·" };
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
]);
const IMPLIED_END = { li: ["li"], dt: ["dt", "dd"], dd: ["dt", "dd"], option: ["option"], tr: ["tr", "td", "th"], td: ["td", "th"], th: ["td", "th"], thead: ["tbody", "tr", "td", "th"], tbody: ["thead", "tbody", "tr", "td", "th"] };

const decode = (text) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === "#") return String.fromCodePoint(name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });

class TextNode {
  /** @param {string} data */
  constructor(data) {
    this.nodeType = 3;
    this.data = data;
    /** @type {Element | null} */
    this.parentNode = null;
  }

  get textContent() {
    return this.data;
  }
}

/**
 * The part of the DOM the pages' modules use, enough to render them in Node: attributes,
 * children, text, innerHTML, simple selectors, dataset, classList and event listeners.
 */
export class Element {
  /** @param {string} tag @param {MiniDocument | null} owner */
  constructor(tag, owner) {
    this.nodeType = 1;
    this.localName = tag.toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.ownerDocument = owner;
    /** @type {Map<string, string>} */
    this.attributes = new Map();
    /** @type {(Element | TextNode)[]} */
    this.childNodes = [];
    /** @type {Element | null} */
    this.parentNode = null;
    /** @type {Record<string, Function[]>} */
    this.listeners = {};
    /** @type {Record<string, string>} */
    this.style = {};
    this.clientWidth = 0;
  }

  getAttribute(name) {
    return this.attributes.get(name.toLowerCase()) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name.toLowerCase(), String(value));
  }

  hasAttribute(name) {
    return this.attributes.has(name.toLowerCase());
  }

  removeAttribute(name) {
    this.attributes.delete(name.toLowerCase());
  }

  #flag(name, on) {
    if (on) this.setAttribute(name, "");
    else this.removeAttribute(name);
  }

  get id() {
    return this.getAttribute("id") ?? "";
  }

  get hidden() {
    return this.hasAttribute("hidden");
  }

  set hidden(on) {
    this.#flag("hidden", on);
  }

  get disabled() {
    return this.hasAttribute("disabled");
  }

  set disabled(on) {
    this.#flag("disabled", on);
  }

  get open() {
    return this.hasAttribute("open");
  }

  set open(on) {
    this.#flag("open", on);
  }

  get className() {
    return this.getAttribute("class") ?? "";
  }

  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    const write = (list) => this.setAttribute("class", list.join(" "));
    return {
      contains: (name) => names().includes(name),
      add: (...add) => write([...new Set([...names(), ...add])]),
      remove: (...remove) => write(names().filter((name) => !remove.includes(name))),
      toggle: (name, force) => {
        const on = force ?? !names().includes(name);
        write(on ? [...new Set([...names(), name])] : names().filter((n) => n !== name));
        return on;
      },
    };
  }

  get dataset() {
    const attr = (key) => `data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    return new Proxy(
      {},
      {
        get: (_, key) => this.getAttribute(attr(key)) ?? undefined,
        set: (_, key, value) => {
          this.setAttribute(attr(key), value);
          return true;
        },
      },
    );
  }

  get children() {
    return /** @type {Element[]} */ (this.childNodes.filter((node) => node.nodeType === 1));
  }

  get childElementCount() {
    return this.children.length;
  }

  /** @param {(Element | TextNode | string)[]} nodes */
  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === "string" ? new TextNode(node) : node;
      if (child.parentNode) child.parentNode.childNodes = child.parentNode.childNodes.filter((n) => n !== child);
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }

  /** @param {(Element | TextNode | string)[]} nodes */
  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }

  remove() {
    if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((n) => n !== this);
    this.parentNode = null;
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join("");
  }

  set textContent(text) {
    this.replaceChildren(String(text ?? ""));
  }

  set innerHTML(html) {
    this.replaceChildren(...parseFragment(String(html), this.ownerDocument));
  }

  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }

  removeEventListener(type, listener) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== listener);
  }

  /** @param {{ type: string }} event */
  dispatchEvent(event) {
    for (const listener of this.listeners[event.type] ?? []) listener.call(this, { target: this, currentTarget: this, preventDefault() {}, ...event });
    return true;
  }

  click() {
    this.dispatchEvent({ type: "click", detail: 0 });
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  /** @returns {Generator<Element>} */
  *descendants() {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }

  /** @param {string} selector */
  matches(selector) {
    return parseSelector(selector).some((complex) => matchComplex(this, complex));
  }

  /** @param {string} selector */
  closest(selector) {
    for (let el = /** @type {Element | null} */ (this); el; el = el.parentNode) if (el.matches(selector)) return el;
    return null;
  }

  /** @param {string} selector @returns {Element[]} */
  querySelectorAll(selector) {
    const groups = parseSelector(selector);
    return [...this.descendants()].filter((el) => groups.some((complex) => matchComplex(el, complex)));
  }

  /** @param {string} selector */
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /** A short description for messages: tag, id, classes and the first words of text. */
  describe() {
    const id = this.id ? `#${this.id}` : "";
    const classes = this.className ? `.${this.className.trim().split(/\s+/).join(".")}` : "";
    const text = this.textContent.replace(/\s+/g, " ").trim().slice(0, 40);
    return `<${this.localName}${id}${classes}>${text ? ` "${text}"` : ""}`;
  }
}

export class MiniDocument {
  constructor() {
    this.documentElement = new Element("html", this);
    this.title = "";
    /** @type {Element | null} */
    this.activeElement = null;
  }

  createElement(tag) {
    return new Element(tag, this);
  }

  createTextNode(text) {
    return new TextNode(text);
  }

  get head() {
    return this.documentElement.querySelector("head");
  }

  get body() {
    return this.documentElement.querySelector("body");
  }

  getElementById(id) {
    for (const el of this.documentElement.descendants()) if (el.getAttribute("id") === id) return el;
    return null;
  }

  querySelectorAll(selector) {
    return [this.documentElement, ...this.documentElement.querySelectorAll(selector)].filter((el) => el.matches(selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

/**
 * @typedef {{ tag: string | null, id: string | null, classes: string[], attrs: { name: string, op: string | null, value: string }[] }} Compound
 * @typedef {Compound[]} Complex descendant combinators only
 */

/** @param {string} selector @returns {Complex[]} */
function parseSelector(selector) {
  return selector.split(",").map((group) =>
    group
      .trim()
      .split(/\s+(?![^[]*\])/)
      .map((part) => {
        /** @type {Compound} */
        const compound = { tag: null, id: null, classes: [], attrs: [] };
        const pattern = /^([a-z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:([\^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]/gi;
        let rest = part;
        for (const match of part.matchAll(pattern)) {
          rest = rest.replace(match[0], "");
          if (match[1] && match[1] !== "*") compound.tag = match[1].toLowerCase();
          else if (match[2]) compound.id = match[2];
          else if (match[3]) compound.classes.push(match[3]);
          else if (match[4]) compound.attrs.push({ name: match[4].toLowerCase(), op: match[5] ?? null, value: match[6] ?? match[7] ?? match[8] ?? "" });
        }
        if (rest.trim() !== "") throw new SyntaxError(`unsupported selector: ${selector}`);
        return compound;
      }),
  );
}

/** @param {Element} el @param {Compound} c */
function matchCompound(el, c) {
  if (c.tag && el.localName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  if (c.classes.some((name) => !el.classList.contains(name))) return false;
  return c.attrs.every(({ name, op, value }) => {
    const actual = el.getAttribute(name);
    if (actual === null) return false;
    if (op === "=") return actual === value;
    if (op === "^=") return actual.startsWith(value);
    if (op === "$=") return actual.endsWith(value);
    if (op === "*=") return actual.includes(value);
    return true;
  });
}

/** @param {Element} el @param {Complex} complex */
function matchComplex(el, complex) {
  if (!matchCompound(el, complex.at(-1))) return false;
  let i = complex.length - 2;
  for (let up = el.parentNode; up && i >= 0; up = up.parentNode) if (matchCompound(up, complex[i])) i -= 1;
  return i < 0;
}

/**
 * Parses HTML into `parent`. Forgiving like a browser for the cases our pages use: void
 * elements, raw-text script and style, implied ends of li, dt, dd, option, table parts and p.
 * @param {string} html
 * @param {Element} parent
 */
function parseInto(html, parent) {
  const owner = parent.ownerDocument;
  const stack = [parent];
  const top = () => stack[stack.length - 1];
  const close = (tag) => {
    const index = stack.findLastIndex((el, i) => i > 0 && el.localName === tag);
    if (index > 0) stack.length = index;
  };
  const tagPattern = /<!--[\s\S]*?-->|<![^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
  let last = 0;
  for (let match; (match = tagPattern.exec(html)); ) {
    if (match.index > last) top().append(decode(html.slice(last, match.index)));
    last = tagPattern.lastIndex;
    if (match[1]) {
      close(match[1].toLowerCase());
      continue;
    }
    if (!match[2]) continue;
    const tag = match[2].toLowerCase();
    if (CLOSES_P.has(tag) && top().localName === "p") stack.pop();
    for (const ended of IMPLIED_END[tag] ?? []) if (top().localName === ended) stack.pop();
    if (IMPLIED_END[tag] && top().localName === tag) stack.pop();
    const el = new Element(tag, owner);
    for (const [, name, value] of (match[3] ?? "").matchAll(/([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g)) {
      el.setAttribute(name, value === undefined ? "" : decode(value.replace(/^["']|["']$/g, "")));
    }
    top().append(el);
    if (RAW_TEXT.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, last);
      const stop = end < 0 ? html.length : end;
      el.append(html.slice(last, stop));
      tagPattern.lastIndex = last = end < 0 ? html.length : html.indexOf(">", end) + 1;
      continue;
    }
    if (!VOID.has(tag) && !match[4]) stack.push(el);
  }
  if (last < html.length) top().append(decode(html.slice(last)));
}

/** @param {string} html @param {MiniDocument | null} owner */
function parseFragment(html, owner) {
  const holder = new Element("template", owner);
  parseInto(html, holder);
  return [...holder.childNodes];
}

/** @param {string} html */
export function parseHtml(html) {
  const doc = new MiniDocument();
  const holder = new Element("template", doc);
  parseInto(html, holder);
  const root = holder.children.find((el) => el.localName === "html");
  if (root) {
    root.parentNode = null;
    doc.documentElement = root;
  } else {
    doc.documentElement.append(...holder.childNodes);
  }
  return doc;
}

const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]";
const LANDMARK_TAGS = new Set(["header", "footer", "nav", "main", "aside"]);
const LANDMARK_ROLES = new Set(["banner", "contentinfo", "navigation", "main", "complementary", "region", "search", "form"]);
const SECTIONING = new Set(["article", "aside", "main", "nav", "section"]);
const NAME_FROM_CONTENT = new Set([
  "a", "button", "summary", "h1", "h2", "h3", "h4", "h5", "h6", "label", "legend", "caption", "option", "th", "td",
  "link", "tab", "menuitem", "checkbox", "radio", "switch", "heading", "cell", "columnheader", "rowheader",
]);

/** @param {Element} el */
const isHidden = (el) => {
  for (let node = /** @type {Element | null} */ (el); node; node = node.parentNode) {
    if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return true;
    if (node.localName === "template" || node.localName === "noscript") return true;
  }
  return false;
};

/** @param {Element} el */
const isLandmark = (el) => {
  const role = el.getAttribute("role");
  if (role) return LANDMARK_ROLES.has(role) && (role !== "region" || hasOwnName(el));
  if (el.localName === "section" || el.localName === "form") return hasOwnName(el);
  return LANDMARK_TAGS.has(el.localName);
};

/** @param {Element} el */
const hasOwnName = (el) => Boolean(el.getAttribute("aria-label")?.trim() || el.getAttribute("aria-labelledby")?.trim());

/** Visible text of a subtree for name computation: hidden parts left out, image alts in. @param {Element} el @param {Element} [skip] */
function nameText(el, skip) {
  let text = "";
  for (const node of el.childNodes) {
    if (node.nodeType === 3) text += /** @type {TextNode} */ (node).data;
    else {
      const child = /** @type {Element} */ (node);
      if (child === skip || child.hasAttribute("hidden") || child.getAttribute("aria-hidden") === "true") continue;
      if (child.localName === "select" || child.localName === "script" || child.localName === "style") continue;
      if (child.localName === "img") text += ` ${child.getAttribute("alt") ?? ""} `;
      else if (child.getAttribute("aria-label")) text += ` ${child.getAttribute("aria-label")} `;
      else text += nameText(child, skip);
    }
  }
  return text;
}

/**
 * The accessible name, simplified from the accname algorithm: aria-labelledby, aria-label,
 * labels for form controls, alt for images, then contents for buttons, links and summaries,
 * then title.
 * @param {Element} el
 * @param {MiniDocument} doc
 */
export function accessibleName(el, doc) {
  const clean = (text) => text.replace(/\s+/g, " ").trim();
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = clean(labelledBy.split(/\s+/).map((id) => (doc.getElementById(id) ? nameText(doc.getElementById(id)) : "")).join(" "));
    if (text) return text;
  }
  const label = clean(el.getAttribute("aria-label") ?? "");
  if (label) return label;
  const tag = el.localName;
  const type = (el.getAttribute("type") ?? "text").toLowerCase();
  if (tag === "input" && ["button", "submit", "reset"].includes(type)) return clean(el.getAttribute("value") ?? (type === "button" ? "" : type));
  if (tag === "input" && type === "image") return clean(el.getAttribute("alt") ?? "");
  if (tag === "input" || tag === "select" || tag === "textarea") {
    const texts = [];
    if (el.id) for (const l of doc.querySelectorAll("label")) if (l.getAttribute("for") === el.id) texts.push(nameText(l, el));
    const wrapping = el.parentNode?.closest("label");
    if (wrapping) texts.push(nameText(wrapping, el));
    const text = clean(texts.join(" "));
    if (text) return text;
  } else if (tag === "img" || tag === "area") {
    return clean(el.getAttribute("alt") ?? "");
  } else if (tag === "svg") {
    const title = el.children.find((child) => child.localName === "title");
    if (title) return clean(title.textContent);
  } else if (tag === "fieldset") {
    const legend = el.children.find((child) => child.localName === "legend");
    if (legend) return clean(nameText(legend));
  } else if (tag === "table") {
    const caption = el.children.find((child) => child.localName === "caption");
    if (caption) return clean(nameText(caption));
  } else if (NAME_FROM_CONTENT.has(tag) || NAME_FROM_CONTENT.has(el.getAttribute("role") ?? "")) {
    const text = clean(nameText(el));
    if (text) return text;
  }
  return clean(el.getAttribute("title") ?? "");
}

/**
 * Structural checks of a whole page (or a page with its scripts' output rendered into it).
 * @param {MiniDocument} doc
 * @returns {Finding[]}
 */
export function checkDocument(doc) {
  /** @type {Finding[]} */
  const findings = [];
  const find = (rule, message) => findings.push({ rule, message });
  const html = doc.documentElement;
  const all = [html, ...html.descendants()];
  const shown = all.filter((el) => !isHidden(el));

  const lang = html.getAttribute("lang") ?? "";
  if (!/^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(lang)) find("lang", `<html> needs a lang attribute (got "${lang}")`);
  const title = doc.querySelector("title");
  if (!title || !title.textContent.trim()) find("title", "the page has no <title>");
  const viewport = doc.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "";
  const maxScale = /maximum-scale\s*=\s*([\d.]+)/.exec(viewport);
  if (/user-scalable\s*=\s*(no|0)/i.test(viewport) || (maxScale && Number(maxScale[1]) < 2)) {
    find("viewport-zoom", `the viewport meta blocks zooming: "${viewport}"`);
  }

  const h1s = all.filter((el) => el.localName === "h1");
  if (h1s.length !== 1) find("one-h1", `the page has ${h1s.length} <h1> elements; it needs exactly one`);
  let level = 0;
  for (const heading of shown.filter((el) => /^h[1-6]$/.test(el.localName))) {
    const next = Number(heading.localName[1]);
    if (level > 0 && next > level + 1) find("heading-order", `${heading.describe()} skips from h${level} to h${next}`);
    if (!heading.textContent.trim()) find("heading-empty", `${heading.describe()} is empty`);
    level = next;
  }

  const body = doc.body ?? html;
  const mains = all.filter((el) => el.localName === "main" || el.getAttribute("role") === "main");
  if (mains.length !== 1) find("main-landmark", `the page has ${mains.length} main landmarks; it needs exactly one`);
  const inSectioning = (el) => {
    for (let up = el.parentNode; up && up !== body; up = up.parentNode) if (SECTIONING.has(up.localName)) return true;
    return false;
  };
  const banners = all.filter((el) => el.getAttribute("role") === "banner" || (el.localName === "header" && !inSectioning(el)));
  const footers = all.filter((el) => el.getAttribute("role") === "contentinfo" || (el.localName === "footer" && !inSectioning(el)));
  if (banners.length > 1) find("banner-count", `the page has ${banners.length} banner landmarks`);
  if (footers.length > 1) find("contentinfo-count", `the page has ${footers.length} contentinfo landmarks`);
  for (const el of shown) {
    if (["script", "style", "template", "noscript", "head", "html", "body"].includes(el.localName)) continue;
    const text = el.childNodes.some((node) => node.nodeType === 3 && /** @type {TextNode} */ (node).data.trim());
    if (!text) continue;
    let landmark = false;
    for (let up = /** @type {Element | null} */ (el); up && up !== body; up = up.parentNode) if (isLandmark(up)) landmark = true;
    const skipLink = el.localName === "a" && (el.getAttribute("href") ?? "").startsWith("#") && el.parentNode === body;
    if (!landmark && !skipLink && el.closest("head") === null) find("outside-landmark", `${el.describe()} is outside every landmark`);
  }

  for (const el of shown) {
    const tag = el.localName;
    const role = el.getAttribute("role");
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    const name = () => accessibleName(el, doc);
    if ((tag === "input" && type !== "hidden") || tag === "select" || tag === "textarea") {
      if (!name()) find("control-label", `${el.describe()} has no label`);
    } else if (tag === "button" || role === "button" || tag === "summary") {
      if (!name()) find("button-name", `${el.describe()} has no accessible name`);
    } else if (tag === "a" && el.hasAttribute("href")) {
      if (!name()) find("link-name", `${el.describe()} has no text`);
    } else if (tag === "img") {
      if (!el.hasAttribute("alt")) find("img-alt", `${el.describe()} has no alt attribute`);
    } else if (tag === "svg") {
      if (!(role === "img" && name())) find("svg-name", `${el.describe()} is neither aria-hidden nor role="img" with a name`);
    } else if (tag === "fieldset" || role === "group" || role === "radiogroup") {
      if (!name()) find("group-name", `${el.describe()} has no legend or label`);
    } else if (tag === "table") {
      if (!name()) find("table-caption", `${el.describe()} has no caption`);
      if (el.querySelectorAll("th").length === 0) find("table-headers", `${el.describe()} has no header cells`);
    }
    if (Number(el.getAttribute("tabindex")) > 0) find("tabindex-positive", `${el.describe()} has a positive tabindex`);
  }
  for (const el of all) {
    if (el.getAttribute("aria-hidden") !== "true") continue;
    for (const inner of [el, ...el.descendants()]) {
      if (inner.matches(FOCUSABLE) && inner.getAttribute("tabindex") !== "-1" && !inner.hasAttribute("disabled")) {
        find("aria-hidden-focus", `${inner.describe()} can take focus inside aria-hidden content`);
      }
    }
  }

  /** @type {Map<string, number>} */
  const ids = new Map();
  for (const el of all) if (el.hasAttribute("id")) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
  for (const [id, count] of ids) if (count > 1) find("duplicate-id", `id "${id}" is used ${count} times`);
  for (const el of all) {
    for (const attr of ["for", "aria-labelledby", "aria-describedby", "aria-controls", "aria-owns", "headers"]) {
      if (attr === "for" && el.localName !== "label") continue;
      const value = el.getAttribute(attr);
      if (value === null) continue;
      for (const id of value.split(/\s+/).filter(Boolean)) if (!ids.has(id)) find("idref", `${el.describe()} ${attr}="${id}" points at no element`);
    }
  }
  return findings;
}

/**
 * @typedef {{ light: Record<string, string>, dark: Record<string, string> }} SchemeTokens
 * @typedef {Map<string, SchemeTokens>} Tokens custom properties by selector (":root", ".surface", ...)
 */

/**
 * The custom properties a set of stylesheets declares, per selector, in the light scheme and
 * under `@media (prefers-color-scheme: dark)`. Later sheets override earlier ones.
 * @param {string[]} sheets
 * @returns {Tokens}
 */
export function cssTokens(sheets) {
  /** @type {Tokens} */
  const tokens = new Map();
  const visit = (css, scheme) => {
    let i = 0;
    while (i < css.length) {
      const open = css.indexOf("{", i);
      if (open < 0) break;
      const prelude = css.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < css.length && depth > 0) {
        if (css[j] === "{") depth += 1;
        else if (css[j] === "}") depth -= 1;
        j += 1;
      }
      const block = css.slice(open + 1, j - 1);
      if (prelude.startsWith("@media")) {
        if (/prefers-color-scheme\s*:\s*dark/.test(prelude)) visit(block, "dark");
        else if (!/prefers-color-scheme/.test(prelude)) visit(block, scheme);
      } else if (!prelude.startsWith("@")) {
        for (const selector of prelude.split(",").map((s) => s.trim())) {
          for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
            if (!tokens.has(selector)) tokens.set(selector, { light: {}, dark: {} });
            tokens.get(selector)[scheme][name] = value.trim();
          }
        }
      }
      i = j;
    }
  };
  for (const sheet of sheets) visit(sheet.replace(/\/\*[\s\S]*?\*\//g, ""), "light");
  return tokens;
}

/**
 * A token's value as an opaque color, alpha blended over `under` when it has one.
 * @param {Tokens} tokens
 * @param {string} value a token name, var() or color
 * @param {{ scheme: "light" | "dark", scope?: string, under?: string }} context
 * @returns {string | null} #rrggbb
 */
export function resolveColor(tokens, value, { scheme, scope = ":root", under = "#ffffff" }) {
  const lookup = (name) => {
    for (const selector of scope === ":root" ? [":root"] : [scope, ":root"]) {
      const set = tokens.get(selector);
      const found = scheme === "dark" ? (set?.dark[name] ?? set?.light[name]) : set?.light[name];
      if (found !== undefined) return found;
    }
    return undefined;
  };
  let text = value.startsWith("--") ? `var(${value})` : value;
  for (let depth = 0; depth < 10 && text.includes("var("); depth += 1) {
    text = text.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/, (_, name, fallback) => lookup(name) ?? fallback?.trim() ?? "");
  }
  text = text.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/.exec(text);
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith("%") ? Number(rgb[4].slice(0, -1)) / 100 : Number(rgb[4]);
    const base = parseHex(under);
    return toHex(/** @type {[number, number, number]} */ ([1, 2, 3].map((k, i) => (Number(rgb[k]) / 255) * alpha + base[i] * (1 - alpha))));
  }
  if (text === "white") return "#ffffff";
  if (text === "black") return "#000000";
  return null;
}

/**
 * @typedef {{ fg: string, bg: string, min: number, what: string, scope?: string, cell?: boolean }} Pair
 * `cell` pairs are calendar fills: they pass when the fill or the edge the calendar draws around
 * it (edgeColor) reaches `min`, and the black or white hatch and dot marks reach 4.5:1 on them.
 */
const text = (fg, bg, what, scope) => ({ fg, bg, min: 4.5, what, scope });
const ui = (fg, bg, what, scope) => ({ fg, bg, min: 3, what, scope });
const cells = (names) => names.map((fg) => ({ fg, bg: "--bg", min: 3, what: "calendar cell", cell: true }));

const BASE_PAIRS = [text("--fg", "--bg", "body text"), text("--muted", "--bg", "muted text"), text("--link", "--bg", "links")];

/** The color pairs each page draws, by token. Pages not listed get BASE_PAIRS. @type {Record<string, Pair[]>} */
export const PAGE_PAIRS = {
  "/": [
    ...BASE_PAIRS,
    text("--fg", "--page", "text on the page background"),
    text("--muted", "--page", "muted text on the page background"),
    text("--link", "--page", "links on the page background"),
    text("--accent-fg", "--accent", "pressed buttons and the chosen view"),
    text("--warning-fg", "--warning-bg", "warnings"),
    text("--error-fg", "--error-bg", "error messages"),
    text("--hot", "--bg", "the HOT verdict"),
    text("--not", "--bg", "the NOT verdict"),
    text("--hon-error", "--hon-surface", "box form errors", ".hon-map"),
    ui("--focus", "--bg", "focus ring"),
    ui("--focus", "--page", "focus ring on the page background"),
    ui("--accent", "--bg", "pressed state"),
    ui("--control-border", "--bg", "input and select borders"),
    ui("--control-border", "--page", "input and select borders on the page background"),
    ui("--hon-focus", "--hon-surface", "map focus ring", ".hon-map"),
    ui("--hon-control-border", "--hon-surface", "box form input borders", ".hon-map"),
    ui("--cal-outline", "--bg", "no-data outline and not-enough-history stripes"),
    ui("--cal-season", "--bg", "fire-season band"),
    ...cells([...Array.from({ length: 11 }, (_, i) => `--cal-seq-${i}`), ...Array.from({ length: 9 }, (_, i) => `--cal-div-${i}`), "--cal-zero"]),
  ],
  "/method.html": [
    ...BASE_PAIRS,
    text("--pass", "--bg", "passing scores"),
    text("--fail", "--bg", "failing scores"),
    text("--fg", "--panel", "decision box"),
    text("--muted", "--panel", "decision rule"),
    text("--fg", "--notice-bg", "notices and badges"),
    ui("--link", "--bg", "focus ring"),
    text("--fg", "#ffffff", "chart cards", ".surface"),
    text("--muted", "#ffffff", "chart card notes", ".surface"),
    text("--link", "#ffffff", "chart card links", ".surface"),
  ],
};

/**
 * @param {Tokens} tokens
 * @param {Pair[]} pairs
 * @returns {{ findings: Finding[], results: { scheme: string, pair: Pair, ratio: number, fg: string, bg: string }[] }}
 */
export function checkContrast(tokens, pairs) {
  /** @type {Finding[]} */
  const findings = [];
  const results = [];
  for (const scheme of /** @type {const} */ (["light", "dark"])) {
    for (const pair of pairs) {
      const bg = resolveColor(tokens, pair.bg, { scheme, scope: pair.scope });
      const fg = bg && resolveColor(tokens, pair.fg, { scheme, scope: pair.scope, under: bg });
      if (!bg || !fg) {
        findings.push({ rule: "contrast-token", message: `${scheme}: ${pair.fg} on ${pair.bg} (${pair.what}) is not a color the checker can read` });
        continue;
      }
      let ratio = contrastRatio(fg, bg);
      if (pair.cell) {
        ratio = Math.max(ratio, contrastRatio(edgeColor(fg, bg, pair.min) ?? fg, bg));
        const marks = contrastRatio(markColor(fg), fg);
        if (marks < 4.5) findings.push({ rule: "contrast", message: `${scheme}: hatch and dot marks on ${pair.fg} ${fg} are ${marks.toFixed(2)}:1, below 4.5:1` });
      }
      results.push({ scheme, pair, ratio, fg, bg });
      if (ratio < pair.min) {
        findings.push({
          rule: "contrast",
          message: `${scheme}: ${pair.fg} ${fg} on ${pair.bg} ${bg} (${pair.what}) is ${ratio.toFixed(2)}:1, below ${pair.min}:1`,
        });
      }
    }
  }
  return { findings, results };
}

/** Import specifiers of an ES module, as tests/e2e.test.js finds them. */
function moduleReferences(source) {
  const patterns = [
    /\bimport\s+(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

/**
 * @typedef {{ url: string, kind: "html" | "script" | "module" | "css" | "api", status: number, bytes: number,
 *   gzip: number, cacheControl: string | null, contentType: string | null, body: string }} Asset
 */

/** @param {string} url @param {RequestInit} [init] @param {Asset["kind"]} kind @returns {Promise<Asset>} */
async function load(url, kind, init) {
  const response = await fetch(url, init);
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    url,
    kind,
    status: response.status,
    bytes: buffer.length,
    gzip: gzipSync(buffer).length,
    cacheControl: response.headers.get("cache-control"),
    contentType: response.headers.get("content-type"),
    body: buffer.toString("utf8"),
  };
}

/** The API calls each page makes on its first load, in its default state. */
const FIRST_API_CALLS = {
  "/": async (base) => {
    const metadata = await load(new URL("/api/metadata", base).href, "api");
    const meta = JSON.parse(metadata.body);
    const state = parseState("");
    const aoi = areaPolygon(state.area, meta.regions.find((region) => region.id === state.region));
    const post = (path, body) =>
      load(new URL(path, base).href, "api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return [metadata, await post("/api/calendar", calendarBody(aoi, state, meta)), await post("/api/current-month", { aoi })];
  },
  "/method.html": async (base) => [await load(new URL("/api/method", base).href, "api")],
};

/**
 * Everything a page loads before any user action, basemap tiles aside: the HTML, its
 * stylesheets and classic scripts, the module graph and the first API responses.
 * @param {string} base
 * @param {string} path
 * @returns {Promise<Asset[]>}
 */
export async function pageAssets(base, path) {
  const page = await load(new URL(path, base).href, "html");
  const doc = parseHtml(page.body);
  /** @type {{ url: string, kind: Asset["kind"] }[]} */
  const queue = [];
  for (const el of doc.querySelectorAll("script[src]")) {
    queue.push({ url: new URL(el.getAttribute("src"), page.url).href, kind: el.getAttribute("type") === "module" ? "module" : "script" });
  }
  for (const el of doc.querySelectorAll("link[href]")) {
    const rel = el.getAttribute("rel");
    if (rel === "stylesheet") queue.push({ url: new URL(el.getAttribute("href"), page.url).href, kind: "css" });
    if (rel === "modulepreload") queue.push({ url: new URL(el.getAttribute("href"), page.url).href, kind: "module" });
  }
  for (const el of doc.querySelectorAll("script")) {
    if (el.getAttribute("type") !== "module" || el.hasAttribute("src")) continue;
    for (const specifier of moduleReferences(el.textContent)) queue.push({ url: new URL(specifier, page.url).href, kind: "module" });
  }
  const assets = [page];
  const seen = new Set([page.url]);
  while (queue.length > 0) {
    const next = /** @type {{ url: string, kind: Asset["kind"] }} */ (queue.shift());
    if (seen.has(next.url)) continue;
    seen.add(next.url);
    const kind = next.url.split("?")[0].endsWith(".css") ? "css" : next.kind;
    const asset = await load(next.url, kind);
    assets.push(asset);
    if (kind === "module") {
      for (const specifier of moduleReferences(asset.body)) {
        const url = new URL(specifier, next.url).href;
        queue.push({ url, kind: url.endsWith(".css") ? "css" : "module" });
      }
    }
  }
  const api = FIRST_API_CALLS[path];
  if (api) assets.push(...(await api(base)));
  return assets;
}

const ECHARTS_STUB = {
  init(dom) {
    return {
      setOption(option) {
        const description = option?.aria?.label?.description;
        if (option?.aria?.enabled && description) {
          dom.setAttribute("role", "img");
          dom.setAttribute("aria-label", description);
        }
      },
      resize() {},
      dispose() {},
      getDataURL: () => "data:image/png;base64,",
    };
  },
};

class MapStub {
  constructor({ container, locale }) {
    this.keyboard = { disableRotation() {} };
    this.touchZoomRotate = { disableRotation() {} };
    const holder = container.ownerDocument.createElement("div");
    holder.setAttribute("class", "maplibregl-canvas-container");
    this.canvas = container.ownerDocument.createElement("canvas");
    this.canvas.setAttribute("tabindex", "0");
    this.canvas.setAttribute("role", "region");
    this.canvas.setAttribute("aria-label", locale?.["Map.Title"] ?? "Map");
    holder.append(this.canvas);
    container.append(holder);
  }
  once() {}
  on() {}
  addControl() {}
  getCanvas() {
    return this.canvas;
  }
  fitBounds() {}
  getSource() {
    return undefined;
  }
}

const BROWSER_STUBS = {
  echarts: ECHARTS_STUB,
  maplibregl: { Map: MapStub, NavigationControl: class {}, ScaleControl: class {} },
  terraDraw: {
    TerraDraw: class {
      on() {}
      start() {}
      setMode() {}
    },
    TerraDrawPolygonMode: class {},
    TerraDrawSelectMode: class {},
    ValidateNotSelfIntersecting: () => ({ valid: true }),
  },
  terraDrawMaplibreGlAdapter: { TerraDrawMapLibreGLAdapter: class {} },
};

/**
 * Runs `render` with browser-like globals: `document` is `doc`, `fetch` goes to `base`, and the
 * vendored libraries are stand-ins. Resolves once no request has been in flight for 100 ms.
 * @param {MiniDocument} doc
 * @param {string} base
 * @param {string} path
 * @param {() => Promise<void>} render
 */
export async function withPageGlobals(doc, base, path, render) {
  const realFetch = globalThis.fetch;
  let inFlight = 0;
  const globals = {
    ...BROWSER_STUBS,
    document: doc,
    location: { pathname: path, search: "", hash: "", href: new URL(path, base).href },
    history: { state: null, replaceState() {} },
    fetch: (input, init) => {
      inFlight += 1;
      return realFetch(new URL(String(input), base), init).finally(() => (inFlight -= 1));
    },
  };
  const saved = Object.fromEntries(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  try {
    await render();
    let quiet = 0;
    for (let waited = 0; quiet < 5 && waited < 15_000; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      quiet = inFlight === 0 ? quiet + 1 : 0;
    }
  } finally {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

/**
 * Renders a page with its own modules from this checkout's public/ (they must match what `base`
 * serves). Every <details> is opened, so tables filled on demand are checked too.
 * @type {Record<string, (doc: MiniDocument) => Promise<void>>}
 */
export const RENDERERS = {
  "/": async (doc) => {
    doc.getElementById("calendar-numbers")?.setAttribute("open", "");
    const { startApp } = await import("../public/js/app.js");
    await startApp(/** @type {any} */ (doc));
  },
  "/method.html": async (doc) => {
    const { startMethodPage } = await import("../public/js/method/page.js");
    await startMethodPage(/** @type {any} */ (doc));
    for (const details of doc.querySelectorAll("details")) {
      details.open = true;
      details.dispatchEvent({ type: "toggle" });
    }
  },
};

/**
 * @param {string} base
 * @param {string} path
 * @returns {Promise<{ path: string, findings: Finding[], served: Finding[], rendered: Finding[] | null,
 *   contrast: ReturnType<typeof checkContrast>, assets: Asset[], doc: MiniDocument | null }>}
 */
export async function auditPage(base, path) {
  const assets = await pageAssets(base, path);
  const html = assets[0];
  if (html.status !== 200) {
    const findings = [{ rule: "status", message: `${path} answered ${html.status}` }];
    return { path, findings, served: findings, rendered: null, contrast: { findings: [], results: [] }, assets, doc: null };
  }
  const served = checkDocument(parseHtml(html.body));
  let rendered = null;
  let doc = null;
  const renderer = RENDERERS[path];
  if (renderer) {
    const page = parseHtml(html.body);
    await withPageGlobals(page, base, path, () => renderer(page));
    rendered = checkDocument(page);
    doc = page;
  }
  const sheets = assets.filter((asset) => asset.kind === "css").map((asset) => asset.body);
  const contrast = checkContrast(cssTokens(sheets), PAGE_PAIRS[path] ?? BASE_PAIRS);
  const seen = new Set();
  const findings = [...served, ...(rendered ?? []), ...contrast.findings].filter((finding) => {
    const key = `${finding.rule} ${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { path, findings, served, rendered, contrast, assets, doc };
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

/** @param {Asset[]} assets */
export function transferTotals(assets) {
  return {
    files: assets.length,
    bytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
    gzip: assets.reduce((sum, asset) => sum + asset.gzip, 0),
  };
}

async function main(argv) {
  const transfer = argv.includes("--transfer");
  const pagesArg = argv.find((arg) => arg.startsWith("--pages="));
  const pages = pagesArg ? pagesArg.slice("--pages=".length).split(",") : DEFAULT_PAGES;
  let base = argv.find((arg) => /^https?:\/\//.test(arg));
  let server = null;
  if (!base) {
    const { createAppServer } = await import("../server.js");
    server = createAppServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  let failed = 0;
  try {
    for (const path of pages) {
      const report = await auditPage(base, path);
      const worst = (scheme) => Math.min(...report.contrast.results.filter((r) => r.scheme === scheme).map((r) => r.ratio));
      console.log(
        `${path}: ${report.findings.length === 0 ? "ok" : `${report.findings.length} problem${report.findings.length === 1 ? "" : "s"}`}` +
          ` (served HTML ${report.served.length}, rendered ${report.rendered ? report.rendered.length : "not rendered"},` +
          ` ${report.contrast.results.length} color pairs, lowest light ${worst("light").toFixed(2)}:1, dark ${worst("dark").toFixed(2)}:1)`,
      );
      for (const finding of report.findings) console.log(`  ${finding.rule}: ${finding.message}`);
      failed += report.findings.length;
      if (transfer) {
        for (const asset of report.assets) {
          const url = new URL(asset.url);
          console.log(
            `  ${String(asset.status).padEnd(4)}${asset.kind.padEnd(7)}${kb(asset.bytes).padStart(10)}${kb(asset.gzip).padStart(10)} gz  ` +
              `${(url.pathname + url.search).padEnd(48)} ${asset.cacheControl ?? "-"}`,
          );
        }
        const total = transferTotals(report.assets);
        console.log(`  total: ${total.files} responses, ${kb(total.bytes)} (${kb(total.gzip)} gzipped)`);
      }
    }
  } finally {
    server?.close();
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
