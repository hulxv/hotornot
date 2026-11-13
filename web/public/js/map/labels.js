// Basemap label rules: English names only, and Palestine labelled in place of Israel.
// The liberty style prints the local script under the Latin name; MapLibre shapes Arabic and
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

/**
 * Changes that make a style's labels English only and drop its own Israel and Palestine
 * country labels, which `palestineLabelLayer` replaces.
 * @param {any[]} layers the style's layers
 * @returns {{ id: string, textField: unknown, filter?: unknown }[]}
 */
export function labelPatches(layers) {
  const patches = [];
  for (const layer of layers) {
    if (layer.type !== "symbol" || !usesName(layer.layout?.["text-field"])) continue;
    const patch = { id: layer.id, textField: ENGLISH_NAME };
    if (isCountryLayer(layer)) {
      const keep = ["!", ["in", ENGLISH_NAME, ["literal", REPLACED_COUNTRY_NAMES]]];
      patch.filter = layer.filter ? ["all", layer.filter, keep] : keep;
    }
    patches.push(patch);
  }
  return patches;
}

/**
 * A label layer for Palestine styled like the style's smallest country labels, or null when the
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
    paint: { ...template.paint },
  };
  if (template.minzoom !== undefined) layer.minzoom = template.minzoom;
  if (template.maxzoom !== undefined) layer.maxzoom = template.maxzoom;
  return layer;
}
