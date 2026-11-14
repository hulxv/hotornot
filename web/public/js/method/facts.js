import { TIME } from "../../shared/contracts.js";

// The exact count from the v3 run's normalize report. The page shows it rounded with `roughly`,
// so a later refresh does not make the text wrong.
export const RUN_COUNTS = Object.freeze({ downloaded: 13_106_216 });

const grouped = new Intl.NumberFormat("en-US");

/** "13 million", "9.4 million", "510,000", "12,000": two significant digits. @param {number} n */
export function roughly(n) {
  if (n >= 1e6) {
    const millions = n / 1e6;
    return `${millions >= 10 ? Math.round(millions) : Number(millions.toPrecision(2))} million`;
  }
  if (n < 100) return String(Math.round(n));
  const unit = 10 ** (Math.floor(Math.log10(n)) - 1);
  return grouped.format(Math.round(n / unit) * unit);
}

/**
 * The satellites that carry the two cameras, and what each does for the record. Ends are
 * exclusive ISO dates; null means still flying.
 * @param {{ viirsSwitch?: string }} [options]
 */
export function satellites({ viirsSwitch = TIME.VIIRS_SWITCH } = {}) {
  return [
    {
      id: "terra",
      name: "Terra",
      camera: "MODIS",
      start: TIME.RECORD_START,
      end: null,
      role: "In our record until 2011. Since then it is the yardstick we test against.",
    },
    {
      id: "aqua",
      name: "Aqua",
      camera: "MODIS",
      start: TIME.AQUA_START,
      end: null,
      role: "In our record until 2011. It passes over at the same time of day as the VIIRS satellites, so it is the one we compare them with.",
    },
    {
      id: "snpp",
      name: "S-NPP",
      camera: "VIIRS",
      start: TIME.SNPP_START,
      end: viirsSwitch,
      role: "The main source of our record from 2012 until it stopped sending data.",
    },
    {
      id: "noaa20",
      name: "NOAA-20",
      camera: "VIIRS",
      start: TIME.N20_START,
      end: null,
      role: `Fills the days S-NPP missed, and carries the record on its own since ${viirsSwitch.slice(0, 4)}.`,
    },
  ];
}

/**
 * Which camera feeds the record in each period (the series sources by date).
 * @param {{ viirsSwitch?: string }} [options]
 */
export function recordPeriods({ viirsSwitch = TIME.VIIRS_SWITCH } = {}) {
  return [
    {
      id: "modis",
      name: "MODIS",
      camera: "MODIS",
      start: TIME.RECORD_START,
      end: `${TIME.CALIBRATION.start_year}-01-01`,
      role: "Fires seen by MODIS on Terra and Aqua, each counted as 1.",
    },
    {
      id: "snpp",
      name: "VIIRS on S-NPP",
      camera: "VIIRS",
      start: `${TIME.CALIBRATION.start_year}-01-01`,
      end: viirsSwitch,
      role: "Fires seen by VIIRS on S-NPP, each weighed in MODIS terms. NOAA-20 fills the days S-NPP missed.",
    },
    {
      id: "noaa20",
      name: "VIIRS on NOAA-20",
      camera: "VIIRS",
      start: viirsSwitch,
      end: null,
      role: "Fires seen by VIIRS on NOAA-20, weighed the same way.",
    },
  ];
}

// The toy picture of one 3 km patch of land. A camera flags a square when the fires inside it
// give off at least 10 MW for each km² of the square: about where MODIS's 1 km squares stop
// seeing fires (RFC, background), and the same heat per area for VIIRS's 375 m squares.
export const PATCH_KM = 3;
export const LIMIT_MW_PER_KM2 = 10;
export const CAMERAS = Object.freeze([
  Object.freeze({ id: "modis", name: "MODIS", pixelKm: 1, squares: "1 km squares" }),
  Object.freeze({ id: "viirs", name: "VIIRS", pixelKm: 0.375, squares: "375 m squares" }),
]);

// x and y in km from the patch's top-left corner, at VIIRS square centers. `share` is each
// fire's strength as a share of the strongest. The first three are one fire front inside one
// MODIS square.
export const PATCH_FIRES = Object.freeze(
  [
    { x: 0.1875, y: 0.5625, share: 0.4 },
    { x: 0.5625, y: 0.5625, share: 0.4 },
    { x: 0.5625, y: 0.1875, share: 0.4 },
    { x: 1.6875, y: 1.3125, share: 1 },
    { x: 2.4375, y: 2.4375, share: 0.5 },
    { x: 0.5625, y: 2.4375, share: 0.25 },
  ].map((fire) => Object.freeze(fire)),
);

