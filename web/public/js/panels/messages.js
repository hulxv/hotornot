import { GRID_DEG, MAX_AOI_VERTICES, MAX_EXPORT_ROWS, MIN_COVERED_CELLS } from "../../shared/contracts.js";

/**
 * @typedef {import("../../shared/contracts.js").RegionMeta} RegionMeta
 * @typedef {import("../client-api.js").ApiError} ApiError
 * @typedef {{ title: string, detail?: string, regions?: Pick<RegionMeta, "id" | "name">[] }} Message
 */

const count = (n) => n.toLocaleString("en-US");

/**
 * Plain-language text for an API or network error. `regions` (for `outside_regions`) are the
 * regions the user can switch to, with their display names.
 * @param {Pick<ApiError, "code" | "message" | "regions" | "retryAfter"> & { status?: number }} error
 * @param {Pick<RegionMeta, "id" | "name">[]} regions from `/api/metadata`
 * @returns {Message}
 */
export function errorMessage(error, regions) {
  switch (error.code) {
    case "invalid_aoi":
      return {
        title: "This area can't be used.",
        detail: "Its outline crosses itself or isn't a closed shape. Clear it and draw it again, or type a box.",
      };
    case "too_many_vertices":
      return {
        title: `This area has more than ${count(MAX_AOI_VERTICES)} corners.`,
        detail: `Draw a simpler outline with at most ${count(MAX_AOI_VERTICES)} corners.`,
      };
    case "outside_regions": {
      const known = new Map(regions.map((region) => [region.id, region]));
      const listed = (error.regions?.length ? error.regions : regions.map((region) => region.id))
        .map((id) => known.get(id) ?? { id, name: id });
      return {
        title: "This area is outside the demo regions.",
        detail: `Data covers ${listed.length} regions: ${listed.map((region) => region.name).join("; ")}. Pick one, or draw inside one.`,
        regions: listed,
      };
    }
    case "too_small":
      return {
        title: "This area is too small.",
        detail:
          error.message ||
          `It needs at least ${MIN_COVERED_CELLS} grid cells with data; each cell is ${GRID_DEG}° (about 5.5 km) across. Draw a larger area.`,
      };
    case "bad_range":
      return {
        title: "These dates don't work.",
        detail: "The first year can't be after the last, and both must lie between 2000 and 2099. Pick the years again.",
      };
    case "too_many_rows":
      return {
        title: `This export has more than ${count(MAX_EXPORT_ROWS)} hotspots.`,
        detail: `${error.message || "Narrow the area or the years."} The monthly summary has no such limit.`,
      };
    case "data_unavailable": {
      const wait = error.retryAfter ? ` in ${error.retryAfter >= 120 ? `${Math.round(error.retryAfter / 60)} minutes` : `${error.retryAfter} seconds`}` : " in a minute";
      return { title: "The data can't be read right now.", detail: `This is on our side. Try again${wait}.` };
    }
    case "network":
      return { title: "The server can't be reached.", detail: "Check your connection, then try again." };
    default: {
      const where = error.status ? "on the server" : "in this page";
      const what = (error.message ?? "").trim().replace(/^./, (c) => c.toUpperCase()).replace(/([^.])$/, "$1.");
      return { title: `Something went wrong ${where}.`, detail: `Try again in a moment, or reload the page.${what ? ` ${what}` : ""}` };
    }
  }
}

/**
 * The warning shown when part of the area lies outside the region the calendar describes.
 * @param {number} clippedFraction
 * @param {string} regionName
 * @returns {string | null}
 */
export function clipWarning(clippedFraction, regionName) {
  if (!(clippedFraction > 0)) return null;
  const percent = clippedFraction < 0.01 ? "Less than 1%" : `${Math.round(clippedFraction * 100)}%`;
  return `${percent} of your area lies outside ${regionName} and is not counted. The calendar covers only the part inside the region.`;
}
