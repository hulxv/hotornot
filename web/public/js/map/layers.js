// The map's own sources and layers, and the plain style used when the basemap cannot load. Plain
// data with no MapLibre calls, so tests can validate them against the vendored MapLibre.
import { outsideRegionsMask, regionsToGeoJSON } from "./geometry.js";

/** @typedef {import("../../shared/contracts.js").RegionMeta} RegionMeta */

// For a dark basemap: light ink, lit region outlines, and everything outside the regions dimmed.
export const MAP_COLORS = Object.freeze({
  counted: "#5ee3d0",
  noDataFill: "#0a0d12",
  outside: "#05070a",
  ink: "#ffffff",
  paper: "#0a0d12",
  region: "#5ee3d0",
  land: "#45516e",
});

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
        paint: { "fill-color": MAP_COLORS.outside, "fill-opacity": 0.6, "fill-antialias": false },
      },
      { id: "hon-counted", type: "fill", source: "hon-counted", paint: { "fill-color": MAP_COLORS.counted, "fill-opacity": 0.35 } },
      { id: "hon-uncovered", type: "fill", source: "hon-uncovered", paint: { "fill-color": MAP_COLORS.noDataFill, "fill-opacity": 0.5 } },
      { id: "hon-uncovered-hatch", type: "fill", source: "hon-uncovered", paint: { "fill-pattern": HATCH_IMAGE } },
      {
        id: "hon-region-outline",
        type: "line",
        source: "hon-regions",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "line-color": MAP_COLORS.region, "line-width": 2 },
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
