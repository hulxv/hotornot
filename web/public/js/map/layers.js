// The map's own sources and layers, and the plain style used when the basemap cannot load. Plain
// data with no MapLibre calls, so tests can validate them against the vendored MapLibre.
import { outsideRegionsMask, regionsToGeoJSON } from "./geometry.js";

/** @typedef {import("../../shared/contracts.js").RegionMeta} RegionMeta */

// For a dark basemap: white overlays, and everything outside the regions dimmed. Color on this
// page means HOT or NOT, so the map's own marks stay neutral.
export const MAP_COLORS = Object.freeze({
  counted: "#ffffff",
  noDataFill: "#0a0d12",
  outside: "#05070a",
  ink: "#ffffff",
  paper: "#0a0d12",
  region: "#ffffff",
  land: "#4f5d7c",
  water: "#0e1626",
});

/**
 * Paint changes for the basemap, by layer id: its land and water are two close shades of slate,
 * so the water is made much darker, borders brighter, and the near-white built-up areas toned
 * down to sit under light labels.
 */
const BASEMAP_PAINT = Object.freeze({
  background: { "background-color": MAP_COLORS.land },
  water: { "fill-color": MAP_COLORS.water },
  waterway: { "line-color": MAP_COLORS.water, "line-opacity": 1 },
  landuse_residential: { "fill-color": "#66759a" },
  boundary_state: { "line-color": "#8fa3bf", "line-opacity": 0.6 },
  "boundary_country_z0-4": { "line-color": "#d4e2f5", "line-opacity": 0.9 },
  "boundary_country_z5-": { "line-color": "#d4e2f5", "line-opacity": 0.9 },
});

/**
 * @param {{ id: string }[]} layers the style's layers
 * @returns {{ id: string, property: string, value: unknown }[]}
 */
export function basemapPaint(layers) {
  return layers.flatMap(({ id }) => Object.entries(BASEMAP_PAINT[id] ?? {}).map(([property, value]) => ({ id, property, value })));
}

// Two of the three fontstacks the basemap's glyph server provides. Without a glyph server
// (the offline style), MapLibre 5 draws the same text with the browser's own sans-serif.
const FONT = ["Noto Sans Regular"];
const BOLD_FONT = ["Noto Sans Bold"];

export const HATCH_IMAGE = "hon-no-data-hatch";
export const REGION_LABEL_LAYER = "hon-region-label";
export const EMPTY = { type: "FeatureCollection", features: [] };

// Below this zoom a box is too small to hold its name, so the name sits just above the box.
const LABEL_INSIDE_ZOOM = 4;

/** @param {Pick<RegionMeta, "id" | "name" | "bbox">[]} regions */
export function overlaySources(regions) {
  return {
    "hon-outside": { type: "geojson", data: outsideRegionsMask(regions) },
    "hon-regions": { type: "geojson", data: regionsToGeoJSON(regions) },
    "hon-counted": { type: "geojson", data: EMPTY },
    "hon-uncovered": { type: "geojson", data: EMPTY },
  };
}

/**
 * `underLabels` go below the basemap's first label layer, `overLabels` on top of everything.
 * @returns {{ underLabels: object[], overLabels: object[] }}
 */
export function overlayLayers() {
  const halo = { "text-color": MAP_COLORS.ink, "text-halo-color": MAP_COLORS.paper };
  return {
    underLabels: [
      {
        id: "hon-outside",
        type: "fill",
        source: "hon-outside",
        // Without antialiasing there is no seam where world copies meet; the outlines cover the box edges.
        paint: { "fill-color": MAP_COLORS.outside, "fill-opacity": 0.42, "fill-antialias": false },
      },
      { id: "hon-counted", type: "fill", source: "hon-counted", paint: { "fill-color": MAP_COLORS.counted, "fill-opacity": 0.16 } },
      { id: "hon-uncovered", type: "fill", source: "hon-uncovered", paint: { "fill-color": MAP_COLORS.noDataFill, "fill-opacity": 0.5 } },
      { id: "hon-uncovered-hatch", type: "fill", source: "hon-uncovered", paint: { "fill-pattern": HATCH_IMAGE } },
      {
        id: "hon-region-outline",
        type: "line",
        source: "hon-regions",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "line-color": MAP_COLORS.region, "line-width": 2.5 },
      },
    ],
    overLabels: [
      {
        id: "hon-uncovered-label",
        type: "symbol",
        source: "hon-uncovered",
        minzoom: 6,
        layout: { "text-field": "no data", "text-font": FONT, "text-size": 12 },
        paint: { ...halo, "text-halo-width": 1.5 },
      },
      {
        id: REGION_LABEL_LAYER,
        type: "symbol",
        source: "hon-regions",
        filter: ["==", ["geometry-type"], "Point"],
        layout: {
          "text-field": ["get", "name"],
          "text-font": BOLD_FONT,
          "text-size": ["interpolate", ["linear"], ["zoom"], 1, 13, 4, 15, 8, 18],
          "text-max-width": 12,
          "text-anchor": ["step", ["zoom"], "bottom", LABEL_INSIDE_ZOOM, "top"],
          "text-offset": ["step", ["zoom"], ["literal", [0, -0.3]], LABEL_INSIDE_ZOOM, ["literal", [0, 0.6]]],
          "text-allow-overlap": true,
        },
        paint: { ...halo, "text-halo-width": 2 },
      },
    ],
  };
}

/** A plain land-colored background with no network resources, for when the basemap cannot load. */
export function fallbackStyle() {
  return {
    version: 8,
    name: "Hot or Not offline",
    sources: {},
    layers: [{ id: "hon-fallback-background", type: "background", paint: { "background-color": MAP_COLORS.land } }],
  };
}
