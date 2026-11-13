// Fixtures from scripts/generate-mocks.js. The api/ handlers serve them until W04 and W05
// switch to published data.
import { yearMonthToYm } from "../public/shared/contracts.js";
import { errorResponse } from "../lib/server/http.js";
import aois from "./aoi.json" with { type: "json" };
import nileHarmonized from "./calendar-nile_delta-harmonized.json" with { type: "json" };
import nileRaw from "./calendar-nile_delta-raw.json" with { type: "json" };
import seHarmonized from "./calendar-se_australia-harmonized.json" with { type: "json" };
import currentMonth from "./current-month.json" with { type: "json" };
import detectionCurve from "./detection_curve.json" with { type: "json" };
import hotspotsNile from "./hotspots-nile_delta.json" with { type: "json" };
import metadata from "./metadata.json" with { type: "json" };
import regionCellsNile from "./region_cells-nile_delta.json" with { type: "json" };
import validationNile from "./validation-nile_delta.json" with { type: "json" };
import validationSummary from "./validation_summary.json" with { type: "json" };

/** @typedef {import("../public/shared/contracts.js").Aoi} Aoi */
/** @typedef {import("../public/shared/contracts.js").RegionId} RegionId */
/** @typedef {import("../public/shared/contracts.js").Series} Series */
/** @typedef {import("../public/shared/contracts.js").CalendarResponse} CalendarResponse */

export const mocks = {
  metadata,
  calendars: {
    nile_delta: { harmonized: nileHarmonized, raw: nileRaw },
    se_australia: { harmonized: seHarmonized },
  },
  currentMonth,
  validationSummary,
  validationNile,
  detectionCurve,
  regionCellsNile,
  hotspotsNile,
  /** The AOIs the calendar mocks were built for. */
  aois,
};

/**
 * Largest overlap between the AOI's bbox and a region's bbox: a stand-in for the CONTRACTS
 * region rule.
 * @param {Aoi} aoi
 * @returns {RegionId | null}
 */
export function mockRegionFor(aoi) {
  const ring = aoi.coordinates[0];
  const lons = ring.map(([lon]) => lon);
  const lats = ring.map(([, lat]) => lat);
  const [west, south, east, north] = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  let best = null;
  let bestOverlap = 0;
  for (const region of metadata.regions) {
    const [rw, rs, re, rn] = region.bbox;
    const overlap =
      Math.max(0, Math.min(east, re) - Math.max(west, rw)) * Math.max(0, Math.min(north, rn) - Math.max(south, rs));
    if (overlap > bestOverlap) {
      best = region.id;
      bestOverlap = overlap;
    }
  }
  return best;
}

/**
 * @param {Aoi} aoi
 * @returns {{ ok: true, regionId: RegionId } | { ok: false, response: Response }}
 */
export function resolveMockRegion(aoi) {
  const regionId = mockRegionFor(aoi);
  if (regionId) return { ok: true, regionId };
  const names = metadata.regions.map((region) => region.name).join("; ");
  return {
    ok: false,
    response: errorResponse(
      "outside_regions",
      `The area lies outside every demo region. Available regions: ${names}.`,
      metadata.regions.map((region) => region.id),
    ),
  };
}

/**
 * Regions without a fixture for the series get the Nile Delta one, region_id included.
 * @param {RegionId} regionId
 * @param {Series} series
 * @param {string} start
 * @param {string} end
 * @returns {CalendarResponse}
 */
export function mockCalendar(regionId, series, start, end) {
  const calendar =
    regionId === "se_australia" && series === "harmonized" ? seHarmonized : mocks.calendars.nile_delta[series];
  const from = yearMonthToYm(start);
  const to = yearMonthToYm(end);
  return {
    ...calendar,
    months: calendar.months.filter((m) => m.year * 100 + m.month >= from && m.year * 100 + m.month <= to),
  };
}
