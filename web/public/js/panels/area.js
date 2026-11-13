import { pickRegion, snap, validateAoi } from "../../shared/aoi.js";
import { COLS, cellsInBbox } from "../../shared/grid.js";
import { h, skeleton } from "./dom.js";
import { clipWarning } from "./messages.js";

/**
 * @typedef {import("../../shared/contracts.js").Aoi} Aoi
 * @typedef {import("../../shared/contracts.js").RegionMeta} RegionMeta
 * @typedef {import("../../shared/contracts.js").CalendarResponse} CalendarResponse
 * @typedef {import("./messages.js").Message} Message
 */

// The API never sends region_cells, so the browser rebuilds them from the bbox. Only n_argentina
// has uncovered cells: those centered in Bolivia or Brazil, from the Natural Earth borders in the
// pipeline database, as [row, first col, last col] (W06's list). P10 publishes the same set with
// covered = 0; the side panel always shows the API's counts.
const UNCOVERED_RUNS = {
  n_argentina: [
    [1194, 2451, 2455], [1195, 2448, 2456], [1196, 2448, 2456], [1197, 2449, 2458], [1198, 2451, 2459],
    [1199, 2452, 2459], [1200, 2453, 2459], [1201, 2454, 2459], [1202, 2454, 2459], [1203, 2455, 2459],
    [1204, 2456, 2459], [1205, 2458, 2459], [1206, 2459, 2459], [1343, 2313, 2313], [1344, 2313, 2313],
    [1345, 2312, 2313], [1346, 2312, 2313], [1347, 2311, 2314], [1348, 2311, 2314], [1349, 2311, 2314],
    [1350, 2310, 2315], [1351, 2310, 2316], [1352, 2310, 2316], [1353, 2309, 2317], [1354, 2308, 2317],
    [1355, 2308, 2318], [1355, 2458, 2459], [1356, 2305, 2318], [1356, 2346, 2346], [1356, 2448, 2459],
    [1357, 2301, 2319], [1357, 2345, 2347], [1357, 2442, 2443], [1357, 2447, 2459], [1358, 2284, 2319],
    [1358, 2344, 2347], [1358, 2441, 2459], [1359, 2283, 2321], [1359, 2324, 2325], [1359, 2344, 2347],
    [1359, 2440, 2459],
  ],
};

/** @type {Map<string, { cell_id: number, covered: 0 | 1 }[]>} */
const regionCellsCache = new Map();

/**
 * The region's cells as `region_cells` rows, built in the browser.
 * @param {Pick<RegionMeta, "id" | "bbox">} region
 */
export function regionCells(region) {
  let rows = regionCellsCache.get(region.id);
  if (!rows) {
    const uncovered = new Set(
      (UNCOVERED_RUNS[region.id] ?? []).flatMap(([row, first, last]) =>
        Array.from({ length: last - first + 1 }, (_, i) => row * COLS + first + i),
      ),
    );
    rows = cellsInBbox(region.bbox).map((id) => ({ cell_id: id, covered: uncovered.has(id) ? 0 : 1 }));
    regionCellsCache.set(region.id, rows);
  }
  return rows;
}

/**
 * The cells the map draws for an area: counted (covered) and hatched (no data). Empty when the
 * area is invalid or outside every region; the API's answer explains why.
 * @param {Aoi} aoi
 * @param {Pick<RegionMeta, "id" | "name" | "bbox">[]} regions
 * @returns {{ regionId: string | null, counted: number[], uncovered: number[] }}
 */
export function snapForMap(aoi, regions) {
  const valid = validateAoi(aoi);
  const picked = valid.ok ? pickRegion(aoi, regions) : null;
  if (!picked?.ok) return { regionId: null, counted: [], uncovered: [] };
  const region = /** @type {RegionMeta} */ (picked.region);
  const { cells, coveredCells } = snap(aoi, regionCells(region), region.bbox);
  const covered = new Set(coveredCells);
  return { regionId: region.id, counted: coveredCells, uncovered: cells.filter((id) => !covered.has(id)) };
}

const count = (n) => n.toLocaleString("en-US");

/**
 * @param {CalendarResponse} response
 * @param {string} regionName
 * @param {boolean} preset whether the area is the region's whole box
 */
export function areaSummary(response, regionName, preset) {
  const { cells, covered_cells: covered, area_km2: area } = response.aoi;
  const what = preset ? `All of ${regionName}` : `Your area in ${regionName}`;
  const uncovered = cells - covered;
  const cellText = `${count(covered)} grid cell${covered === 1 ? "" : "s"} counted` + (uncovered > 0 ? `, ${count(uncovered)} without data` : "");
  return `${what}: ${cellText}, ${count(Math.round(area))} km².`;
}

/**
 * @param {{ summary: HTMLElement, warning: HTMLElement, message: HTMLElement }} elements
 * @param {{ status: "loading" } | { status: "empty", text: string }
 *   | { status: "error", message: Message, onRegion?: (id: string) => void }
 *   | { status: "ready", response: CalendarResponse, regionName: string, preset: boolean }} view
 */
export function renderArea({ summary, warning, message }, view) {
  summary.setAttribute("aria-busy", String(view.status === "loading"));
  const warningText = view.status === "ready" ? clipWarning(view.response.clipped_fraction, view.regionName) : null;
  warning.hidden = !warningText;
  warning.textContent = warningText ?? "";
  if (view.status !== "error") message.replaceChildren();
  message.hidden = view.status !== "error";

  if (view.status === "loading") summary.replaceChildren(skeleton(["90%", "55%"]));
  else if (view.status === "empty") summary.replaceChildren(h("span", { class: "muted", text: view.text }));
  else if (view.status === "ready") summary.replaceChildren(areaSummary(view.response, view.regionName, view.preset));
  else {
    summary.replaceChildren();
    const { title, detail, regions } = view.message;
    const onRegion = view.onRegion;
    const choices =
      regions?.length && onRegion
        ? h(
            "div",
            { class: "message__actions" },
            ...regions.map((region) => h("button", { type: "button", class: "button button--small", text: region.name, onclick: () => onRegion(region.id) })),
          )
        : null;
    message.replaceChildren(h("div", {}, h("p", { class: "message__title", text: title }), detail && h("p", { text: detail }), choices));
  }
}
