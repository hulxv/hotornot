import { createCalendar } from "./calendar/index.js";
import { buildOption } from "./calendar/option.js";
import { calendarTable, calendarTableHtml } from "./calendar/table.js";
import { MONTH_LONG, buildCalendar } from "./calendar/transform.js";
import { ApiError, RECORD_START_MONTH, calendarBody, getMetadata, lastRecordMonth, postCalendar, postCurrentMonth, resolveRange } from "./client-api.js";
import { createMap } from "./map/map.js";
import { areaLabel, renderArea, snapForMap } from "./panels/area.js";
import { h } from "./panels/dom.js";
import { createExportsPanel } from "./panels/exports.js";
import { errorMessage } from "./panels/messages.js";
import { renderVerdict } from "./panels/verdict-card.js";
import { createStory } from "./story/story.js";
import { EXAMPLES, VIEWS, areaFromPolygon, areaPolygon, parseState, serializeState, seriesForView } from "./url-state.js";
import { verdict, verdictMonth } from "./verdict.js";
import { TIME } from "../shared/contracts.js";

/**
 * @typedef {import("../shared/contracts.js").Aoi} Aoi
 * @typedef {import("../shared/contracts.js").Metadata} Metadata
 * @typedef {import("../shared/contracts.js").CalendarRequest} CalendarRequest
 * @typedef {import("../shared/contracts.js").CalendarResponse} CalendarResponse
 * @typedef {import("./url-state.js").AppState} AppState
 * @typedef {import("./url-state.js").View} View
 * @typedef {import("./verdict.js").MonthSummary} MonthSummary
 * @typedef {{ year: number, month: number }} YearMonth
 */

const CACHE_LIMIT = 24;

/**
 * Remembers request promises by key, so switching back to an earlier view, range or area
 * costs no request. Failed requests are forgotten.
 * @template T
 */
class PromiseCache {
  /** @type {Map<string, Promise<T>>} */
  entries = new Map();

  /** @param {string} key @param {() => Promise<T>} load */
  get(key, load) {
    let promise = this.entries.get(key);
    if (promise) {
      this.entries.delete(key);
    } else {
      promise = load();
      promise.catch(() => this.entries.delete(key));
    }
    this.entries.set(key, promise);
    if (this.entries.size > CACHE_LIMIT) this.entries.delete(this.entries.keys().next().value);
    return promise;
  }
}

/** @param {string} ym YYYY-MM @returns {YearMonth} */
const toYearMonth = (ym) => {
  const [year, month] = ym.split("-").map(Number);
  return { year, month };
};

const BASELINE_FIRST_YEAR = TIME.BASELINE.start_year;

/** @param {string} date YYYY-MM-DD */
const longDate = (date) => {
  const [year, month, day] = date.split("-").map(Number);
  return `${day} ${MONTH_LONG[month - 1]} ${year}`;
};

/** @param {string} ym YYYY-MM */
const monthName = (ym) => {
  const { year, month } = toYearMonth(ym);
  return `${MONTH_LONG[month - 1]} ${year}`;
};

const GUIDE = {
  harmonized: "Each square is one month. Brighter means more fires.",
  anomaly: "Each square is one month. Orange means more fires than normal, blue means fewer.",
  raw: "Each square is one month, before harmonizing: MODIS above, VIIRS below. Brighter means more fires.",
};

/**
 * The line above the calendar: how to read it, and which month is outlined.
 * @param {View} view
 * @param {string} focus the outlined month, YYYY-MM
 * @param {string} latest the newest month with data, YYYY-MM
 */
export function calendarGuide(view, focus, latest) {
  const outlined = focus === latest ? "this month" : monthName(focus);
  return `${GUIDE[view]} ${view === "raw" ? `The outlined squares are ${outlined}.` : `The outlined square is ${outlined}.`}`;
}

/**
 * The calendar's height for a response covering `start` to `end`, so the space is reserved
 * before the data arrives.
 * @param {{ view: View, julyStart: boolean, width: number, start: string, end: string, title: string, highlight: YearMonth | null }} options
 */
export function estimateCalendarHeight({ view, julyStart, width, start, end, title, highlight }) {
  const months = [];
  const first = start < RECORD_START_MONTH ? RECORD_START_MONTH : start;
  let { year, month } = toYearMonth(first);
  const last = toYearMonth(end);
  while (year < last.year || (year === last.year && month <= last.month)) {
    months.push({
      year,
      month,
      value: 1,
      modis_raw: 1,
      viirs_raw: 1,
      median: 1,
      anomaly_log2: 0.5,
      difference: 0,
      rank: 1,
      of_years: 1,
      provisional: false,
      partial_coverage: false,
    });
    [year, month] = month === 12 ? [year + 1, 1] : [year, month + 1];
  }
  const response = /** @type {CalendarResponse} */ ({
    region_id: "nile_delta",
    units: "modis_equivalent_hotspots",
    data_version: "v0",
    weight_method: "ratio_v1",
    clipped_fraction: 0,
    aoi: { cells: 1, covered_cells: 1, area_km2: 1, snapped_fraction: 1 },
    baseline: { start_year: 2003, end_year: 2025 },
    fire_season: [1],
    months,
  });
  return buildOption(buildCalendar(response, { view, julyStart, highlight }), { width, title }).height;
}

/** A map stand-in when MapLibre or terra-draw could not load: the calendar still works. */
const NO_MAP = {
  setSnapped: async () => {},
  setAoi: async () => {},
};

/**
 * Resolves once the window's load event has passed, so the DOM is parsed and the vendored defer
 * scripts have run or failed.
 * @param {Document} doc
 */
const pageLoaded = (doc) =>
  !doc.readyState || doc.readyState === "complete"
    ? Promise.resolve()
    : new Promise((resolve) => doc.defaultView?.addEventListener("load", resolve, { once: true }));

/**
 * Starts the page: reads the URL, loads metadata, builds the region buttons, verdict, map and
 * calendar, and keeps them and the URL in step. index.html runs this module before its defer
 * scripts, so the first requests for the URL's state go out while the vendored libraries are
 * still downloading; the page is built once they have run.
 * @param {Document} [doc]
 */
export async function startApp(doc = document) {
  /** @type {AppState} */
  let state = parseState(location.search);
  /** @type {PromiseCache<{ body: CalendarResponse, mock: boolean }>} */
  const calendars = new PromiseCache();
  /** @type {PromiseCache<{ body: MonthSummary, mock: boolean }>} */
  const currentMonths = new PromiseCache();
  const metadataLoad = getMetadata();
  metadataLoad.then(({ body }) => prefetch(body), () => {});
  await pageLoaded(doc);

  const $ = (id) => /** @type {HTMLElement} */ (doc.getElementById(id));
  const ui = {
    presets: $("region-presets"),
    drawArea: /** @type {HTMLButtonElement} */ ($("draw-area")),
    typeCoordinates: /** @type {HTMLButtonElement} */ ($("type-coordinates")),
    area: { summary: $("area-summary"), warning: $("clip-warning"), message: $("area-message") },
    verdict: { card: $("verdict-card"), where: $("verdict-where"), body: $("verdict") },
    examples: $("examples"),
    notice: $("notice"),
    map: $("map"),
    viewToggle: $("view-toggle"),
    menus: [/** @type {HTMLDetailsElement} */ ($("more-options")), /** @type {HTMLDetailsElement} */ ($("downloads"))],
    from: /** @type {HTMLSelectElement} */ ($("range-from")),
    to: /** @type {HTMLSelectElement} */ ($("range-to")),
    july: /** @type {HTMLInputElement} */ ($("july-start")),
    raw: /** @type {HTMLInputElement} */ ($("raw-view")),
    exports: $("exports"),
    guide: $("calendar-guide"),
    frame: $("calendar-frame"),
    calendar: $("calendar"),
    calendarSection: $("calendar-section"),
    calendarStatus: $("calendar-status"),
    numbers: /** @type {HTMLDetailsElement} */ ($("calendar-numbers")),
    table: $("calendar-table"),
    attribution: $("attribution"),
    dataInfo: $("data-info"),
  };

  /** @type {Metadata} */
  let metadata;
  let mock = false;
  /** @type {{ request: CalendarRequest, response: CalendarResponse } | null} */
  let shown = null;
  let loadId = 0;
  /** JSON of the polygon the map overlay and area panel describe, and of the polygon and month the verdict shows. */
  let areaKey = null;
  let verdictKey = null;
  /** False while the area lies outside every region, so the verdict does not name one. */
  let inRegion = true;

  renderArea(ui.area, { status: "loading" });
  renderVerdict(ui.verdict, { status: "loading", area: "" });

  try {
    const result = await metadataLoad;
    metadata = result.body;
    noteMock(result.mock);
  } catch (error) {
    const message = errorMessage(asApiError(error), []);
    renderArea(ui.area, { status: "error", message });
    renderVerdict(ui.verdict, { status: "empty", area: "", text: "No data to show." });
    setCalendarState("empty", `${message.title} Reload the page to try again.`);
    return;
  }

  const latest = lastRecordMonth(metadata);
  const regionById = new Map(metadata.regions.map((region) => [region.id, region]));
  const regionName = (id) => regionById.get(id)?.name ?? id;
  const describeError = (error) => errorMessage(error, metadata.regions);

  ui.attribution.textContent = metadata.attribution;
  const method = metadata.method;
  const through = metadata.regions.map((region) => region.coverage.nrt_until).sort().at(-1);
  ui.dataInfo.textContent =
    `NASA FIRMS fire detections through ${longDate(through)}. MODIS and VIIRS are counted on one scale ` +
    `(${method.weight_method === "model_v1" ? "detection model" : "ratio method"}, checked on years it never saw).`;

  buildPresets();
  buildExamples();
  buildRangeSelects();
  syncControls();

  let map = NO_MAP;
  try {
    map = createMap(ui.map, {
      regions: metadata.regions,
      onAoiChange: (polygon) => polygon && changeArea(areaFromPolygon(polygon)),
      onRegionSelect: (id) => selectPreset(id),
    });
    ui.drawArea.disabled = false;
    ui.typeCoordinates.disabled = false;
  } catch (error) {
    console.error(error);
    ui.map.replaceChildren(h("p", { class: "banner banner--error", text: "The map could not load. The region buttons above still work." }));
  }

  /** @type {ReturnType<typeof createCalendar> | null} */
  let calendar = null;
  reserveCalendarHeight();
  try {
    calendar = createCalendar(ui.calendar);
  } catch (error) {
    console.error(error);
  }

  const exportsPanel = createExportsPanel(ui.exports, {
    describeError,
    getContext: () =>
      shown && { request: shown.request, response: shown.response, metadata, view: state.view, toPng: () => calendarPng() },
  });

  ui.drawArea.addEventListener("click", (event) => {
    ui.map.scrollIntoView?.({ block: "nearest" });
    // A click from Enter or Space, or from a screen reader, has detail 0; drawing needs a pointer.
    if (/** @type {MouseEvent} */ (event).detail === 0) map.openBoxForm();
    else map.startDrawing();
  });
  ui.typeCoordinates.addEventListener("click", () => {
    ui.map.scrollIntoView?.({ block: "nearest" });
    map.openBoxForm("");
  });
  ui.viewToggle.addEventListener("change", (event) => changeView(/** @type {View} */ (/** @type {HTMLInputElement} */ (event.target).value)));
  ui.raw.addEventListener("change", () => changeView(ui.raw.checked ? "raw" : "harmonized"));
  ui.july.addEventListener("change", () => {
    setState({ julyStart: ui.july.checked });
    drawCalendar();
  });
  ui.from.addEventListener("change", () => changeRange("from"));
  ui.to.addEventListener("change", () => changeRange("to"));
  ui.numbers.addEventListener("toggle", () => fillTable());
  for (const menu of ui.menus) {
    menu.addEventListener("keydown", (event) => {
      if (/** @type {KeyboardEvent} */ (event).key !== "Escape" || !menu.open) return;
      menu.open = false;
      /** @type {HTMLElement} */ (menu.querySelector("summary")).focus();
    });
  }
  doc.documentElement.addEventListener("click", (event) => {
    for (const menu of ui.menus) if (menu.open && !menu.contains(/** @type {Node} */ (event.target))) menu.open = false;
  });

  setState({});
  // The default page opens on all four regions; a link to a place opens on that place.
  showArea({ fit: serializeState(state) !== "" });
  createStory(doc, { getState: () => state, applyState });

  /** The month the verdict is about and the calendar outlines, YYYY-MM. */
  function focusMonth() {
    return verdictMonth(state.end, latest);
  }

  /** @param {CalendarRequest} request */
  function fetchCalendar(request) {
    return calendars.get(JSON.stringify(request), () => postCalendar(request));
  }

  /**
   * The month the verdict describes: this month from `/api/current-month` (the same days in
   * other years), an earlier one from the harmonized calendar.
   * @param {Aoi} polygon
   * @param {string} focus YYYY-MM
   * @param {Metadata} meta
   * @returns {Promise<{ body: MonthSummary, mock: boolean }>}
   */
  async function fetchVerdictMonth(polygon, focus, meta) {
    if (focus === lastRecordMonth(meta)) return currentMonths.get(JSON.stringify(polygon), () => postCurrentMonth(polygon));
    const { body, mock: isMock } = await fetchCalendar(calendarBody(polygon, { ...state, view: "harmonized", series: "harmonized" }, meta));
    const { year, month } = toYearMonth(focus);
    const found = body.months.find((m) => m.year === year && m.month === month);
    const empty = { year, month, value: null, median: null, rank: null, of_years: null, provisional: false, partial_coverage: false };
    const history = body.months
      .filter((m) => m.month === month && m.year >= BASELINE_FIRST_YEAR && m.year <= year && m.value !== null)
      .map((m) => ({ year: m.year, value: m.value }));
    return { body: found ? { ...found, history } : empty, mock: isMock };
  }

  /**
   * Asks for the URL area's calendar and verdict month into the caches, with the exact requests
   * load() makes, so load() finds them already on their way.
   * @param {Metadata} meta
   */
  function prefetch(meta) {
    const polygon = areaPolygon(state.area, meta.regions.find((region) => region.id === state.region));
    if (!polygon) return;
    fetchCalendar(calendarBody(polygon, state, meta)).catch(() => {});
    fetchVerdictMonth(polygon, verdictMonth(state.end, lastRecordMonth(meta)), meta).catch(() => {});
  }

  /** Applies a change, reflects it in the controls and rewrites the URL in its canonical form. */
  function setState(patch) {
    state = { ...state, ...patch };
    syncControls();
    const query = serializeState(state);
    history.replaceState(history.state, "", `${location.pathname}${query}${location.hash}`);
  }

  function buildPresets() {
    ui.presets.replaceChildren(
      ...metadata.regions.map((region) =>
        h("button", {
          type: "button",
          class: "button region",
          "data-region": region.id,
          "aria-pressed": "false",
          text: region.name,
          onclick: () => selectPreset(region.id),
        }),
      ),
    );
  }

  function buildExamples() {
    ui.examples.replaceChildren(
      ...EXAMPLES.flatMap((example) => [
        h("a", {
          href: `${location.pathname}${serializeState(example.state)}`,
          text: example.label,
          onclick: (event) => {
            const click = /** @type {MouseEvent} */ (event);
            if (click.button > 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return;
            click.preventDefault();
            applyState(example.state);
          },
        }),
      ]),
    );
  }

  function buildRangeSelects() {
    const firstYear = Number(RECORD_START_MONTH.slice(0, 4));
    const lastYear = Number(latest.slice(0, 4));
    for (const select of [ui.from, ui.to]) {
      select.replaceChildren();
      for (let year = firstYear; year <= lastYear; year += 1) select.append(h("option", { value: String(year), text: String(year) }));
      select.disabled = false;
    }
  }

  function syncControls() {
    for (const button of ui.presets.querySelectorAll("button[data-region]")) {
      const pressed = state.area.kind === "preset" && button.getAttribute("data-region") === state.region;
      button.setAttribute("aria-pressed", String(pressed));
    }
    for (const input of ui.viewToggle.querySelectorAll("input[name=view]")) {
      /** @type {HTMLInputElement} */ (input).checked = /** @type {HTMLInputElement} */ (input).value === state.view;
    }
    ui.raw.checked = state.view === "raw";
    ui.july.checked = state.julyStart;
    if (metadata) {
      const { start, end } = resolveRange(state, metadata);
      ui.from.value = String(Math.max(Number(start.slice(0, 4)), Number(RECORD_START_MONTH.slice(0, 4))));
      ui.to.value = end.slice(0, 4);
      ui.guide.textContent = calendarGuide(state.view, focusMonth(), latest);
    }
  }

  /** @param {View} view */
  function changeView(view) {
    if (!VIEWS.includes(view)) return;
    const series = seriesForView(view);
    const refetch = series !== state.series;
    setState({ view, series });
    if (refetch) load();
    else drawCalendar();
  }

  /** @param {"from" | "to"} changed */
  function changeRange(changed) {
    const firstYear = Number(RECORD_START_MONTH.slice(0, 4));
    const lastYear = Number(latest.slice(0, 4));
    let from = Number(ui.from.value);
    let to = Number(ui.to.value);
    if (from > to) {
      if (changed === "from") to = from;
      else from = to;
    }
    setState({ start: from === firstYear ? null : `${from}-01`, end: to === lastYear ? null : `${to}-12` });
    load();
  }

  /** @param {AppState} next a whole state: a Try link or a story step */
  function applyState(next) {
    setState({ ...next });
    showArea();
  }

  /** @param {string} id */
  function selectPreset(id) {
    if (!regionById.has(id)) return;
    setState({ region: /** @type {AppState["region"]} */ (id), area: { kind: "preset" }, start: null, end: null });
    showArea();
  }

  /** @param {AppState["area"]} area */
  function changeArea(area) {
    setState({ area });
    load();
  }

  /**
   * Puts the state's area on the map (for a preset, an example or the URL), then loads it.
   * @param {{ fit?: boolean }} [options] whether the map zooms to the area
   */
  function showArea({ fit = true } = {}) {
    const polygon = currentPolygon();
    if (polygon) {
      map.setAoi(polygon, { fit }).catch((error) => console.warn("the map could not show the area:", error));
    }
    // setAoi clears the cell overlay, so load() has to draw it again even for the same area.
    areaKey = null;
    load();
  }

  function currentPolygon() {
    return areaPolygon(state.area, regionById.get(state.region));
  }

  function currentHighlight() {
    return toYearMonth(focusMonth());
  }

  function currentAreaLabel() {
    return inRegion ? areaLabel(regionName(state.region), state.area.kind === "preset") : "Your area";
  }

  function reserveCalendarHeight() {
    if (ui.frame.dataset.state !== "initial") return;
    const { start, end } = resolveRange(state, metadata);
    const height = estimateCalendarHeight({
      view: state.view,
      julyStart: state.julyStart,
      width: ui.calendar.clientWidth || 800,
      start,
      end,
      title: regionName(state.region),
      highlight: currentHighlight(),
    });
    ui.calendar.style.height = `${height}px`;
  }

  /**
   * `initial` shows the skeleton, `loading` dims the calendar being replaced, `empty` hides it
   * behind the status text. Loading after `initial` or `empty` shows the skeleton, so the
   * calendar of another area never shows through.
   * @param {"initial" | "loading" | "ready" | "empty"} next
   * @param {string} [text] status text: what is loading, or why there is no calendar
   */
  function setCalendarState(next, text = "") {
    const replacing = ui.frame.dataset.state === "ready" || ui.frame.dataset.state === "loading";
    ui.frame.dataset.state = next === "loading" && !replacing ? "initial" : next;
    ui.calendarSection.setAttribute("aria-busy", String(next === "loading"));
    ui.calendarStatus.textContent = text;
  }

  function drawCalendar() {
    if (!shown) return;
    doc.title = `Hot or Not · ${regionName(shown.response.region_id)}`;
    fillTable();
    if (!calendar) {
      setCalendarState(
        "empty",
        "The calendar could not be drawn because the chart library did not load. Its numbers are in the table below, and the downloads still work.",
      );
      return;
    }
    calendar.render(shown.response, {
      view: state.view,
      julyStart: state.julyStart,
      title: regionName(shown.response.region_id),
      highlight: currentHighlight(),
    });
  }

  /** The calendar as a table, the keyboard and screen-reader route to what its tooltips say. Built only while open. */
  function fillTable() {
    if (!ui.numbers.open) return;
    if (!shown) {
      ui.table.replaceChildren(h("p", { class: "muted", text: "No calendar to show." }));
      return;
    }
    ui.table.innerHTML = calendarTableHtml(calendarTable(shown.response, { view: state.view, title: regionName(shown.response.region_id) }));
  }

  function calendarPng() {
    if (!calendar) throw new ApiError("server_error", "the chart library did not load");
    return calendar.toPng();
  }

  /**
   * Fetches the calendar for the state and draws it, and the verdict's month unless the card
   * already shows it. Results of a load that a newer one replaced are dropped; the requests
   * still finish and fill the caches.
   */
  function load() {
    const polygon = currentPolygon();
    if (!polygon) return;
    const id = ++loadId;
    const key = JSON.stringify(polygon);

    if (key !== areaKey) {
      areaKey = key;
      verdictKey = null;
      const overlay = snapForMap(polygon, metadata.regions);
      inRegion = state.area.kind === "preset" || overlay.regionId !== null;
      map.setSnapped(overlay.counted, overlay.uncovered).catch((error) => console.warn("the map could not draw the cells:", error));
      if (overlay.regionId && overlay.regionId !== state.region) setState({ region: /** @type {AppState["region"]} */ (overlay.regionId) });
      renderArea(ui.area, { status: "loading" });
    }
    setCalendarState("loading", "Loading the calendar…");
    reserveCalendarHeight();
    exportsPanel.setReady(false);
    loadCalendar(id, polygon);
    loadVerdict(id, polygon, key);
  }

  /** @param {number} id @param {Aoi} polygon */
  async function loadCalendar(id, polygon) {
    const request = calendarBody(polygon, state, metadata);
    let result;
    try {
      result = await fetchCalendar(request);
    } catch (error) {
      if (id === loadId) showError(error);
      return;
    }
    if (id !== loadId) return;
    shown = { request, response: result.body };
    noteMock(result.mock);
    const response = result.body;
    if (response.region_id !== state.region) setState({ region: response.region_id });
    if (calendar) setCalendarState("ready");
    drawCalendar();
    exportsPanel.setReady(true);
    renderArea(ui.area, {
      status: "ready",
      response,
      regionName: regionName(response.region_id),
      preset: state.area.kind === "preset",
    });
  }

  /** @param {number} id @param {Aoi} polygon @param {string} key */
  async function loadVerdict(id, polygon, key) {
    const focus = focusMonth();
    const wanted = JSON.stringify([key, focus]);
    if (verdictKey === wanted) return;
    verdictKey = null;
    renderVerdict(ui.verdict, { status: "loading", area: currentAreaLabel() });
    try {
      const result = await fetchVerdictMonth(polygon, focus, metadata);
      if (id !== loadId) return;
      verdictKey = wanted;
      noteMock(result.mock);
      renderVerdict(ui.verdict, {
        status: "ready",
        area: currentAreaLabel(),
        verdict: verdict(result.body),
        summary: result.body,
        onLatest: focus === latest ? undefined : backToToday,
      });
    } catch (error) {
      if (id === loadId) renderVerdict(ui.verdict, { status: "empty", area: currentAreaLabel(), text: describeError(asApiError(error)).title });
    }
  }

  function backToToday() {
    setState({ start: null, end: null });
    load();
  }

  /** @param {unknown} error */
  function showError(error) {
    const message = describeError(asApiError(error));
    shown = null;
    exportsPanel.setReady(false);
    renderArea(ui.area, { status: "error", message, onRegion: (id) => selectPreset(id) });
    setCalendarState("empty", `${message.title} No calendar to show.`);
    fillTable();
  }

  /** @param {boolean} isMock */
  function noteMock(isMock) {
    mock = mock || isMock;
    ui.notice.hidden = !mock;
    ui.notice.textContent = mock ? "This page is showing mock data for development, not satellite observations." : "";
  }
}

/** @param {unknown} error */
function asApiError(error) {
  return error instanceof ApiError ? error : new ApiError("server_error", String(error));
}
