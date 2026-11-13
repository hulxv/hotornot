// The accessibility and performance pass: scripts/a11y-check.js against the pages server.js
// serves (on the W02 fixture), the checker's own rules, the calendar's cell edges and table
// fallback, the map's keyboard route, cache headers, preloads and scripts/prewarm.js.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { mockCalendar, mocks } from "../mocks/index.js";
import { contrastRatio, edgeColor, rampColor } from "../public/js/calendar/color.js";
import { cellShapes } from "../public/js/calendar/option.js";
import { CALENDAR_PALETTE, CALENDAR_PALETTE_DARK } from "../public/js/calendar/palette.js";
import { calendarTable, calendarTableHtml } from "../public/js/calendar/table.js";
import { calendarBody } from "../public/js/client-api.js";
import { errorMessage } from "../public/js/panels/messages.js";
import { DEFAULT_STATE, areaPolygon } from "../public/js/url-state.js";
import { ERROR_CODES } from "../public/shared/contracts.js";
import {
  DEFAULT_PAGES,
  accessibleName,
  auditPage,
  checkContrast,
  checkDocument,
  cssTokens,
  pageAssets,
  parseHtml,
  resolveColor,
  transferTotals,
} from "../scripts/a11y-check.js";
import { prewarm, prewarmCalls } from "../scripts/prewarm.js";
import { fixtureDir } from "./fixtures/fixture.js";

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = join(WEB_DIR, "public");
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

const page = (body, head = "<title>T</title>") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
const rules = (html) => [...new Set(checkDocument(parseHtml(html)).map((finding) => finding.rule))].sort();

describe("the checker's HTML parser", () => {
  const doc = parseHtml(
    '<!DOCTYPE html><html lang="en"><head><title>A &amp; B</title><script>if (a < b && c > d) x("</p>");</script></head>' +
      '<body><ul><li>one<li>two</ul><p>a &lt;b&gt; &#8722;3<div id="d" class="x y" data-kind="k">div</div>' +
      '<img src="i.png" alt=""><input name=view value=v><label for="f">F</label><input id="f"></body></html>',
  );

  it("builds the tree a browser would for these cases", () => {
    assert.equal(doc.documentElement.getAttribute("lang"), "en");
    assert.equal(doc.querySelector("title").textContent, "A & B");
    assert.equal(doc.querySelector("script").textContent, 'if (a < b && c > d) x("</p>");');
    assert.equal(doc.querySelectorAll("li").length, 2);
    assert.equal(doc.querySelector("p").textContent, "a <b> −3");
    assert.equal(doc.getElementById("d").parentNode.localName, "body", "a <div> ends the open <p>");
    assert.equal(doc.querySelector("img").children.length, 0);
  });

  it("matches the selectors the pages use", () => {
    assert.equal(doc.querySelectorAll("input[name=view]").length, 1);
    assert.equal(doc.querySelectorAll('[data-kind="k"]').length, 1);
    assert.equal(doc.querySelectorAll("div.x.y").length, 1);
    assert.equal(doc.querySelectorAll("body #d").length, 1);
    assert.equal(doc.querySelectorAll("ul li, img").length, 3);
    assert.equal(doc.getElementById("d").dataset.kind, "k");
    assert.throws(() => doc.querySelectorAll("li:first-child"), SyntaxError);
  });

  it("supports innerHTML, classList, hidden and events", () => {
    const div = doc.getElementById("d");
    div.innerHTML = "<b>bold</b> text";
    assert.equal(div.textContent, "bold text");
    div.classList.toggle("y", false);
    assert.equal(div.className, "x");
    div.hidden = true;
    assert.ok(div.hasAttribute("hidden"));
    let seen = null;
    div.addEventListener("click", (event) => (seen = event.detail));
    div.click();
    assert.equal(seen, 0);
  });
});

describe("accessible names", () => {
  const doc = parseHtml(
    page(
      '<main><label for="a">Alpha</label><input id="a">' +
        '<label class="select">From <select id="s"><option>2000</option></select></label>' +
        '<label><input type="checkbox" id="c"> July start</label>' +
        '<span id="x">Zoom</span><span id="y">in</span><button id="b" aria-labelledby="x y"></button>' +
        '<button id="h">Save<span aria-hidden="true"> ✓</span></button>' +
        '<a id="l" href="/"><img src="i" alt="Home"></a><button id="t" title="Close"></button>' +
        '<div role="group" id="g">not a name</div></main>',
    ),
  );
  const name = (id) => accessibleName(doc.getElementById(id), doc);

  it("follows labels, aria-labelledby, aria-hidden, alt and title", () => {
    assert.equal(name("a"), "Alpha");
    assert.equal(name("s"), "From");
    assert.equal(name("c"), "July start");
    assert.equal(name("b"), "Zoom in");
    assert.equal(name("h"), "Save");
    assert.equal(name("l"), "Home");
    assert.equal(name("t"), "Close");
    assert.equal(name("g"), "", "a group is not named by its contents");
  });
});

describe("the checker's rules", () => {
  it("passes a page that meets every rule", () => {
    const good = page(
      '<a href="#main">Skip</a><header><h1>Title</h1><nav aria-label="Pages"><a href="/m">Method</a></nav></header>' +
        '<main id="main"><h2>Part</h2><fieldset><legend>View</legend><label><input type="radio" name="v"> A</label></fieldset>' +
        '<button type="button">Go</button><img src="x" alt="">' +
        '<svg aria-hidden="true"><line/></svg><svg role="img" aria-label="Chart"><line/></svg>' +
        '<table><caption>Numbers</caption><tr><th scope="col">Month</th></tr></table>' +
        '<section aria-labelledby="part"><h3 id="part">Sub</h3></section></main><footer><p>Credits</p></footer>',
      '<title>T</title><meta name="viewport" content="width=device-width, initial-scale=1">',
    );
    assert.deepEqual(checkDocument(parseHtml(good)), []);
  });

  it("finds each kind of problem", () => {
    const bad =
      '<!doctype html><html><head><meta name="viewport" content="width=device-width, maximum-scale=1"></head><body>' +
      "<p>Loose text</p><main><h2>A</h2><h4>Skipped</h4><input id=\"i\"><select></select><button></button>" +
      '<a href="/x"></a><img src="x"><svg><circle/></svg><div role="group"></div><table><tr><td>1</td></tr></table>' +
      '<label for="missing">L</label><p id="dup">1</p><p id="dup">2</p><span tabindex="2">t</span>' +
      '<div aria-hidden="true"><button>Hidden</button></div></main><main></main></body></html>';
    const expected = [
      "aria-hidden-focus",
      "button-name",
      "control-label",
      "duplicate-id",
      "group-name",
      "heading-order",
      "idref",
      "img-alt",
      "lang",
      "link-name",
      "main-landmark",
      "one-h1",
      "outside-landmark",
      "svg-name",
      "table-caption",
      "table-headers",
      "tabindex-positive",
      "title",
      "viewport-zoom",
    ];
    assert.deepEqual(rules(bad), expected.sort());
  });

  it("allows a skip link outside the landmarks but no other text", () => {
    const base = '<header><h1>T</h1></header><main id="m">x</main>';
    assert.deepEqual(rules(page(`<a href="#m">Skip</a>${base}`)), []);
    assert.deepEqual(rules(page(`<a href="/elsewhere">Away</a>${base}`)), ["outside-landmark"]);
  });
});

describe("palette tokens and contrast", () => {
  const css = [
    ":root { --bg: #ffffff; --fg: #1a1a1a; --soft: #999; --veil: rgb(0 0 0 / 0.5); --zero: #d6d6d6 }",
    "@media (prefers-color-scheme: dark) { :root { --bg: #111111; --fg: #eeeeee } }",
    ".card { --fg: var(--ink, #222222); --edge: var(--bg) }",
    "@media (min-width: 40rem) { :root { --wide: #123456 } }",
  ];
  const tokens = cssTokens(css);

  it("reads light and dark values, var() fallbacks, scopes, short hex and alpha", () => {
    assert.equal(resolveColor(tokens, "--fg", { scheme: "light" }), "#1a1a1a");
    assert.equal(resolveColor(tokens, "--fg", { scheme: "dark" }), "#eeeeee");
    assert.equal(resolveColor(tokens, "--soft", { scheme: "dark" }), "#999999", "light values carry into dark");
    assert.equal(resolveColor(tokens, "--fg", { scheme: "dark", scope: ".card" }), "#222222");
    assert.equal(resolveColor(tokens, "--edge", { scheme: "dark", scope: ".card" }), "#111111");
    assert.equal(resolveColor(tokens, "--veil", { scheme: "light", under: "#ffffff" }), "#808080");
    assert.equal(resolveColor(tokens, "--wide", { scheme: "light" }), "#123456");
    assert.equal(resolveColor(tokens, "--nothing", { scheme: "light" }), null);
  });

  it("fails low pairs, passes calendar cells by their edge, and reports unreadable tokens", () => {
    const { findings, results } = checkContrast(tokens, [
      { fg: "--fg", bg: "--bg", min: 4.5, what: "text" },
      { fg: "--soft", bg: "--bg", min: 4.5, what: "soft text" },
      { fg: "--zero", bg: "--bg", min: 3, what: "cell", cell: true },
      { fg: "--nothing", bg: "--bg", min: 3, what: "missing" },
    ]);
    assert.equal(results.find((r) => r.scheme === "light" && r.pair.what === "cell").ratio >= 3, true);
    assert.deepEqual(
      findings.map((f) => f.message.split(":")[0] + " " + f.rule),
      ["light contrast", "light contrast-token", "dark contrast-token"],
    );
  });
});

describe("calendar cells meet 3:1 against the background", () => {
  for (const [name, palette] of [["light", CALENDAR_PALETTE], ["dark", CALENDAR_PALETTE_DARK]]) {
    it(`draws an edge on every ${name} fill below 3:1`, (t) => {
      const ramp = (stops) => Array.from({ length: 101 }, (_, i) => rampColor(stops, i / 100));
      const fills = [...ramp(palette.sequential), ...ramp(palette.diverging)];
      let edged = 0;
      for (const [kind, color] of [...fills.map((color) => ["value", color]), ["zero", palette.zero]]) {
        const [rect] = cellShapes({ kind, color, provisional: false, partial: false }, 0, 0, 30, 15, palette);
        const best = Math.max(contrastRatio(rect.style.fill, palette.background), rect.style.stroke ? contrastRatio(rect.style.stroke, palette.background) : 0);
        assert.ok(best >= 3, `${kind} ${color}: ${best.toFixed(2)}:1`);
        if (rect.style.stroke) edged += 1;
      }
      const zero = edgeColor(palette.zero, palette.background);
      t.diagnostic(`${edged} of ${fills.length + 1} sampled fills get an edge; zero ${palette.zero} → ${zero} (${contrastRatio(zero, palette.background).toFixed(2)}:1)`);
      const [noData] = cellShapes({ kind: "no_data", color: palette.noData.fill, provisional: false, partial: false }, 0, 0, 30, 15, palette);
      assert.equal(noData.style.stroke, palette.noData.stroke);
    });
  }

  it("darkens on a light background, lightens on a dark one, and leaves strong fills alone", () => {
    assert.equal(edgeColor("#440154", "#ffffff"), null);
    const light = edgeColor("#eeeeee", "#ffffff");
    const dark = edgeColor("#2b2d33", "#17191e");
    assert.ok(contrastRatio(light, "#ffffff") >= 3 && contrastRatio(light, "#000000") < contrastRatio("#eeeeee", "#000000"));
    assert.ok(contrastRatio(dark, "#17191e") >= 3 && contrastRatio(dark, "#ffffff") < contrastRatio("#2b2d33", "#ffffff"));
  });
});

describe("the calendar as a table", () => {
  const harmonized = mockCalendar("nile_delta", "harmonized", "2000-11", "2026-11");
  const raw = mockCalendar("nile_delta", "raw", "2000-11", "2026-11");

  it("lists every month newest first with what the tooltip says", () => {
    const table = calendarTable(harmonized, { view: "harmonized", title: "Nile Delta, Egypt" });
    assert.deepEqual(table.columns.map((c) => c.label), [
      "Month",
      "Value (MODIS-equivalent hotspots)",
      "Median 2003–2025",
      "Difference",
      "Rank",
      "Notes",
    ]);
    assert.equal(table.rows.length, 313);
    assert.deepEqual(table.rows[0], { month: "November 2026", cells: ["66.3", "95.7", "−29.4", "19 of 24", "Provisional; Partial coverage"] });
    assert.equal(table.rows.at(-1).month, "November 2000");
    assert.equal(table.rows.at(-1).cells[3], "—", "no rank before 2003");
    assert.match(table.caption, /^Nile Delta, Egypt: harmonized MODIS-equivalent hotspots per month, newest first\./);
    assert.match(table.caption, /Fire season: Oct–Nov\.$/);
  });

  it("switches columns with the view and flags months without enough history", () => {
    const anomaly = calendarTable(harmonized, { view: "anomaly" });
    assert.equal(anomaly.columns[3].label, "Against the median");
    assert.equal(anomaly.rows[0].cells[2], "0.7×");
    const noHistory = harmonized.months.filter((m) => m.value !== null && m.anomaly_log2 === null).length;
    assert.equal(anomaly.rows.filter((row) => row.cells.at(-1).includes("Not enough history")).length, noHistory);
    const rawTable = calendarTable(raw, { view: "raw" });
    assert.deepEqual(rawTable.columns.map((c) => c.label), ["Month", "MODIS hotspots", "VIIRS hotspots", "Notes"]);
    assert.deepEqual(rawTable.rows[0].cells, ["31", "460", "Provisional; Partial coverage"]);
    assert.doesNotMatch(rawTable.caption, /Rank|Fire season/);
    assert.throws(() => calendarTable(harmonized, { view: "pie" }), RangeError);
  });

  it("drops months after the last one with data and marks gaps as no data", () => {
    const gap = { value: null, modis_raw: null, viirs_raw: null, provisional: false, partial_coverage: false };
    const months = [...harmonized.months.slice(200, 203), { ...harmonized.months[203], ...gap }, harmonized.months[204], { ...harmonized.months[205], ...gap }];
    const table = calendarTable({ ...harmonized, months }, { view: "harmonized" });
    assert.equal(table.rows.length, 5);
    assert.equal(table.rows[1].cells.at(-1), "No data");
  });

  it("builds an escaped, scrollable, focusable table that passes the checker", () => {
    const html = calendarTableHtml(calendarTable(harmonized, { view: "harmonized", title: "<Delta> & co" }));
    assert.match(html, /^<div class="table-scroll" tabindex="0" role="region" aria-labelledby="calendar-table-caption">/);
    assert.match(html, /<caption id="calendar-table-caption">&lt;Delta&gt; &amp; co:/);
    assert.match(html, /<th scope="row">November 2026<\/th><td class="num">66\.3<\/td>/);
    assert.deepEqual(checkDocument(parseHtml(page(`<header><h1>T</h1></header><main>${html}</main>`))), []);
  });
});

describe("the map's keyboard route", () => {
  it("opens the box form when Draw area is pressed from the keyboard, and draws with a pointer", async () => {
    const doc = parseHtml(page('<header><h1>T</h1></header><main><div id="map"></div></main>'));
    const listeners = {};
    const canvas = doc.createElement("canvas");
    const globals = {
      document: doc,
      maplibregl: {
        Map: class {
          keyboard = { disableRotation() {} };
          touchZoomRotate = { disableRotation() {} };
          once = (type, callback) => type === "load" && queueMicrotask(callback);
          on() {}
          addControl() {}
          getCanvas = () => canvas;
          fitBounds() {}
          getStyle = () => ({ layers: [] });
          addImage() {}
          addSource() {}
          addLayer() {}
          getSource = () => ({ setData() {} });
        },
        NavigationControl: class {},
        ScaleControl: class {},
      },
      terraDraw: {
        TerraDraw: class {
          on = (type, listener) => (listeners[type] = listener);
          start() {}
          setMode(mode) {
            this.mode = mode;
          }
        },
        TerraDrawPolygonMode: class {},
        TerraDrawSelectMode: class {},
        ValidateNotSelfIntersecting: () => ({ valid: true }),
      },
      terraDrawMaplibreGlAdapter: { TerraDrawMapLibreGLAdapter: class {} },
    };
    Object.assign(globalThis, globals);
    try {
      const { createMap } = await import("../public/js/map/map.js");
      const container = doc.getElementById("map");
      createMap(/** @type {any} */ (container), { regions: mocks.metadata.regions });
      const draw = container.querySelectorAll("button").find((button) => button.textContent === "Draw area");
      const box = container.querySelector("details");
      const status = container.querySelector('[role="status"]');
      const hint = doc.getElementById(draw.getAttribute("aria-describedby"));
      assert.match(hint.textContent, /keyboard/);

      draw.dispatchEvent({ type: "click", detail: 0 });
      assert.equal(box.open, true);
      assert.equal(doc.activeElement?.getAttribute("name"), "west");
      assert.match(status.textContent, /box form is open/);
      assert.equal(draw.getAttribute("aria-pressed"), "false");

      draw.dispatchEvent({ type: "click", detail: 1 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(draw.getAttribute("aria-pressed"), "true");
      assert.equal(doc.activeElement, canvas);
      assert.match(status.textContent, /Using a keyboard\? Press Escape, then type a box\./);
      draw.dispatchEvent({ type: "click", detail: 0 });
      assert.equal(draw.getAttribute("aria-pressed"), "false", "the keyboard still cancels drawing");
      assert.deepEqual(checkDocument(doc), []);
    } finally {
      for (const name of Object.keys(globals)) delete globalThis[name];
    }
  });
});

describe("plain-language messages", () => {
  it("has a sentence for every error, without codes or stray values", () => {
    const regions = mocks.metadata.regions;
    const errors = [...ERROR_CODES, "network", "server_error"].flatMap((code) => [
      { code, message: "", regions: [], retryAfter: null },
      { code, message: "The server answered 500", regions: ["nile_delta"], retryAfter: 90, status: 500 },
    ]);
    for (const error of errors) {
      const { title, detail } = errorMessage(error, regions);
      for (const text of [title, detail ?? ""]) {
        assert.doesNotMatch(text, /undefined|null|NaN|\b[a-z]+_[a-z_]+\b|\(\)/, `${error.code}: ${text}`);
      }
      assert.match(title, /^[A-Z].*[.]$/, `${error.code}: ${title}`);
    }
    assert.equal(errorMessage({ code: "server_error", message: "x", status: 500 }, regions).title, "Something went wrong on the server.");
    assert.equal(errorMessage({ code: "server_error", message: "the chart library did not load" }, regions).detail, "Try again in a moment, or reload the page. The chart library did not load.");
  });
});

describe("the served pages", () => {
  /** @type {import("node:child_process").ChildProcess} */
  let server;
  let base = "";

  before(async () => {
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = /** @type {import("node:net").AddressInfo} */ (probe.address());
    await new Promise((resolve) => probe.close(resolve));
    server = spawn(process.execPath, ["server.js"], {
      cwd: WEB_DIR,
      env: { ...process.env, PORT: String(port), DATA_BASE_URL: fixtureDir() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server.js did not start: ${output}`)), 15_000);
      server.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes(`http://localhost:${port}`)) {
          clearTimeout(timer);
          resolve();
        }
      });
      server.stderr.on("data", (chunk) => (output += chunk));
      server.once("exit", (code) => reject(new Error(`server.js exited with ${code}: ${output}`)));
    });
    server.removeAllListeners("exit");
    base = `http://127.0.0.1:${port}`;
  });

  after(() => server?.kill());

  /** @type {Record<string, Awaited<ReturnType<typeof auditPage>>>} */
  const reports = {};

  for (const path of DEFAULT_PAGES) {
    it(`${path} passes scripts/a11y-check.js, as served and as rendered`, async (t) => {
      const report = await auditPage(base, path);
      reports[path] = report;
      const lowest = (scheme) => Math.min(...report.contrast.results.filter((r) => r.scheme === scheme).map((r) => r.ratio)).toFixed(2);
      const total = transferTotals(report.assets);
      t.diagnostic(
        `${report.contrast.results.length} color pairs, lowest ${lowest("light")}:1 light and ${lowest("dark")}:1 dark; ` +
          `first load ${total.files} responses, ${kb(total.bytes)} (${kb(total.gzip)} gzipped)`,
      );
      assert.ok(report.rendered, "the page was rendered with its own modules");
      assert.deepEqual(report.findings, []);
    });
  }

  it("renders the app's keyboard path: presets, views, years, box form, calendar table, downloads", async () => {
    const doc = reports["/"]?.doc ?? (await auditPage(base, "/")).doc;
    const presets = doc.querySelectorAll("#region-presets button");
    assert.equal(presets.length, 4);
    assert.ok(presets.every((button) => button.hasAttribute("aria-pressed")));
    assert.equal(doc.querySelectorAll("#view-toggle input[type=radio]").length, 3);
    assert.equal(doc.querySelectorAll("#range-from option").length, 27);
    assert.equal(doc.querySelectorAll(".hon-map__box input").length, 4);
    assert.deepEqual(doc.querySelectorAll("#exports button").map((b) => b.textContent), ["Hotspots (CSV)", "Monthly summary (CSV)", "Calendar image (PNG)"]);
    assert.ok(doc.querySelectorAll("#exports button").every((b) => !b.disabled), "downloads are enabled once the calendar is shown");
    assert.match(doc.getElementById("calendar").getAttribute("aria-label"), /^Calendar heatmap/);
    const rows = doc.querySelectorAll("#calendar-table tbody tr");
    assert.equal(rows.length, 313);
    assert.equal(rows[0].querySelector("th").textContent, "November 2026");
    assert.match(doc.getElementById("current-month").textContent, /^November 2026 so far:/);
  });

  it("names every numbers table on the method page after its chart", async () => {
    const doc = reports["/method.html"]?.doc ?? (await auditPage(base, "/method.html")).doc;
    const names = doc.querySelectorAll("details.numbers summary").map((summary) => accessibleName(summary, doc));
    assert.ok(names.length >= 3);
    assert.equal(new Set(names).size, names.length, names.join(" | "));
    assert.ok(doc.querySelectorAll("details.numbers table").length >= 3, "the tables filled when opened");
  });

  it("keeps the dev pages that ship in public/dev/ free of problems", async () => {
    const dev = readdirSync(join(PUBLIC_DIR, "dev")).filter((name) => name.endsWith(".html"));
    assert.deepEqual(dev.sort(), ["calendar.html", "map.html"]);
    for (const name of dev) {
      const html = await (await fetch(`${base}/dev/${name}`)).text();
      assert.deepEqual(checkDocument(parseHtml(html)), [], name);
    }
  });

  it("caches vendored files for a year and revalidates everything else", async () => {
    const vendor = await fetch(`${base}/vendor/echarts.min.js?v=6.1.0`, { method: "HEAD" });
    assert.equal(vendor.headers.get("cache-control"), "public, max-age=31536000, immutable");
    for (const path of ["/", "/method.html", "/js/app.js", "/css/app.css"]) {
      const response = await fetch(`${base}${path}`);
      await response.arrayBuffer();
      assert.equal(response.headers.get("cache-control"), "no-cache", path);
      const modified = response.headers.get("last-modified");
      assert.ok(modified, path);
      const again = await fetch(`${base}${path}`, { headers: { "if-modified-since": modified } });
      assert.equal(again.status, 304, path);
    }
    const vercel = JSON.parse(readFileSync(join(WEB_DIR, "vercel.json"), "utf8"));
    assert.deepEqual(vercel.headers, [
      { source: "/vendor/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
    ]);
    const metadata = await fetch(`${base}/api/metadata`);
    await metadata.arrayBuffer();
    assert.match(metadata.headers.get("cache-control"), /max-age=600/);
  });

  it("versions every vendored URL in every page with its pinned release", () => {
    const manifest = JSON.parse(readFileSync(join(PUBLIC_DIR, "vendor", "manifest.json"), "utf8"));
    const versions = new Map(manifest.files.map((file) => [file.file, file.version]));
    const pages = ["index.html", "method.html", ...readdirSync(join(PUBLIC_DIR, "dev")).map((name) => `dev/${name}`)];
    let count = 0;
    for (const name of pages) {
      for (const [, file, query] of readFileSync(join(PUBLIC_DIR, name), "utf8").matchAll(/"\/vendor\/([^"?]+)(\?[^"]*)?"/g)) {
        count += 1;
        assert.equal(query, `?v=${versions.get(file)}`, `${name}: /vendor/${file}`);
      }
    }
    assert.ok(count >= 9);
  });

  it("preloads exactly each page's module graph, and starts the app before the vendored scripts", async () => {
    for (const path of DEFAULT_PAGES) {
      const html = await (await fetch(`${base}${path}`)).text();
      const doc = parseHtml(html);
      const preloaded = doc.querySelectorAll('link[rel="modulepreload"]').map((link) => link.getAttribute("href")).sort();
      const assets = reports[path]?.assets ?? (await pageAssets(base, path));
      const graph = assets.filter((asset) => asset.kind === "module").map((asset) => new URL(asset.url).pathname).sort();
      assert.deepEqual(preloaded, graph, path);
      const scripts = doc.querySelectorAll("script");
      const module = scripts.findIndex((script) => script.getAttribute("type") === "module");
      const firstVendor = scripts.findIndex((script) => script.getAttribute("src")?.startsWith("/vendor/"));
      assert.ok(module >= 0 && module < firstVendor, `${path}: the module script comes before the defer scripts`);
      assert.ok(scripts.filter((script) => script.hasAttribute("src")).every((script) => script.hasAttribute("defer")), path);
    }
  });

  it("keeps the first load within budget", async (t) => {
    const budgets = { "/": 900 * 1024, "/method.html": 450 * 1024 };
    for (const path of DEFAULT_PAGES) {
      const assets = reports[path]?.assets ?? (await pageAssets(base, path));
      const total = transferTotals(assets);
      t.diagnostic(`${path}: ${total.files} responses, ${kb(total.bytes)}, ${kb(total.gzip)} gzipped (budget ${kb(budgets[path])} gzipped)`);
      assert.ok(total.gzip <= budgets[path], path);
      assert.ok(assets.every((asset) => asset.status === 200), path);
    }
  });

  it("prewarms every preset with the page's own requests", async (t) => {
    const metadata = await (await fetch(`${base}/api/metadata`)).json();
    const calls = prewarmCalls(metadata);
    assert.equal(calls.length, 2 + metadata.regions.length * 3);
    const nile = metadata.regions.find((region) => region.id === "nile_delta");
    const pageRequest = calendarBody(/** @type {any} */ (areaPolygon(DEFAULT_STATE.area, nile)), DEFAULT_STATE, metadata);
    assert.deepEqual(calls.find((call) => call.name === "nile_delta calendar harmonized").body, pageRequest);
    const [first, second] = await prewarm(base, { rounds: 2 });
    assert.ok([...first, ...second].every((result) => result.status === 200));
    assert.ok(second.filter((result) => result.path === "/api/calendar").every((result) => result.cache === "hit"));
    const ms = (round) => round.reduce((sum, result) => sum + result.ms, 0).toFixed(0);
    t.diagnostic(`${calls.length} calls; first round ${ms(first)} ms, second ${ms(second)} ms`);
  });
});
