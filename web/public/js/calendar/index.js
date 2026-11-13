import { buildOption } from "./option.js";
import { CALENDAR_PALETTE } from "./palette.js";
import { buildCalendar } from "./transform.js";

export { CALENDAR_PALETTE } from "./palette.js";
export { VIEWS } from "./transform.js";

/**
 * @typedef {import("../../shared/contracts.js").CalendarResponse} CalendarResponse
 * @typedef {import("./transform.js").RenderOptions & { title?: string, subtitle?: string }} CalendarRenderOptions
 */

/**
 * The calendar heatmap in `container`, drawn with the vendored ECharts (global `echarts`). The
 * chart takes the container's width and sets the container's height to fit the rows.
 * @param {HTMLElement} container
 */
export function createCalendar(container) {
  const echarts = /** @type {any} */ (globalThis).echarts;
  if (!echarts) throw new Error("createCalendar needs ECharts: load /vendor/echarts.min.js before this module");
  const chart = echarts.init(container, null, { renderer: "canvas" });
  /** @type {{ model: import("./transform.js").CalendarModel, options: CalendarRenderOptions } | null} */
  let current = null;
  let drawnWidth = 0;

  function draw() {
    if (!current) return;
    drawnWidth = container.clientWidth;
    const { option, height } = buildOption(current.model, {
      width: drawnWidth || 800,
      title: current.options.title,
      subtitle: current.options.subtitle,
    });
    container.style.height = `${height}px`;
    chart.resize();
    chart.setOption(option, { notMerge: true });
  }

  const observer =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          if (container.clientWidth !== drawnWidth) draw();
        })
      : null;
  observer?.observe(container);

  return {
    /**
     * @param {CalendarResponse} response
     * @param {CalendarRenderOptions} [options] view "harmonized" (default), "anomaly" or "raw"
     */
    render(response, options = {}) {
      current = { model: buildCalendar(response, options), options };
      draw();
    },
    /** PNG data URL of the chart as drawn, title and legend included. */
    toPng() {
      if (!current) throw new Error("render a calendar before exporting it");
      return chart.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: CALENDAR_PALETTE.background });
    },
    dispose() {
      observer?.disconnect();
      chart.dispose();
    },
  };
}
