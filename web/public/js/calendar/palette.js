// Every color the calendar draws. W08 replaces these with the app-wide tokens; the checks in
// tests/calendar.test.js (WCAG contrast, Machado 2009 color-vision simulation) run on whatever
// this object holds.
export const CALENDAR_PALETTE = Object.freeze({
  background: "#ffffff",
  text: "#1a1a1a",
  muted: "#555555",
  font: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
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
