// Every color the calendar draws, in the light theme. The page's stylesheet (css/app.css) holds
// the same values, and the dark ones below, as CSS custom properties named in PALETTE_TOKENS;
// tests/e2e.test.js keeps the two in step. The checks in tests/calendar.test.js (WCAG contrast,
// Machado 2009 color-vision simulation) run on this object.
export const CALENDAR_PALETTE = Object.freeze({
  background: "#ffffff",
  text: "#1a1a1a",
  muted: "#555555",
  font: '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  /** viridis at 0, 0.1, ..., 1 (matplotlib), low to high */
  sequential: Object.freeze([
    "#440154",
    "#482475",
    "#414487",
    "#355f8d",
    "#2a788e",
    "#21918c",
    "#22a884",
    "#44bf70",
    "#7ad151",
    "#bddf26",
    "#fde725",
  ]),
  /** ColorBrewer RdBu blues, a neutral center for "same as the median", ColorBrewer PuOr oranges */
  diverging: Object.freeze([
    "#2166ac",
    "#4393c3",
    "#92c5de",
    "#d1e5f0",
    "#eeeeee",
    "#fee0b6",
    "#fdb863",
    "#e08214",
    "#b35806",
  ]),
  zero: "#d6d6d6",
  noData: Object.freeze({ fill: "#ffffff", stroke: "#8a8a8a" }),
  noHistory: Object.freeze({ fill: "#ffffff", stroke: "#8a8a8a" }),
  marksDark: "#000000",
  marksLight: "#ffffff",
  season: "#6b6b6b",
  hover: "#1a1a1a",
});

// The dark theme keeps viridis and the black or white marks. The anomaly ramp flips to a dark
// center (ColorBrewer Blues and PuOr oranges toward the ends), so months near the median recede
// into the background as they do in the light theme. The zero gray is dark for the same reason;
// grays from #5f5f5f to #bdbdbd come closer than 15 ΔE00 to viridis under deuteranopia or protanopia.
export const CALENDAR_PALETTE_DARK = Object.freeze({
  ...CALENDAR_PALETTE,
  background: "#17191e",
  text: "#ececec",
  muted: "#a6a8ad",
  diverging: Object.freeze(["#9ecae1", "#6baed6", "#4292c6", "#2c5f8a", "#2b2d33", "#7a4a12", "#b35806", "#e08214", "#fdb863"]),
  zero: "#3a3c40",
  noData: Object.freeze({ fill: "#17191e", stroke: "#8a8c91" }),
  noHistory: Object.freeze({ fill: "#17191e", stroke: "#8a8c91" }),
  season: "#9a9ca1",
  hover: "#ececec",
});

/** The CSS custom property behind each palette color; several colors share the page's tokens. */
export const PALETTE_TOKENS = Object.freeze({
  background: "--bg",
  text: "--fg",
  muted: "--muted",
  sequential: Object.freeze(CALENDAR_PALETTE.sequential.map((_, i) => `--cal-seq-${i}`)),
  diverging: Object.freeze(CALENDAR_PALETTE.diverging.map((_, i) => `--cal-div-${i}`)),
  zero: "--cal-zero",
  noData: Object.freeze({ fill: "--bg", stroke: "--cal-outline" }),
  noHistory: Object.freeze({ fill: "--bg", stroke: "--cal-outline" }),
  marksDark: "--cal-mark-dark",
  marksLight: "--cal-mark-light",
  season: "--cal-season",
  hover: "--fg",
});

/**
 * The palette from a computed style. A page without the calendar tokens (no `--cal-zero`) gets
 * CALENDAR_PALETTE whole, so a half-themed page never mixes the two themes.
 * @param {{ getPropertyValue(name: string): string } | null | undefined} style
 * @returns {typeof CALENDAR_PALETTE}
 */
export function paletteFromStyle(style) {
  if (!style || !style.getPropertyValue(PALETTE_TOKENS.zero).trim()) return CALENDAR_PALETTE;
  const read = (token, fallback) => {
    if (typeof token !== "string") {
      const entries = Object.entries(token).map(([key, value]) => [key, read(value, fallback[key])]);
      return Object.freeze(Array.isArray(token) ? entries.map(([, value]) => value) : Object.fromEntries(entries));
    }
    return style.getPropertyValue(token).trim() || fallback;
  };
  return Object.freeze({ ...CALENDAR_PALETTE, ...read(PALETTE_TOKENS, CALENDAR_PALETTE) });
}
