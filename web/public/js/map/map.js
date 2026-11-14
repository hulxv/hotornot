// Map panel: region presets, polygon drawing with terra-draw, a west/south/east/north box
// form and the snapped-cell overlay. Needs the vendored globals `maplibregl`, `terraDraw` and
// `terraDrawMaplibreGlAdapter`, loaded with classic <script> tags before this module runs.
import { pickRegion } from "../../shared/aoi.js";
import { cellPolygon } from "../../shared/grid.js";
import {
  BOX_FIELDS,
  hatchImage,
  parseCoordinate,
  polygonBbox,
  regionAt,
  regionsBounds,
  snappedOverlay,
  validateBox,
} from "./geometry.js";
import { PALESTINE_POINT, labelPatches, palestineLabelLayer } from "./labels.js";
import { EMPTY, HATCH_IMAGE, MAP_COLORS as COLORS, REGION_LABEL_LAYER, fallbackStyle, overlayLayers, overlaySources } from "./layers.js";

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
 *   startDrawing: () => Promise<void>,
 *   openBoxForm: (message?: string) => void,
 * }} MapHandle
 */

// OpenFreeMap's dark slate-blue style; it has the same layers and glyphs as liberty.
export const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/fiord";

const COORDINATE_DECIMALS = 6;
const REGION_PADDING = 48;
const OVERVIEW_PADDING = 24;
// Clicks this close to a box still pick it, so the small boxes of the world view are easy to hit.
const CLICK_SLOP_PX = 10;

const FIELD_LABELS = {
  west: "West (longitude)",
  south: "South (latitude)",
  east: "East (longitude)",
  north: "North (latitude)",
};

const MESSAGES = {
  drawing:
    "Drawing: click the map to add corners. Click the first or last corner, or press Enter, to finish. Escape cancels. " +
    "Using a keyboard? Press Escape, then type a box.",
  keyboard:
    "Drawing needs a mouse or touch screen, so the box form is open instead: type the west, south, east and north edges, then choose Use this box.",
  drawn: "Area set. Drag a corner to move it, drag a midpoint to add a corner, or draw a new area.",
  edited: "Area updated.",
  cancelled: "Drawing cancelled.",
  cleared: "Area cleared.",
  hint: "Click a highlighted region to pick it.",
  offline: "The base map is offline, so the regions are shown on a plain background. Click a highlighted region to pick it.",
  noData: "No data here. Pick one of the four highlighted regions.",
  overview: "Showing all four regions.",
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
  const drawHintId = `${prefix}-draw-hint`;
  const drawButton = el("button", {
    type: "button",
    class: "hon-map__button",
    "aria-pressed": "false",
    "aria-describedby": drawHintId,
    text: "Draw area",
  });
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

  const box = el("details", { class: "hon-map__box" }, el("summary", { text: "Type a latitude and longitude box" }), form);
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
      el("span", { id: drawHintId, class: "hon-map__sr-only", text: "Uses a mouse or touch screen. From the keyboard it opens the box form." }),
      clearButton,
    ),
    box,
  );

  const status = el("p", { class: "hon-map__status", role: "status", text: MESSAGES.hint });
  const overviewButton = el("button", { type: "button", class: "hon-map__overview", title: "Show all four regions", text: "All regions" });
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
    el("li", {}, swatch("outside"), "Outside the regions, no data"),
  );

  container.classList.add("hon-map");
  container.append(tools, status, canvas, legend);
  return { presets, drawButton, clearButton, box, form, inputs, errors, status, overviewButton, canvas, countedCount, uncoveredCount };
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
  const overview = regionsBounds(regions);

  const map = new maplibregl.Map({
    container: ui.canvas,
    style,
    bounds: overview,
    fitBoundsOptions: { padding: OVERVIEW_PADDING },
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    attributionControl: { compact: true },
    locale: { "Map.Title": "Map. Arrow keys pan; plus and minus zoom." },
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  const overviewControl = el("div", { class: "maplibregl-ctrl maplibregl-ctrl-group" }, ui.overviewButton);
  map.addControl({ onAdd: () => overviewControl, onRemove: () => overviewControl.remove() }, "top-right");
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
  let ready = false;
  let styleLoaded = false;
  let offline = false;
  let pointing = false;

  const loaded = new Promise((resolve) => map.once("load", resolve)).then(() => {
    addLayers();
    draw.start();
    draw.setMode("select");
    ready = true;
  });

  map.on("style.load", () => {
    styleLoaded = true;
  });
  // An error before the style has loaded means the basemap style itself failed (offline, or the
  // server is down). Errors after that (tiles, glyphs, sprites) leave a plain map, which is fine.
  map.on("error", (event) => {
    if (styleLoaded || offline) {
      console.error(event.error);
      return;
    }
    offline = true;
    console.warn("the base map could not load, so the map uses a plain background:", event.error);
    map.setStyle(fallbackStyle(), { diff: false });
    announce(MESSAGES.offline);
  });
  map.on("load", fitMinZoom);
  map.on("resize", fitMinZoom);
  map.on("click", onMapClick);
  map.on("mousemove", onMapHover);

  function addLayers() {
    const styleLayers = map.getStyle().layers;
    for (const { id, textField, filter } of labelPatches(styleLayers)) {
      map.setLayoutProperty(id, "text-field", textField);
      if (filter) map.setFilter(id, filter);
    }
    const palestine = palestineLabelLayer(styleLayers, "hon-palestine");
    if (palestine) {
      map.addSource("hon-palestine", { type: "geojson", data: PALESTINE_POINT });
      map.addLayer(palestine);
    }
    const firstLabel = styleLayers.find((layer) => layer.type === "symbol")?.id;
    map.addImage(HATCH_IMAGE, hatchImage({ color: [226, 232, 240, 200] }), { pixelRatio: 2 });
    for (const [id, source] of Object.entries(overlaySources(regions))) map.addSource(id, source);
    const { underLabels, overLabels } = overlayLayers();
    for (const layer of underLabels) map.addLayer(layer, firstLabel);
    for (const layer of overLabels) map.addLayer(layer);
  }

  /** Zooming out stops at the view that shows every region box. */
  function fitMinZoom() {
    const camera = map.cameraForBounds(overview, { padding: OVERVIEW_PADDING });
    if (camera) map.setMinZoom(camera.zoom);
  }

  /**
   * @param {string} message
   * @param {"notice"} [tone] a notice stands out until the next message
   */
  function announce(message, tone) {
    ui.status.textContent = message;
    if (tone) ui.status.setAttribute("data-tone", tone);
    else ui.status.removeAttribute("data-tone");
  }

  function clearNotice() {
    if (ui.status.getAttribute("data-tone") === "notice") announce(offline ? MESSAGES.offline : MESSAGES.hint);
  }

  /** @returns {RegionId | null} the region of the area on the map */
  function currentRegionId() {
    const feature = aoiId === null ? undefined : draw.getSnapshotFeature(aoiId);
    if (!feature) return null;
    const picked = pickRegion(feature.geometry, regions);
    return picked.ok ? /** @type {RegionId} */ (picked.region.id) : null;
  }

  /**
   * What a click at this point does: pick another region, zoom to the current one when it is
   * small on screen, nothing inside the current one (terra-draw edits the area there), or tell
   * the visitor there is no data.
   * @param {{ point: { x: number, y: number }, lngLat: { lng: number, lat: number } }} event
   * @returns {{ action: "select" | "zoom", regionId: RegionId } | { action: "none" | "outside" }}
   */
  function clickAction({ point, lngLat }) {
    const [label] = map.queryRenderedFeatures([point.x, point.y], { layers: [REGION_LABEL_LAYER] });
    // MapLibre's world is 512 px wide at zoom 0.
    const slop = (CLICK_SLOP_PX * 360) / (512 * 2 ** map.getZoom());
    const regionId = /** @type {RegionId | undefined} */ (label?.properties.id ?? regionAt([lngLat.lng, lngLat.lat], regions, slop)?.id);
    if (!regionId) return { action: "outside" };
    if (regionId !== currentRegionId()) return { action: "select", regionId };
    const [west, south, east, north] = regionById.get(regionId).bbox;
    const fitted = map.cameraForBounds([[west, south], [east, north]], { padding: REGION_PADDING });
    return fitted && map.getZoom() < fitted.zoom - 1 ? { action: "zoom", regionId } : { action: "none" };
  }

  function onMapClick(event) {
    if (!ready || drawing) return;
    const click = clickAction(event);
    if (click.action === "outside") announce(MESSAGES.noData, "notice");
    else if (click.action === "select") selectRegion(click.regionId);
    else if (click.action === "zoom") {
      fitRegion(click.regionId);
      announce(`Zoomed to ${regionById.get(click.regionId).name}.`);
    }
  }

  function onMapHover(event) {
    if (!ready || drawing) return;
    const action = clickAction(event).action;
    const pickable = action === "select" || action === "zoom";
    // terra-draw sets its own cursors over the area, so only undo a pointer this code set.
    if (pickable) map.getCanvas().style.cursor = "pointer";
    else if (pointing) map.getCanvas().style.cursor = "";
    pointing = pickable;
  }

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

  /** Drawing needs a pointer; keyboard users get the box form, opened and focused. */
  function openBoxForm(message = MESSAGES.keyboard) {
    ui.box.open = true;
    ui.inputs.west.focus();
    announce(message);
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
      map.fitBounds([[west, south], [east, north]], { padding: REGION_PADDING, maxZoom: 11 });
    }
  }

  /** @param {string | number} id */
  const outsideRegions = (id) => !pickRegion(draw.getSnapshotFeature(id).geometry, regions).ok;

  draw.on("finish", (id, context) => {
    if (context.mode === "polygon") {
      // terra-draw is still inside the polygon mode's close(); change modes once it returns.
      setTimeout(() => {
        if (outsideRegions(id)) {
          setDrawing(false);
          draw.removeFeatures([id]);
          announce(MESSAGES.noData, "notice");
          return;
        }
        replaceAoi(id);
        setDrawing(false);
        draw.selectFeature(id);
        announce(MESSAGES.drawn);
        emit("draw");
      }, 0);
    } else if (context.mode === "select" && id === aoiId) {
      if (outsideRegions(id)) announce(MESSAGES.noData, "notice");
      else announce(MESSAGES.edited);
      emit("edit");
    }
  });

  /** @param {RegionId} regionId */
  function selectRegion(regionId) {
    fitRegion(regionId);
    announce(`Zoomed to ${regionById.get(regionId).name}.`);
    onRegionSelect(regionId);
  }

  for (const button of ui.presets) {
    button.addEventListener("click", () => selectRegion(/** @type {RegionId} */ (button.getAttribute("data-region"))));
  }

  ui.overviewButton.addEventListener("click", () => {
    map.fitBounds(overview, { padding: OVERVIEW_PADDING });
    announce(MESSAGES.overview);
  });

  ui.drawButton.addEventListener("click", (event) => {
    if (drawing) cancelDrawing();
    // A click from Enter or Space, or from a screen reader, has detail 0; a mouse or touch click has 1 or more.
    else if (/** @type {MouseEvent} */ (event).detail === 0) openBoxForm();
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
    map.fitBounds([[west, south], [east, north]], { padding: REGION_PADDING });
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
    clearNotice();
    await placeAoi(polygon, fit);
  }

  return { setSnapped, fitRegion, clear, setAoi, startDrawing, openBoxForm };
}
