import { createCalendar } from "./calendar/index.js";
import { buildOption } from "./calendar/option.js";
import { calendarTable, calendarTableHtml } from "./calendar/table.js";
import { buildCalendar } from "./calendar/transform.js";
import { ApiError, RECORD_START_MONTH, calendarBody, getMetadata, lastRecordMonth, postCalendar, postCurrentMonth, resolveRange } from "./client-api.js";
import { createMap } from "./map/map.js";
import { renderArea, snapForMap } from "./panels/area.js";
import { renderCurrentMonth } from "./panels/current-month.js";
import { h } from "./panels/dom.js";
import { createExportsPanel } from "./panels/exports.js";
import { errorMessage } from "./panels/messages.js";
import { VIEWS, areaFromPolygon, areaPolygon, parseState, serializeState, seriesForView } from "./url-state.js";

/**
 * @typedef {import("../shared/contracts.js").Aoi} Aoi
 * @typedef {import("../shared/contracts.js").Metadata} Metadata
 * @typedef {import("../shared/contracts.js").RegionMeta} RegionMeta
 * @typedef {import("../shared/contracts.js").CalendarRequest} CalendarRequest
 * @typedef {import("../shared/contracts.js").CalendarResponse} CalendarResponse
 * @typedef {import("../shared/contracts.js").CurrentMonthResponse} CurrentMonthResponse
 * @typedef {import("./url-state.js").AppState} AppState
 * @typedef {import("./url-state.js").View} View
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

/**
 * The calendar's height for a response covering `start` to `end`, so the space is reserved
 * before the data arrives.
 * @param {{ view: View, julyStart: boolean, width: number, start: string, end: string, title: string }} options
 */
export function estimateCalendarHeight({ view, julyStart, width, start, end, title }) {
  const months = [];
  const first = start < RECORD_START_MONTH ? RECORD_START_MONTH : start;
  let [year, month] = first.split("-").map(Number);
  const [lastYear, lastMonth] = end.split("-").map(Number);
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
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
  return buildOption(buildCalendar(response, { view, julyStart }), { width, title }).height;
}

/** A map stand-in when MapLibre or terra-draw could not load: the calendar still works. */
const NO_MAP = {
  setSnapped: async () => {},
  fitRegion: () => {},
  clear: () => {},
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
 * Starts the page: reads the URL, loads metadata, builds the map, calendar and side panel, and
 * keeps them and the URL in step. index.html runs this module before its defer scripts, so the
 * metadata, calendar and current-month requests for the URL's state go out while the vendored
 * libraries are still downloading; the page is built once they have run.
 * @param {Document} [doc]
 */
export async function startApp(doc = document) {
  /** @type {AppState} */
  let state = parseState(location.search);
  /** @type {PromiseCache<{ body: CalendarResponse, mock: boolean }>} */
  const calendars = new PromiseCache();
  /** @type {PromiseCache<{ body: CurrentMonthResponse, mock: boolean }>} */
  const currentMonths = new PromiseCache();
  const metadataLoad = getMetadata();
  metadataLoad.then(({ body }) => prefetch(body), () => {});
  await pageLoaded(doc);

  const $ = (id) => /** @type {HTMLElement} */ (doc.getElementById(id));
  const ui = {
    presets: $("region-presets"),
    viewToggle: $("view-toggle"),
    from: /** @type {HTMLSelectElement} */ ($("range-from")),
    to: /** @type {HTMLSelectElement} */ ($("range-to")),
    july: /** @type {HTMLInputElement} */ ($("july-start")),
    notice: $("notice"),
    map: $("map"),
    area: { summary: $("area-summary"), warning: $("clip-warning"), message: $("area-message") },
    currentMonth: $("current-month"),
    exports: $("exports"),
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
  /** JSON of the polygon the map overlay and area panel describe, and of the one the card shows. */
  let areaKey = null;
  let monthKey = null;

  renderArea(ui.area, { status: "loading" });
  renderCurrentMonth(ui.currentMonth, { status: "loading" });

  try {
    const result = await metadataLoad;
    metadata = result.body;
    noteMock(result.mock);
  } catch (error) {
    const message = errorMessage(error instanceof ApiError ? error : new ApiError("server_error", String(error)), []);
    renderArea(ui.area, { status: "error", message });
    renderCurrentMonth(ui.currentMonth, { status: "empty", text: "No data to show." });
    setCalendarState("empty", `${message.title} Reload the page to try again.`);
    return;
  }

  const regionById = new Map(metadata.regions.map((region) => [region.id, region]));
  const regionName = (id) => regionById.get(id)?.name ?? id;
  const describeError = (error) => errorMessage(error, metadata.regions);

  ui.attribution.textContent = metadata.attribution;
  const method = metadata.method;
  ui.dataInfo.textContent =
    `Data ${metadata.data_version} · weights ${method.weight_method}${method.model_version ? ` (${method.model_version})` : ""} · ` +
    `calibration ${method.calibration_years} · baseline ${method.baseline} · NOAA-20 from ${method.viirs_switch}`;

  buildPresets();
  buildRangeSelects();
  syncControls();

  let map = NO_MAP;
  try {
    map = createMap(ui.map, {
      regions: metadata.regions,
      onAoiChange: (polygon, { source }) => (polygon ? changeArea(areaFromPolygon(polygon)) : clearArea(source)),
      onRegionSelect: (id) => selectPreset(id, { fit: false }),
    });
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

  ui.viewToggle.addEventListener("change", (event) => {
    const view = /** @type {View} */ (/** @type {HTMLInputElement} */ (event.target).value);
    if (!VIEWS.includes(view)) return;
    const series = seriesForView(view);
    const refetch = series !== state.series;
    setState({ view, series });
    if (refetch) load();
    else drawCalendar();
  });
  ui.july.addEventListener("change", () => {
    setState({ julyStart: ui.july.checked });
    drawCalendar();
  });
  ui.from.addEventListener("change", () => changeRange("from"));
  ui.to.addEventListener("change", () => changeRange("to"));
  ui.numbers.addEventListener("toggle", () => fillTable());

  setState({});
  showArea({ fit: true });

  /**
   * Asks for the calendar and current month of the URL's area into the caches, with the exact
   * requests load() makes, so load() finds them already on their way.
   * @param {Metadata} meta
   */
  function prefetch(meta) {
    const polygon = areaPolygon(state.area, meta.regions.find((region) => region.id === state.region));
    if (!polygon) return;
    const request = calendarBody(polygon, state, meta);
    calendars.get(JSON.stringify(request), () => postCalendar(request)).catch(() => {});
    currentMonths.get(JSON.stringify(polygon), () => postCurrentMonth(polygon)).catch(() => {});
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
          class: "button preset",
          "data-region": region.id,
          "aria-pressed": "false",
          text: region.name,
          onclick: () => selectPreset(region.id, { fit: true }),
        }),
      ),
    );
  }

  function buildRangeSelects() {
    const firstYear = Number(RECORD_START_MONTH.slice(0, 4));
    const lastYear = Number(lastRecordMonth(metadata).slice(0, 4));
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
    ui.july.checked = state.julyStart;
    if (metadata) {
      const { start, end } = resolveRange(state, metadata);
      ui.from.value = String(Math.max(Number(start.slice(0, 4)), Number(RECORD_START_MONTH.slice(0, 4))));
      ui.to.value = end.slice(0, 4);
    }
  }

  /** @param {"from" | "to"} changed */
  function changeRange(changed) {
    const firstYear = Number(RECORD_START_MONTH.slice(0, 4));
    const lastYear = Number(lastRecordMonth(metadata).slice(0, 4));
    let from = Number(ui.from.value);
    let to = Number(ui.to.value);
    if (from > to) {
      if (changed === "from") to = from;
      else from = to;
    }
    setState({ start: from === firstYear ? null : `${from}-01`, end: to === lastYear ? null : `${to}-12` });
    load();
  }

  /**
   * @param {string} id
   * @param {{ fit: boolean }} options
   */
  function selectPreset(id, { fit }) {
    if (!regionById.has(id)) return;
    setState({ region: /** @type {AppState["region"]} */ (id), area: { kind: "preset" } });
    showArea({ fit: false });
    if (fit) map.fitRegion(/** @type {AppState["region"]} */ (id));
  }

  /** @param {AppState["area"]} area */
  function changeArea(area) {
    setState({ area });
    load();
  }

  /** @param {string} source */
  function clearArea(source) {
    if (source !== "clear") return;
    loadId += 1;
    shown = null;
    areaKey = null;
    monthKey = null;
    exportsPanel.setReady(false);
    renderArea(ui.area, { status: "empty", text: "No area. Pick a region above, draw an area on the map, or type a box." });
    renderCurrentMonth(ui.currentMonth, { status: "empty", text: "Pick an area to compare this month with its history." });
    setCalendarState("empty", "Pick a region or draw an area to see its calendar.");
    fillTable();
  }

  /** Puts the state's area on the map (for a preset or a URL), then loads it. */
  function showArea({ fit }) {
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
    doc.title = `HotOrNot · ${regionName(shown.response.region_id)}`;
    fillTable();
    if (!calendar) {
      setCalendarState(
        "empty",
        "The calendar could not be drawn because the chart library did not load. Its numbers are in the table below, and the downloads still work.",
      );
      return;
    }
    calendar.render(shown.response, { view: state.view, julyStart: state.julyStart, title: regionName(shown.response.region_id) });
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
   * Fetches the calendar for the state and draws it, then fetches the current month unless the
   * card already shows this area. Results of a load that a newer one replaced are dropped; the
   * requests still finish and fill the caches.
   */
  async function load() {
    const polygon = currentPolygon();
    if (!polygon) return;
    const id = ++loadId;
    const key = JSON.stringify(polygon);

    if (key !== areaKey) {
      areaKey = key;
      monthKey = null;
      const overlay = snapForMap(polygon, metadata.regions);
      map.setSnapped(overlay.counted, overlay.uncovered).catch((error) => console.warn("the map could not draw the cells:", error));
      if (overlay.regionId && overlay.regionId !== state.region) setState({ region: /** @type {AppState["region"]} */ (overlay.regionId) });
      renderArea(ui.area, { status: "loading" });
      renderCurrentMonth(ui.currentMonth, { status: "loading" });
    }
    setCalendarState("loading", "Loading the calendar…");
    reserveCalendarHeight();
    exportsPanel.setReady(false);

    const request = calendarBody(polygon, state, metadata);
    let result;
    try {
      result = await calendars.get(JSON.stringify(request), () => postCalendar(request));
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

    if (monthKey === key) return;
    renderCurrentMonth(ui.currentMonth, { status: "loading" });
    try {
      const current = await currentMonths.get(key, () => postCurrentMonth(polygon));
      if (id !== loadId) return;
      monthKey = key;
      noteMock(current.mock);
      renderCurrentMonth(ui.currentMonth, { status: "ready", data: current.body });
    } catch (error) {
      if (id === loadId) renderCurrentMonth(ui.currentMonth, { status: "error", message: describeError(asApiError(error)) });
    }
  }

  /** @param {unknown} error */
  function asApiError(error) {
    return error instanceof ApiError ? error : new ApiError("server_error", String(error));
  }

  /** @param {unknown} error */
  function showError(error) {
    const apiError = asApiError(error);
    const message = describeError(apiError);
    shown = null;
    monthKey = null;
    exportsPanel.setReady(false);
    renderArea(ui.area, { status: "error", message, onRegion: (id) => selectPreset(id, { fit: true }) });
    renderCurrentMonth(ui.currentMonth, { status: "empty", text: "No comparison for this area." });
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
