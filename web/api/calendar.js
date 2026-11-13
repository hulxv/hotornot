import { validateCalendarRequest } from "../public/shared/contracts.js";
import { readBody } from "../lib/server/http.js";
import { mockCalendar, resolveMockRegion } from "../mocks/index.js";

export async function POST(request) {
  const body = await readBody(request, validateCalendarRequest);
  if (!body.ok) return body.response;
  const { aoi, start, end, series } = body.value;
  const region = resolveMockRegion(aoi);
  if (!region.ok) return region.response;
  return Response.json(mockCalendar(region.regionId, series, start, end));
}
