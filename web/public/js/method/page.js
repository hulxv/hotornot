import { CHART_HEIGHT, detectionOption, n20Option, seamOption } from "./option.js";
import {
  chartCardHtml,
  detectionNumbersHtml,
  escapeHtml,
  kTableHtml,
  legendHtml,
  lineLegendItems,
  n20NumbersHtml,
  n20ScoresHtml,
  scorecardHtml,
  seamNumbersHtml,
  statusHtml,
} from "./html.js";
import { WEIGHT_METHOD_NAMES, driftText, formatDate, methodView, rawMultiplesText } from "./transform.js";

/**
 * @typedef {ReturnType<typeof methodView>} MethodView
 * @typedef {{ option: object, height: number }} BuiltOption
 * @typedef {{ chart: any, width: number, draw: () => void }} Mounted
 */

/**
 * Draws the method page from a /api/method body into `doc`, which must hold the containers in
 * method.html. ECharts comes from the `echarts` global.
 * @param {import("./transform.js").MethodBody} body
 * @param {Document} [doc]
 */
export function renderMethodPage(body, doc = document) {
  const view = methodView(body);
  const byId = (id) => doc.getElementById(id);
  const setHtml = (id, html) => {
    const element = byId(id);
    if (element) element.innerHTML = html;
  };
  /** @type {Map<Element, Mounted>} */
  const mounted = new Map();
  const observer =
    typeof ResizeObserver === "function"
      ? new ResizeObserver((entries) => {
          for (const entry of entries) {
            const chart = mounted.get(entry.target);
            if (chart && entry.target.clientWidth !== chart.width) {
              chart.chart.resize();
              chart.draw();
            }
          }
        })
      : null;

  /** @param {string} id @param {(width: number) => BuiltOption} build */
  function mount(id, build) {
    const element = byId(`chart-${id}`);
    if (!element) return null;
    const echarts = /** @type {any} */ (globalThis).echarts;
    if (!echarts) {
      element.innerHTML = '<p class="chart-empty">The chart library did not load.</p>';
      return null;
    }
    element.innerHTML = "";
    const chart = echarts.init(element, null, { renderer: "canvas" });
    /** @type {Mounted} */
    const entry = {
      chart,
      width: 0,
      draw() {
        entry.width = element.clientWidth;
        chart.setOption(build(entry.width || 600).option, { notMerge: true });
      },
    };
    entry.draw();
    mounted.set(element, entry);
    observer?.observe(element);
    return entry;
  }

  /** Fills a chart's numbers table the first time it is opened. @param {string} id @param {() => string} html */
  function numbers(id, html) {
    const details = byId(`numbers-${id}`);
    if (!details) return;
    details.addEventListener("toggle", () => {
      const target = byId(`numbers-body-${id}`);
      if (details.open && target && target.childElementCount === 0) target.innerHTML = html();
    });
  }

  for (const element of doc.querySelectorAll("[data-method]")) {
    element.hidden = element.getAttribute("data-method") !== view.shipped;
  }
  for (const element of doc.querySelectorAll("[data-mock]")) {
    element.hidden = !view.mock[element.getAttribute("data-mock")];
  }
  for (const element of doc.querySelectorAll('[data-fill="viirs-switch"]')) {
    element.textContent = formatDate(view.method.viirs_switch);
  }
  for (const element of doc.querySelectorAll('[data-fill="shipped"]')) {
    element.textContent = WEIGHT_METHOD_NAMES[view.shipped];
  }

  setHtml("method-status", statusHtml(view));
  const multiples = rawMultiplesText(view.rawMultiples);
  setHtml("raw-multiples", multiples ? ` Here raw VIIRS counted ${escapeHtml(multiples)}.` : "");

  const noValidation = view.mock.validation
    ? "The development mocks have a validation series for the Nile Delta only."
    : "No validation series is published for this region.";

  const seamWithData = view.seams.find((seam) => seam.model);
  setHtml("seam-legend", seamWithData ? legendHtml(lineLegendItems(seamWithData.model.series)) : "");
  setHtml(
    "seam-charts",
    view.seams
      .map((seam) =>
        chartCardHtml({
          id: `seam-${seam.regionId}`,
          title: seam.name,
          height: CHART_HEIGHT.seam,
          placeholder: seam.model ? null : noValidation,
          context: "the 2012 seam",
        }),
      )
      .join(""),
  );
  let showRaw = true;
  const seamCharts = view.seams
    .filter((seam) => seam.model)
    .map((seam) => {
      const id = `seam-${seam.regionId}`;
      numbers(id, () => seamNumbersHtml(seam.model));
      return mount(id, (width) => seamOption(seam.model, { width, showRaw }));
    })
    .filter(Boolean);
  const rawToggle = byId("show-raw");
  rawToggle?.addEventListener("change", () => {
    showRaw = rawToggle.checked;
    const item = byId("seam-legend")?.querySelector?.('[data-key="viirs_raw"]');
    if (item) item.classList.toggle("off", !showRaw);
    for (const chart of seamCharts) chart.draw();
  });

  setHtml(
    "scorecard",
    view.scorecard ? scorecardHtml(view.scorecard) : '<p class="chart-empty">The validation results are not published yet.</p>',
  );

  if (view.detection) {
    const detection = view.detection;
    setHtml(
      "detection",
      legendHtml(detection.lines.map((line) => ({ key: line.landClass, label: line.label, style: line.style }))) +
        chartCardHtml({ id: "detection", title: "Chance that Aqua MODIS detects a fire VIIRS detects", height: CHART_HEIGHT.detection }),
    );
    numbers("detection", () => detectionNumbersHtml(detection));
    mount("detection", (width) => detectionOption(detection, { width }));
  } else {
    setHtml(
      "detection",
      `<p class="chart-empty">No detection model in data version ${escapeHtml(view.dataVersion ?? "")}: it uses ${escapeHtml(
        WEIGHT_METHOD_NAMES[view.shipped],
      )}, which gives every VIIRS hotspot in a region and calendar month the same weight.</p>`,
    );
  }

  setHtml(
    "k-table",
    view.k
      ? kTableHtml(view.k)
      : `<p class="chart-empty">${
          view.mock.metadata ? "There is no mock table: it appears once a data version is published." : "The table is not published in this data version."
        }</p>`,
  );

  setHtml("n20-scores", view.scorecard ? n20ScoresHtml(view.scorecard) : "");
  const n20WithData = view.n20.find((item) => item.model);
  setHtml("n20-legend", n20WithData ? legendHtml(lineLegendItems(n20WithData.model.series)) : "");
  setHtml(
    "n20-charts",
    view.n20
      .map((item) =>
        chartCardHtml({
          id: `n20-${item.regionId}`,
          title: item.name,
          height: CHART_HEIGHT.n20,
          placeholder: item.model ? null : noValidation,
          context: "NOAA-20 against S-NPP",
        }),
      )
      .join(""),
  );
  for (const item of view.n20) {
    if (!item.model) continue;
    const model = item.model;
    numbers(`n20-${item.regionId}`, () => n20NumbersHtml(model));
    mount(`n20-${item.regionId}`, (width) => n20Option(model, { width }));
  }

  const drift = view.scorecard ? driftText(view.scorecard) : "";
  setHtml("drift-numbers", drift ? ` ${escapeHtml(drift)}` : "");
  const attribution = byId("attribution");
  if (attribution) attribution.textContent = view.attribution;

  return { view, charts: [...mounted.values()] };
}

/**
 * Resolves once the window's load event has passed, so the DOM is parsed and ECharts has run.
 * @param {Document} doc
 */
const pageLoaded = (doc) =>
  !doc.readyState || doc.readyState === "complete"
    ? Promise.resolve()
    : new Promise((resolve) => doc.defaultView?.addEventListener("load", resolve, { once: true }));

/**
 * Fetches /api/method and draws the page, or explains what failed. method.html runs this module
 * before its defer script, so the request overlaps the ECharts download.
 * @param {Document} [doc]
 */
export async function startMethodPage(doc = document) {
  try {
    const response = await fetch("/api/method", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    const body = await response.json();
    await pageLoaded(doc);
    renderMethodPage(body, doc);
  } catch (error) {
    await pageLoaded(doc);
    const status = doc.getElementById("method-status");
    if (status) {
      status.innerHTML = `<p class="notice">The validation results did not load (${escapeHtml(error.message)}). Reload the page to try again; the text below still describes the method.</p>`;
    }
    for (const element of doc.querySelectorAll("[data-loading]")) element.textContent = "Not available: the results did not load.";
    console.error(error);
  }
}
