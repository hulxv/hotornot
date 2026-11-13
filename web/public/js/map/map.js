// Map panel: region presets, polygon drawing with terra-draw, a west/south/east/north box
// form and the snapped-cell overlay. Needs the vendored globals `maplibregl`, `terraDraw` and
// `terraDrawMaplibreGlAdapter`, loaded with classic <script> tags before this module runs.
import { cellPolygon } from "../../shared/grid.js";
import {
  BOX_FIELDS,
  hatchImage,
  parseCoordinate,
  polygonBbox,
  regionsToGeoJSON,
  snappedOverlay,
  validateBox,
} from "./geometry.js";

/**
 * @typedef {import("../../shared/contracts.js").Aoi} Aoi
 * @typedef {import("../../shared/contracts.js").RegionId} RegionId
 * @typedef {import("../../shared/contracts.js").RegionMeta} RegionMeta
 * @typedef {"draw" | "edit" | "box" | "clear"} AoiSource
 * @typedef {{
 *   regions: Pick<RegionMeta, "id" | "name" | "bbox">[],
 *   onAoiChange?: (polygon: Aoi | null, info: { source: AoiSource }) => void,
 *   onRegionSelect?: (regionId: RegionId) => void,
 *   style?: string | object,
 * }} MapOptions
 * @typedef {{
 *   setSnapped: (cellIds: Iterable<number>, uncoveredIds?: Iterable<number>) => Promise<void>,
 *   fitRegion: (regionId: RegionId) => void,
 *   clear: () => void,
 *   setAoi: (polygon: Aoi, options?: { fit?: boolean }) => Promise<void>,
 * }} MapHandle
 */

export const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

// One of the three fontstacks the liberty style's glyph server provides.
const FONT = ["Noto Sans Regular"];
const HATCH_IMAGE = "hon-no-data-hatch";
const EMPTY = { type: "FeatureCollection", features: [] };
const INITIAL_BOUNDS = [[-130, -45], [160, 50]];
const COORDINATE_DECIMALS = 6;

const COLORS = {
  counted: "#6d28d9",
  noDataFill: "#9ca3af",
  ink: "#111827",
  paper: "#ffffff",
  region: "#1f2937",
};

const FIELD_LABELS = {
  west: "West (longitude)",
  south: "South (latitude)",
  east: "East (longitude)",
  north: "North (latitude)",
};

const MESSAGES = {
  drawing:
    "Drawing: click the map to add corners. Click the first or last corner, or press Enter, to finish. Escape cancels.",
  drawn: "Area set. Drag a corner to move it, drag a midpoint to add a corner, or draw a new area.",
  edited: "Area updated.",
  cancelled: "Drawing cancelled.",
  cleared: "Area cleared.",
};

let instanceCount = 0;

function ensureStylesheet() {
  if (document.querySelector("link[data-hon-map]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./map.css", import.meta.url).href;
  link.dataset.honMap = "";
  document.head.append(link);
}

/**
 * @param {string} tag
 * @param {Record<string, string | boolean | undefined>} [attributes] `text` sets textContent
 * @param {(Node | string)[]} children
 */
function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (name === "text") node.textContent = String(value);
    else node.setAttribute(name, value === true ? "" : String(value));
  }
  node.append(...children);
  return node;
}

/**
 * @param {HTMLElement} container
 * @param {MapOptions["regions"]} regions
 * @param {string} prefix unique id prefix
 */
function buildPanel(container, regions, prefix) {
  const presets = regions.map((region) =>
    el("button", { type: "button", class: "hon-map__button", "data-region": region.id, text: region.name }),
  );
  const drawButton = el("button", { type: "button", class: "hon-map__button", "aria-pressed": "false", text: "Draw area" });
  const clearButton = el("button", { type: "button", class: "hon-map__button", text: "Clear area" });

  /** @type {Record<string, HTMLInputElement>} */
  const inputs = {};
  /** @type {Record<string, HTMLElement>} */
  const errors = {};
  const fields = BOX_FIELDS.map((field) => {
    const id = `${prefix}-${field}`;
    errors[field] = el("span", { id: `${id}-error`, class: "hon-map__error" });
    inputs[field] = /** @type {HTMLInputElement} */ (
      el("input", {
        id,
        name: field,
        type: "text",
        class: "hon-map__input",
        autocomplete: "off",
        spellcheck: "false",
        "aria-describedby": `${id}-error`,
      })
    );
    return el("div", { class: "hon-map__field" }, el("label", { for: id, text: FIELD_LABELS[field] }), inputs[field], errors[field]);
  });
  errors.form = el("p", { id: `${prefix}-form-error`, class: "hon-map__error", role: "alert" });
  const hintId = `${prefix}-box-hint`;
  const form = /** @type {HTMLFormElement} */ (
    el(
      "form",
      { class: "hon-map__form", novalidate: true, "aria-describedby": hintId },
      el("p", {
        id: hintId,
        class: "hon-map__hint",
        text: "Decimal degrees. Southern latitudes and western longitudes are negative.",
      }),
      el("div", { class: "hon-map__fields" }, ...fields),
      errors.form,
      el("button", { type: "submit", class: "hon-map__button", text: "Use this box" }),
    )
  );

  const presetLabel = `${prefix}-presets`;
  const drawLabel = `${prefix}-draw`;
  const tools = el(
    "div",
    { class: "hon-map__tools" },
    el(
      "div",
      { class: "hon-map__group", role: "group", "aria-labelledby": presetLabel },
      el("span", { id: presetLabel, class: "hon-map__group-label", text: "Zoom to a demo region:" }),
      ...presets,
    ),
    el(
      "div",
      { class: "hon-map__group", role: "group", "aria-labelledby": drawLabel },
      el("span", { id: drawLabel, class: "hon-map__group-label", text: "Your area:" }),
      drawButton,
      clearButton,
    ),
    el("details", { class: "hon-map__box" }, el("summary", { text: "Type a latitude and longitude box" }), form),
  );

  const status = el("p", { class: "hon-map__status", role: "status" });
  const canvas = el("div", { class: "hon-map__canvas" });
  const countedCount = el("span", { class: "hon-map__count" });
  const uncoveredCount = el("span", { class: "hon-map__count" });
  const swatch = (kind) => el("span", { class: `hon-map__swatch hon-map__swatch--${kind}`, "aria-hidden": "true" });
  const legend = el(
    "ul",
    { class: "hon-map__legend", "aria-label": "Map legend" },
    el("li", {}, swatch("aoi"), "Your area"),
    el("li", {}, swatch("counted"), "Counted cells", countedCount),
    el("li", {}, swatch("no-data"), "No data, not counted", uncoveredCount),
    el("li", {}, swatch("region"), "Demo region"),
  );

  container.classList.add("hon-map");
  container.append(tools, status, canvas, legend);
  return { presets, drawButton, clearButton, form, inputs, errors, status, canvas, countedCount, uncoveredCount };
}

/** @param {Aoi} polygon */
function roundedPolygon(polygon) {
  const scale = 10 ** COORDINATE_DECIMALS;
  const round = (value) => Math.round(value * scale) / scale;
  return { type: "Polygon", coordinates: [polygon.coordinates[0].map(([lon, lat]) => [round(lon), round(lat)])] };
}

/**
 * @param {HTMLElement} container element the panel is built into; give it a height
 * @param {MapOptions} options
 * @returns {MapHandle}
 */
export function createMap(container, { regions, onAoiChange = () => {}, onRegionSelect = () => {}, style = BASEMAP_STYLE }) {
  const { maplibregl, terraDraw, terraDrawMaplibreGlAdapter } = /** @type {any} */ (globalThis);
  if (!maplibregl || !terraDraw?.TerraDraw || !terraDrawMaplibreGlAdapter) {
    throw new Error("createMap needs /vendor/maplibre-gl.js, terra-draw.umd.js and its MapLibre adapter loaded first");
  }
  ensureStylesheet();
  instanceCount += 1;
  const ui = buildPanel(container, regions, `hon-map-${instanceCount}`);
  const regionById = new Map(regions.map((region) => [region.id, region]));

  const map = new maplibregl.Map({
    container: ui.canvas,
    style,
    bounds: INITIAL_BOUNDS,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    attributionControl: { compact: true },
    locale: { "Map.Title": "Map. Arrow keys pan; plus and minus zoom." },
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

  const { TerraDraw, TerraDrawPolygonMode, TerraDrawSelectMode, ValidateNotSelfIntersecting } = terraDraw;
  const draw = new TerraDraw({
    adapter: new terraDrawMaplibreGlAdapter.TerraDrawMapLibreGLAdapter({ map, coordinatePrecision: COORDINATE_DECIMALS }),
    modes: [
      new TerraDrawSelectMode({
        flags: {
          polygon: {
            feature: { draggable: true, coordinates: { draggable: true, midpoints: true, deletable: true } },
          },
        },
        keyEvents: { deselect: "Escape", delete: null, rotate: null, scale: null },
        styles: {
          selectedPolygonColor: COLORS.ink,
          selectedPolygonFillOpacity: 0.05,
          selectedPolygonOutlineColor: COLORS.ink,
          selectedPolygonOutlineWidth: 3,
          selectionPointColor: COLORS.paper,
          selectionPointOutlineColor: COLORS.ink,
          selectionPointWidth: 5,
          selectionPointOutlineWidth: 2,
          midPointColor: COLORS.ink,
          midPointOutlineColor: COLORS.paper,
          midPointWidth: 3,
          midPointOutlineWidth: 1,
        },
      }),
      new TerraDrawPolygonMode({
        validation: (feature, { updateType }) =>
          updateType === "finish" || updateType === "commit" ? ValidateNotSelfIntersecting(feature) : { valid: true },
        styles: {
          fillColor: COLORS.ink,
          fillOpacity: 0.05,
          outlineColor: COLORS.ink,
          outlineWidth: 2,
          closingPointColor: COLORS.paper,
          closingPointOutlineColor: COLORS.ink,
          closingPointWidth: 5,
          closingPointOutlineWidth: 2,
        },
      }),
    ],
  });

  /** @type {string | number | null} terra-draw id of the one area on the map */
  let aoiId = null;
  let drawing = false;
  let snapCall = 0;

  const loaded = new Promise((resolve) => map.once("load", resolve)).then(() => {
    addLayers();
    draw.start();
    draw.setMode("select");
  });

  function addLayers() {
    const firstLabel = map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
    map.addImage(HATCH_IMAGE, hatchImage(), { pixelRatio: 2 });
    map.addSource("hon-regions", { type: "geojson", data: regionsToGeoJSON(regions) });
    map.addSource("hon-counted", { type: "geojson", data: EMPTY });
    map.addSource("hon-uncovered", { type: "geojson", data: EMPTY });
    map.addLayer(
      { id: "hon-counted", type: "fill", source: "hon-counted", paint: { "fill-color": COLORS.counted, "fill-opacity": 0.4 } },
      firstLabel,
    );
    map.addLayer(
      {
        id: "hon-uncovered",
        type: "fill",
        source: "hon-uncovered",
        paint: { "fill-color": COLORS.noDataFill, "fill-opacity": 0.35 },
      },
      firstLabel,
    );
    map.addLayer(
      { id: "hon-uncovered-hatch", type: "fill", source: "hon-uncovered", paint: { "fill-pattern": HATCH_IMAGE } },
      firstLabel,
    );
    map.addLayer(
      {
        id: "hon-region-outline",
        type: "line",
        source: "hon-regions",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "line-color": COLORS.region, "line-width": 1.5, "line-dasharray": [4, 2] },
      },
      firstLabel,
    );
    const halo = { "text-color": COLORS.ink, "text-halo-color": COLORS.paper, "text-halo-width": 1.5 };
    map.addLayer({
      id: "hon-uncovered-label",
      type: "symbol",
      source: "hon-uncovered",
      minzoom: 6,
      layout: { "text-field": "no data", "text-font": FONT, "text-size": 12 },
      paint: halo,
    });
    map.addLayer({
      id: "hon-region-label",
      type: "symbol",
      source: "hon-regions",
      filter: ["==", ["geometry-type"], "Point"],
      layout: {
        "text-field": ["get", "name"],
        "text-font": FONT,
        "text-size": 13,
        "text-anchor": "bottom-left",
        "text-offset": [0.2, -0.2],
      },
      paint: halo,
    });
  }

  const announce = (message) => {
    ui.status.textContent = message;
  };

  /** @param {AoiSource} source */
  function emit(source) {
    const feature = aoiId === null ? undefined : draw.getSnapshotFeature(aoiId);
    const polygon = feature ? { type: "Polygon", coordinates: feature.geometry.coordinates } : null;
    onAoiChange(/** @type {Aoi | null} */ (polygon), { source });
  }

  function setDrawing(on) {
    drawing = on;
    ui.drawButton.setAttribute("aria-pressed", String(on));
    draw.setMode(on ? "polygon" : "select");
  }

  async function startDrawing() {
    await loaded;
    setDrawing(true);
    map.getCanvas().focus();
    announce(MESSAGES.drawing);
  }

  function cancelDrawing() {
    setDrawing(false);
    announce(MESSAGES.cancelled);
  }

  /** @param {string | number} id */
  function replaceAoi(id) {
    if (aoiId !== null && aoiId !== id && draw.hasFeature(aoiId)) draw.removeFeatures([aoiId]);
    aoiId = id;
  }

  function resetOverlay() {
    snapCall += 1;
    map.getSource("hon-counted")?.setData(EMPTY);
    map.getSource("hon-uncovered")?.setData(EMPTY);
    ui.countedCount.textContent = "";
    ui.uncoveredCount.textContent = "";
  }

  function removeAoi() {
    if (drawing) setDrawing(false);
    if (draw.enabled) draw.clear();
    aoiId = null;
    resetOverlay();
  }

  /** @param {import("./geometry.js").BoxErrors} errors */
  function showBoxErrors(errors) {
    for (const field of BOX_FIELDS) {
      ui.errors[field].textContent = errors[field] ?? "";
      if (errors[field]) ui.inputs[field].setAttribute("aria-invalid", "true");
      else ui.inputs[field].removeAttribute("aria-invalid");
    }
    ui.errors.form.textContent = errors.form ?? "";
  }

  /**
   * @param {Aoi} polygon
   * @param {boolean} fit
   */
  async function placeAoi(polygon, fit) {
    await loaded;
    if (drawing) setDrawing(false);
    const [result] = draw.addFeatures([
      { type: "Feature", geometry: roundedPolygon(polygon), properties: { mode: "polygon" } },
    ]);
    if (!result.valid) throw new Error(`the map rejected the area: ${result.reason}`);
    replaceAoi(result.id);
    if (fit) {
      const [west, south, east, north] = polygonBbox(polygon);
      map.fitBounds([[west, south], [east, north]], { padding: 48, maxZoom: 11 });
    }
  }

  draw.on("finish", (id, context) => {
    if (context.mode === "polygon") {
      // terra-draw is still inside the polygon mode's close(); change modes once it returns.
      setTimeout(() => {
        replaceAoi(id);
        setDrawing(false);
        draw.selectFeature(id);
        announce(MESSAGES.drawn);
        emit("draw");
      }, 0);
    } else if (context.mode === "select" && id === aoiId) {
      announce(MESSAGES.edited);
      emit("edit");
    }
  });

  for (const button of ui.presets) {
    button.addEventListener("click", () => {
      const regionId = /** @type {RegionId} */ (button.dataset.region);
      fitRegion(regionId);
      announce(`Zoomed to ${regionById.get(regionId).name}.`);
      onRegionSelect(regionId);
    });
  }

  ui.drawButton.addEventListener("click", () => {
    if (drawing) cancelDrawing();
    else startDrawing();
  });

  ui.clearButton.addEventListener("click", () => {
    removeAoi();
    showBoxErrors({});
    announce(MESSAGES.cleared);
    emit("clear");
  });

  container.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && drawing) cancelDrawing();
  });

  ui.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = Object.fromEntries(BOX_FIELDS.map((field) => [field, ui.inputs[field].value]));
    const result = validateBox(/** @type {import("./geometry.js").BoxInput} */ (input), regions);
    if (!result.ok) {
      showBoxErrors(result.errors);
      const firstInvalid = BOX_FIELDS.find((field) => result.errors[field]) ?? BOX_FIELDS[0];
      ui.inputs[firstInvalid].focus();
      return;
    }
    showBoxErrors({});
    await placeAoi(result.polygon, true);
    const [west, south, east, north] = result.bbox;
    announce(`Area set to the box from ${west} to ${east} longitude and ${south} to ${north} latitude.`);
    emit("box");
  });

  for (const field of BOX_FIELDS) {
    const input = ui.inputs[field];
    input.addEventListener("input", () => {
      if (!input.hasAttribute("aria-invalid")) return;
      input.removeAttribute("aria-invalid");
      ui.errors[field].textContent = "";
    });
    input.addEventListener("change", () => {
      if (input.value.trim() === "") return;
      const parsed = parseCoordinate(input.value, field);
      ui.errors[field].textContent = parsed.ok ? "" : parsed.error;
      if (parsed.ok) input.removeAttribute("aria-invalid");
      else input.setAttribute("aria-invalid", "true");
    });
  }

  /** @param {RegionId} regionId */
  function fitRegion(regionId) {
    const region = regionById.get(regionId);
    if (!region) throw new RangeError(`unknown region: ${regionId}`);
    const [west, south, east, north] = region.bbox;
    map.fitBounds([[west, south], [east, north]], { padding: 32 });
  }

  /**
   * Draws the cells that count and, hatched, the snapped cells with no data. A cell in both
   * lists is drawn as no data. Calls made before the map loads wait for it; a newer call wins.
   * @param {Iterable<number>} cellIds
   * @param {Iterable<number>} [uncoveredIds]
   */
  async function setSnapped(cellIds, uncoveredIds = []) {
    const counted = [...cellIds];
    const uncovered = [...uncoveredIds];
    const call = ++snapCall;
    await loaded;
    if (call !== snapCall) return;
    const overlay = snappedOverlay(counted, uncovered, cellPolygon);
    map.getSource("hon-counted").setData(overlay.counted);
    map.getSource("hon-uncovered").setData(overlay.uncovered);
    ui.countedCount.textContent = ` (${overlay.countedCells.toLocaleString("en-US")})`;
    ui.uncoveredCount.textContent = ` (${overlay.uncoveredCells.toLocaleString("en-US")})`;
  }

  /** Removes the area and the overlay without calling onAoiChange. */
  function clear() {
    removeAoi();
    showBoxErrors({});
  }

  /**
   * Shows `polygon` as the editable area, for example one restored from the URL, without
   * calling onAoiChange. Coordinates are rounded to 6 decimals.
   * @param {Aoi} polygon
   * @param {{ fit?: boolean }} [options]
   */
  async function setAoi(polygon, { fit = true } = {}) {
    resetOverlay();
    await placeAoi(polygon, fit);
  }

  return { setSnapped, fitRegion, clear, setAoi };
}
