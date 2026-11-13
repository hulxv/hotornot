import { buildOption } from "./option.js";
import { paletteFromStyle } from "./palette.js";
import { buildCalendar } from "./transform.js";

export { CALENDAR_PALETTE, CALENDAR_PALETTE_DARK, PALETTE_TOKENS, paletteFromStyle } from "./palette.js";
export { VIEWS } from "./transform.js";

/**
 * @typedef {import("../../shared/contracts.js").CalendarResponse} CalendarResponse
 * @typedef {import("./transform.js").RenderOptions & { title?: string, subtitle?: string }} CalendarRenderOptions
 */

/**
 * The calendar heatmap in `container`, drawn with the vendored ECharts (global `echarts`). The
 * chart takes the container's width and sets the container's height to fit the rows. Its colors
 * come from the page's CSS tokens (see palette.js), read at each draw, and it redraws when the
 * color scheme changes.
 * @param {HTMLElement} container
 */
export function createCalendar(container) {
  const echarts = /** @type {any} */ (globalThis).echarts;
  if (!echarts) throw new Error("createCalendar needs ECharts: load /vendor/echarts.min.js before this module");
  const chart = echarts.init(container, null, { renderer: "canvas" });
  /** @type {{ response: CalendarResponse, options: CalendarRenderOptions } | null} */
  let current = null;
  let drawnWidth = 0;
  let palette = paletteFromStyle(null);

  function draw() {
    if (!current) return;
    drawnWidth = container.clientWidth;
    palette = paletteFromStyle(globalThis.getComputedStyle?.(container));
    const { option, height } = buildOption(buildCalendar(current.response, current.options, palette), {
      width: drawnWidth || 800,
      title: current.options.title,
      subtitle: current.options.subtitle,
      palette,
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
  const scheme = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
  scheme?.addEventListener("change", draw);

  return {
    /**
     * @param {CalendarResponse} response
     * @param {CalendarRenderOptions} [options] view "harmonized" (default), "anomaly" or "raw"
     */
    render(response, options = {}) {
      // Throws on a bad view before the drawn calendar is replaced.
      buildCalendar(response, options);
      current = { response, options };
      draw();
    },
    /** PNG data URL of the chart as drawn, title and legend included. */
    toPng() {
      if (!current) throw new Error("render a calendar before exporting it");
      return chart.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: palette.background });
    },
    dispose() {
      observer?.disconnect();
      scheme?.removeEventListener("change", draw);
      chart.dispose();
    },
  };
}
