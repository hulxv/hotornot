import { CALENDAR_PALETTE as P } from "../calendar/palette.js";

/**
 * @typedef {{ color: string, width: number, dash: number[] | null }} LineStyle
 * `dash` is an SVG/ECharts dash array in px; null is a solid line.
 */

const SOLID = null;
const DASHED = Object.freeze([6, 4]);
const DOTTED = Object.freeze([2, 3]);
const DASH_DOT = Object.freeze([8, 3, 2, 3]);

/** @returns {LineStyle} */
const line = (color, width, dash) => Object.freeze({ color, width, dash: dash && [...dash] });

// Colors come from the calendar's palette so the two pages read as one app. Lines that share a
// dash pattern are at least ΔE00 20 apart under normal, deutan and protan vision, and every
// line is at least 3:1 against the background (tests/method.test.js checks both).
export const METHOD_PALETTE = Object.freeze({
  background: P.background,
  text: P.text,
  muted: P.muted,
  font: P.font,
  grid: "#e2e2e2",
  sequential: P.sequential,
  marksDark: P.marksDark,
  marksLight: P.marksLight,
  /** Alternating shades for the leave-two-years-out folds, and the 2020-2025 block. */
  foldShades: Object.freeze(["#f1f1f1", "#e2e2e2"]),
  blockShade: P.diverging[5],
  seam: Object.freeze({
    modis: line(P.text, 2, SOLID),
    viirs_raw: line(P.diverging[8], 1.5, SOLID),
    ratio: line(P.diverging[1], 2, DASHED),
    model: line(P.diverging[0], 2, SOLID),
  }),
  n20: Object.freeze({
    snpp: line(P.text, 2, SOLID),
    n20: line(P.diverging[0], 2, DASHED),
  }),
  detection: Object.freeze({
    all: line(P.text, 3, SOLID),
    cropland: line(P.diverging[8], 2, SOLID),
    savanna: line(P.diverging[0], 2, SOLID),
    forest: line(P.sequential[5], 2, DASHED),
    shrubland: line(P.sequential[0], 2, DASHED),
    grassland: line(P.diverging[1], 2, DOTTED),
    other: line(P.muted, 2, DOTTED),
    wetland: line(P.sequential[3], 2, DASH_DOT),
    unknown: line(P.diverging[8], 2, DASH_DOT),
  }),
  /** For land classes outside the seven-class scheme, in order of appearance. */
  extraLines: Object.freeze([line(P.diverging[8], 2, DASHED), line(P.diverging[8], 2, DOTTED), line(P.text, 2, DASH_DOT)]),
});
