// Basemap label rules: English names only, Palestine labelled in place of Israel, and light
// text with a dark halo so names stay readable on the dark map.
// The OpenFreeMap styles print the local script under the Latin name; MapLibre shapes Arabic and
// Hebrew only with its separate RTL plugin, so those labels render as broken letters without it.

export const ENGLISH_NAME = ["coalesce", ["get", "name:en"], ["get", "name_en"], ["get", "name:latin"], ""];

const REPLACED_COUNTRY_NAMES = [
  "Israel",
  "Palestine",
  "State of Palestine",
  "Palestinian Territories",
  "Palestinian Territory",
];

export const PALESTINE_POINT = { type: "Point", coordinates: [35.0, 31.4] };

const usesName = (textField) => textField !== undefined && JSON.stringify(textField).includes('"name');

const isCountryLayer = (layer) =>
  layer["source-layer"] === "place" && JSON.stringify(layer.filter ?? null).includes('["==",["get","class"],"country"]');

const HALO = "#0e1626";
const LABEL_COLORS = { country: "#ffffff", water: "#9cc4f2", state: "#b9c7da", place: "#e3ebf5" };

/** @param {any} layer a name label layer of the basemap */
function labelPaint(layer) {
  const kind = isCountryLayer(layer)
    ? "country"
    : layer["source-layer"] === "water_name" || layer["source-layer"] === "waterway"
      ? "water"
      : JSON.stringify(layer.filter ?? null).includes('"state"')
        ? "state"
        : "place";
  return { "text-color": LABEL_COLORS[kind], "text-halo-color": HALO, "text-halo-width": 1.5, "text-halo-blur": 0 };
}

/**
 * Changes that make a style's labels English only and drop its own Israel and Palestine
 * country labels, which `palestineLabelLayer` replaces.
 * @param {any[]} layers the style's layers
 * @returns {{ id: string, textField: unknown, paint: Record<string, unknown>, filter?: unknown }[]}
 */
export function labelPatches(layers) {
  const patches = [];
  for (const layer of layers) {
    if (layer.type !== "symbol" || !usesName(layer.layout?.["text-field"])) continue;
    const patch = { id: layer.id, textField: ENGLISH_NAME, paint: labelPaint(layer) };
    if (isCountryLayer(layer)) {
      const keep = ["!", ["in", ENGLISH_NAME, ["literal", REPLACED_COUNTRY_NAMES]]];
      patch.filter = layer.filter ? ["all", layer.filter, keep] : keep;
    }
    patches.push(patch);
  }
  return patches;
}

/**
 * A label layer for Palestine sized like the style's smallest country labels, or null when the
 * style has no country labels (the offline fallback).
 * @param {any[]} layers the style's layers
 * @param {string} sourceId a GeoJSON source holding `PALESTINE_POINT`
 */
export function palestineLabelLayer(layers, sourceId) {
  const template = layers.find((layer) => layer.type === "symbol" && isCountryLayer(layer));
  if (!template) return null;
  const layer = {
    id: "hon-palestine-label",
    type: "symbol",
    source: sourceId,
    layout: { ...template.layout, "text-field": "Palestine" },
    paint: { ...template.paint, ...labelPaint(template) },
  };
  if (template.minzoom !== undefined) layer.minzoom = template.minzoom;
  if (template.maxzoom !== undefined) layer.maxzoom = template.maxzoom;
  return layer;
}
