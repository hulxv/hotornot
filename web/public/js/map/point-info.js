// Plain-language description of one fire detection from /api/points, for the map's tooltip.
import { MONTH_LONG } from "../calendar/transform.js";

/**
 * @typedef {{
 *   satellites: readonly string[], points: number[], date: number[], time: number[],
 *   satellite: number[], frp: number[], weight: (number | null)[], night: number[],
 * }} PointsData the /api/points body
 */

const MODIS_SATELLITES = new Set(["Terra", "Aqua"]);

/** @param {number} value @param {string} positive @param {string} negative */
const hemisphere = (value, positive, negative) => `${Math.abs(value).toFixed(3)}° ${value >= 0 ? positive : negative}`;

/** "32.539° N, 114.938° W" @param {number} lon @param {number} lat */
export const formatPlace = (lon, lat) => `${hemisphere(lat, "N", "S")}, ${hemisphere(lon, "E", "W")}`;

/** "4 November 2026, 08:49 UTC" @param {number} date yyyymmdd @param {number} time hhmm */
export function formatWhen(date, time) {
  const year = Math.floor(date / 10000);
  const month = Math.floor(date / 100) % 100;
  const day = date % 100;
  const hhmm = String(time).padStart(4, "0");
  return `${day} ${MONTH_LONG[month - 1]} ${year}, ${hhmm.slice(0, 2)}:${hhmm.slice(2)} UTC`;
}

/**
 * How much the detection adds to the month's count. MODIS is the reference, so its detections
 * count 1; a VIIRS detection counts its weight in MODIS detections.
 * @param {number | null} weight
 * @param {string} satellite
 */
export function formatWeight(weight, satellite) {
  if (MODIS_SATELLITES.has(satellite)) return "Counts as 1 detection (MODIS is the reference)";
  if (weight === null) return null;
  if (weight < 0.001) return "Counts as less than 0.001 of a MODIS detection";
  const shown = String(Number(weight.toPrecision(2)));
  return weight < 1 ? `Counts as ${shown} of a MODIS detection` : `Counts as ${shown} MODIS detection${shown === "1" ? "" : "s"}`;
}

/**
 * @param {PointsData} data
 * @param {number} i
 * @returns {{ lon: number, lat: number, title: string, lines: string[] }}
 */
export function describePoint(data, i) {
  const lon = data.points[2 * i];
  const lat = data.points[2 * i + 1];
  const satellite = data.satellites[data.satellite[i]] ?? "Unknown satellite";
  const sensor = MODIS_SATELLITES.has(satellite) ? "MODIS" : "VIIRS";
  const weight = formatWeight(data.weight[i], satellite);
  return {
    lon,
    lat,
    title: formatWhen(data.date[i], data.time[i]),
    lines: [
      `${satellite} (${sensor}), ${data.night[i] ? "night" : "day"} pass`,
      `Fire power ${data.frp[i]} MW`,
      ...(weight ? [weight] : []),
      formatPlace(lon, lat),
    ],
  };
}

/**
 * A satellite-imagery view of the spot, from Google's documented Maps URLs.
 * @param {number} lon @param {number} lat
 */
export const satelliteViewUrl = (lon, lat) =>
  `https://www.google.com/maps/@?api=1&map_action=map&center=${lat},${lon}&zoom=15&basemap=satellite`;
