/**
 * @param {string} tag
 * @param {Record<string, string | number | boolean | undefined | null | ((event: Event) => void)>} [attributes]
 *   `text` sets textContent, `on<event>` adds a listener, `false`/`null`/`undefined` are skipped
 * @param {(Node | string | null | undefined | false)[]} children
 */
export function h(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === "text") node.textContent = String(value);
    else if (name.startsWith("on") && typeof value === "function") node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

/**
 * Lines of placeholder blocks shown while data loads, hidden from assistive technology.
 * @param {string[]} widths CSS widths, one per line
 */
export function skeleton(widths) {
  return h("div", { class: "skeleton", "aria-hidden": "true" }, ...widths.map((width) => h("span", { class: "skeleton__line", style: `width: ${width}` })));
}
