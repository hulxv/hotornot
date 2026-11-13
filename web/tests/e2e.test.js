// Starts server.js as its own process against the W02 fixture and checks what a browser would
// fetch for the page in its default state: the HTML, every module in its import graph, every
// stylesheet, and the API calls the page makes, with the same request bodies the page builds.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { estimateCalendarHeight } from "../public/js/app.js";
import { contrastRatio, deltaE2000, rampColor, simulateCvd, toLab } from "../public/js/calendar/color.js";
import { CALENDAR_PALETTE, CALENDAR_PALETTE_DARK, paletteFromStyle } from "../public/js/calendar/palette.js";
import { buildOption } from "../public/js/calendar/option.js";
import { buildCalendar } from "../public/js/calendar/transform.js";
import { attachmentFilename, calendarBody, resolveRange } from "../public/js/client-api.js";
import { areaSummary, snapForMap } from "../public/js/panels/area.js";
import { currentMonthFlags, currentMonthSentence } from "../public/js/panels/current-month.js";
import { errorMessage } from "../public/js/panels/messages.js";
import { DEFAULT_STATE, areaPolygon, parseState } from "../public/js/url-state.js";
import { boxToPolygon } from "../public/shared/aoi.js";
import {
  HOTSPOT_EXPORT_COLUMNS,
  SUMMARY_EXPORT_COLUMNS,
  checkApiError,
  checkCalendarResponse,
  checkCurrentMonthResponse,
  checkMetadata,
  exportFilename,
} from "../public/shared/contracts.js";
import { fixtureDir } from "./fixtures/fixture.js";

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = /** @type {import("node:net").AddressInfo} */ (probe.address());
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Import specifiers of an ES module: static imports and re-exports, dynamic imports, and URLs built from import.meta.url. */
function moduleReferences(source) {
  const patterns = [
    /\bimport\s+(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

/** Custom properties of the first `:root` block after `start` in a stylesheet. */
function rootTokens(css, start = 0) {
  const open = css.indexOf("{", css.indexOf(":root", start));
  const block = css.slice(open + 1, css.indexOf("}", open));
  return Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}

const styleOf = (tokens) => ({ getPropertyValue: (name) => tokens[name] ?? "" });

describe("the page against server.js and the W02 fixture", () => {
  /** @type {import("node:child_process").ChildProcess} */
  let server;
  let base = "";
  let html = "";
  /** @type {import("../public/shared/contracts.js").Metadata} */
  let metadata;

  before(async () => {
    const port = await freePort();
    server = spawn(process.execPath, ["server.js"], {
      cwd: WEB_DIR,
      env: { ...process.env, PORT: String(port), DATA_BASE_URL: fixtureDir() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server.js did not start: ${output}`)), 15_000);
      const onData = (chunk) => {
        output += chunk;
        if (output.includes(`http://localhost:${port}`)) {
          clearTimeout(timer);
          resolve();
        }
      };
      server.stdout.on("data", onData);
      server.stderr.on("data", (chunk) => (output += chunk));
      server.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`server.js exited with ${code}: ${output}`));
      });
    });
    server.removeAllListeners("exit");
    base = `http://127.0.0.1:${port}`;
  });

  after(() => {
    server?.kill();
  });

  const post = (path, body) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("serves / as the app page", async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/html/);
    html = await response.text();
    assert.match(html, /import \{ startApp \} from "\/js\/app\.js"/);
    assert.match(html, /href="\/method\.html"/);
    const appSource = readFileSync(new URL("../public/js/app.js", import.meta.url), "utf8");
    const ids = [...appSource.matchAll(/\$\("([\w-]+)"\)/g)].map((match) => match[1]);
    assert.ok(ids.length >= 15);
    for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `index.html has no #${id} for app.js`);
  });

  it("loads every script, stylesheet and module the page needs", async (t) => {
    if (!html) html = await (await fetch(`${base}/`)).text();
    const queue = [];
    for (const [, src] of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) queue.push({ url: new URL(src, base).href, module: false });
    for (const [, href] of html.matchAll(/<link[^>]*\shref="([^"]+)"/g)) {
      if (href.endsWith(".css")) queue.push({ url: new URL(href, base).href, module: false });
    }
    for (const [, inline] of html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)) {
      for (const specifier of moduleReferences(inline)) queue.push({ url: new URL(specifier, base).href, module: true });
    }
    const seen = new Set();
    let modules = 0;
    while (queue.length > 0) {
      const { url, module } = /** @type {{ url: string, module: boolean }} */ (queue.shift());
      if (seen.has(url)) continue;
      seen.add(url);
      const response = await fetch(url);
      assert.equal(response.status, 200, url);
      const type = response.headers.get("content-type") ?? "";
      assert.match(type, url.endsWith(".css") ? /^text\/css/ : /^text\/javascript/, url);
      const text = await response.text();
      if (module && url.endsWith(".js")) {
        modules += 1;
        for (const specifier of moduleReferences(text)) {
          const resolved = new URL(specifier, url).href;
          queue.push({ url: resolved, module: resolved.endsWith(".js") });
        }
      }
    }
    t.diagnostic(`${seen.size} files fetched, ${modules} of them ES modules`);
    assert.ok(modules >= 15, `only ${modules} modules in the graph`);
    for (const path of ["/js/app.js", "/js/map/map.js", "/js/calendar/index.js", "/js/panels/exports.js", "/shared/grid.js", "/js/map/map.css"]) {
      assert.ok(seen.has(`${base}${path}`), `${path} is not reached from the page`);
    }
  });

  it("gets valid answers to the default state's API calls", async () => {
    const metadataResponse = await fetch(`${base}/api/metadata`);
    assert.equal(metadataResponse.status, 200);
    assert.equal(metadataResponse.headers.get("x-hotornot-data"), null, "the fixture, not the mocks");
    metadata = await metadataResponse.json();
    assert.deepEqual(checkMetadata(metadata), []);

    const state = parseState("");
    assert.deepEqual(state, DEFAULT_STATE);
    const region = metadata.regions.find((r) => r.id === state.region);
    const aoi = /** @type {import("../public/shared/contracts.js").Aoi} */ (areaPolygon(state.area, region));
    const request = calendarBody(aoi, state, metadata);
    assert.deepEqual(request, { aoi: boxToPolygon(29.5, 29.8, 32.5, 31.8), start: "2000-11", end: "2026-11", series: "harmonized" });

    const calendarResponse = await post("/api/calendar", request);
    assert.equal(calendarResponse.status, 200);
    const calendar = await calendarResponse.json();
    assert.deepEqual(checkCalendarResponse(calendar), []);
    assert.equal(calendar.region_id, "nile_delta");
    assert.equal(calendar.clipped_fraction, 0);
    assert.equal(calendar.months.length, 313);
    assert.deepEqual(calendar.aoi.cells, 2400);
    const overlay = snapForMap(aoi, metadata.regions);
    assert.equal(overlay.counted.length + overlay.uncovered.length, calendar.aoi.cells, "the map draws the cells the API counts");
    assert.equal(overlay.counted.length, calendar.aoi.covered_cells);
    assert.match(areaSummary(calendar, region.name, true), /^All of Nile Delta, Egypt: 2,400 grid cells counted, [\d,]+ km²\.$/);

    const width = 760;
    const drawn = buildOption(buildCalendar(calendar, { view: "harmonized" }), { width, title: region.name }).height;
    const reserved = estimateCalendarHeight({ view: "harmonized", julyStart: false, width, ...resolveRange(state, metadata), title: region.name });
    assert.equal(reserved, drawn, "the reserved height is the drawn height, so nothing moves when the calendar arrives");

    const currentResponse = await post("/api/current-month", { aoi });
    assert.equal(currentResponse.status, 200);
    const current = await currentResponse.json();
    assert.deepEqual(checkCurrentMonthResponse(current), []);
    assert.match(
      currentMonthSentence(current),
      /^November 2026 so far: [\d.,a-z ]+ MODIS-equivalent hotspots?, (above|below|at) the median for the first 13 days, \d+(st|nd|rd|th) of 24\.$/,
    );
  });

  it("downloads both CSVs for the default state", async () => {
    const state = parseState("");
    const region = metadata.regions.find((r) => r.id === state.region);
    const request = calendarBody(/** @type {any} */ (areaPolygon(state.area, region)), state, metadata);
    for (const [kind, columns] of /** @type {const} */ ([["summary", SUMMARY_EXPORT_COLUMNS], ["hotspots", HOTSPOT_EXPORT_COLUMNS]])) {
      const response = await post(`/api/export/${kind}`, request);
      assert.equal(response.status, 200, kind);
      assert.match(response.headers.get("content-type"), /^text\/csv/);
      assert.equal(attachmentFilename(response.headers.get("content-disposition")), exportFilename(kind, "nile_delta", "2000-11", "2026-11"));
      const lines = (await response.text()).trim().split(/\r?\n/);
      assert.equal(lines[0], columns.join(","), kind);
      assert.ok(lines.length > 1, kind);
      if (kind === "summary") assert.equal(lines.length, 1 + 313);
    }
  });

  it("has a plain-language message for every error the API gives the page", async () => {
    const names = metadata.regions.map((region) => region.name);
    const valid = { start: "2000-11", end: "2026-11", series: "harmonized" };
    const cases = [
      ["outside_regions", "/api/calendar", { ...valid, aoi: boxToPolygon(-30, 0, -29, 1) }],
      ["too_small", "/api/calendar", { ...valid, aoi: boxToPolygon(31, 30.6, 31.05, 30.65) }],
      ["invalid_aoi", "/api/calendar", { ...valid, aoi: { type: "Polygon", coordinates: [[[30.8, 30.6], [31.4, 31.1], [31.4, 30.6], [30.8, 31.1], [30.8, 30.6]]] } }],
      ["too_many_vertices", "/api/current-month", { aoi: { type: "Polygon", coordinates: [[...Array.from({ length: 501 }, (_, i) => [31 + 0.5 * Math.cos(i / 80), 30.8 + 0.5 * Math.sin(i / 80)]), [31.5, 30.8]]] } }],
      ["bad_range", "/api/export/summary", { ...valid, aoi: boxToPolygon(30.8, 30.6, 31.4, 31.1), start: "2020-01", end: "2010-12" }],
    ];
    for (const [code, path, body] of cases) {
      const response = await post(path, body);
      const payload = await response.json();
      assert.deepEqual(checkApiError(payload), [], code);
      assert.equal(payload.error.code, code);
      const message = errorMessage(payload.error, metadata.regions);
      assert.ok(message.title.length > 10 && !message.title.includes("went wrong"), code);
      if (code === "outside_regions") {
        assert.deepEqual(message.regions?.map((region) => region.name), names);
        for (const name of names) assert.ok(message.detail?.includes(name), name);
      }
    }
    for (const code of ["too_many_rows", "data_unavailable", "network"]) {
      const message = errorMessage({ code, message: "", regions: [], retryAfter: 60 }, metadata.regions);
      assert.ok(!message.title.includes("went wrong"), code);
    }
  });

  it("serves the palette tokens the calendar reads, light and dark", async () => {
    const response = await fetch(`${base}/css/app.css`);
    assert.equal(response.status, 200);
    const css = await response.text();
    const light = rootTokens(css);
    const dark = { ...light, ...rootTokens(css, css.indexOf("prefers-color-scheme: dark")) };
    assert.deepEqual(paletteFromStyle(styleOf(light)), CALENDAR_PALETTE);
    assert.deepEqual(paletteFromStyle(styleOf(dark)), CALENDAR_PALETTE_DARK);
    assert.equal(paletteFromStyle(styleOf({})), CALENDAR_PALETTE, "a page without the tokens keeps the light palette");
  });
});

describe("the current-month card", () => {
  const rfc = { year: 2026, month: 11, days_covered: 13, value: 96.3, median: 210.5, rank: 19, of_years: 24, provisional: true, partial_coverage: true };

  it("says the RFC's sentence and marks provisional and partial months", () => {
    assert.equal(currentMonthSentence(rfc), "November 2026 so far: 96 MODIS-equivalent hotspots, below the median for the first 13 days, 19th of 24.");
    assert.deepEqual(currentMonthFlags(rfc).map((flag) => flag.label), ["Provisional", "Partial coverage"]);
    assert.deepEqual(currentMonthFlags({ ...rfc, provisional: false, partial_coverage: false }), []);
  });

  it("handles one day, a whole month, small values, ties and ranks 1 to 23", () => {
    assert.equal(
      currentMonthSentence({ ...rfc, month: 2, days_covered: 1, value: 1, median: 0.4, rank: 1, of_years: 2 }),
      "February 2026 so far: 1 MODIS-equivalent hotspot, above the median for the first day, 1st of 2.",
    );
    assert.equal(
      currentMonthSentence({ ...rfc, days_covered: 30, value: 0.04, median: 0.02, rank: 22, of_years: 23 }),
      "November 2026: less than 0.1 MODIS-equivalent hotspots, at the median for the month, 22nd of 23.",
    );
    assert.equal(
      currentMonthSentence({ ...rfc, value: 1234.4, median: 1234.2, rank: 13 }),
      "November 2026 so far: 1,234 MODIS-equivalent hotspots, at the median for the first 13 days, 13th of 24.",
    );
    assert.equal(currentMonthSentence({ ...rfc, value: 0, median: 3.25, rank: 23 }).split(", ").at(-1), "23rd of 24.");
  });
});

describe("the dark calendar palette", () => {
  const P = CALENDAR_PALETTE_DARK;
  const KINDS = ["normal", "deuteranopia", "protanopia", "tritanopia"];
  const sim = (hex, kind) => (kind === "normal" ? hex : simulateCvd(hex, kind));
  const samples = (stops, n) => Array.from({ length: n }, (_, i) => rampColor(stops, i / (n - 1)));
  const viridis = samples(P.sequential, 101);

  it("meets WCAG contrast for text, outlines and the season band", (t) => {
    const ratios = {
      text: contrastRatio(P.text, P.background),
      muted: contrastRatio(P.muted, P.background),
      outline: contrastRatio(P.noData.stroke, P.background),
      season: contrastRatio(P.season, P.background),
    };
    t.diagnostic(Object.entries(ratios).map(([name, ratio]) => `${name} ${ratio.toFixed(2)}`).join(", "));
    assert.ok(ratios.text >= 4.5 && ratios.muted >= 4.5);
    assert.ok(ratios.outline >= 3 && ratios.season >= 3);
  });

  it("keeps the zero gray and no-data fill apart from viridis under each simulated dichromacy", () => {
    for (const kind of KINDS) {
      const zero = Math.min(...viridis.map((hex) => deltaE2000(sim(P.zero, kind), sim(hex, kind))));
      const empty = Math.min(...viridis.map((hex) => deltaE2000(sim(P.noData.fill, kind), sim(hex, kind))));
      assert.ok(zero >= (kind === "tritanopia" ? 8 : 15), `${kind}: zero ${zero}`);
      assert.ok(empty >= 8, `${kind}: no-data ${empty}`);
    }
  });

  it("keeps blue and orange anomalies apart, darkest at the median", () => {
    for (const kind of KINDS) {
      const pairs = [0.25, 0.5, 0.75, 1].map((size) =>
        deltaE2000(sim(rampColor(P.diverging, 0.5 - size / 2), kind), sim(rampColor(P.diverging, 0.5 + size / 2), kind)),
      );
      assert.ok(Math.min(...pairs) >= 20, `${kind}: ${pairs}`);
      const lightness = samples(P.diverging, 101).map((hex) => toLab(sim(hex, kind))[0]);
      const tolerance = 0.3;
      assert.ok(lightness.slice(0, 51).every((L, i) => i === 0 || L < lightness[i - 1] + tolerance), `${kind}: blue half`);
      assert.ok(lightness.slice(50).every((L, i) => i === 0 || L > lightness[50 + i - 1] - tolerance), `${kind}: orange half`);
    }
  });
});
