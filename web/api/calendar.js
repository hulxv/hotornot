import {
  MOCK_HEADERS,
  aoiErrorResponse,
  calendarResponseBody,
  openPublished,
  resolveAoi,
  validateCalendarBody,
  withDataErrors,
} from "../lib/server/calendar.js";
import { readBody } from "../lib/server/http.js";
import { mockCalendar, resolveMockRegion } from "../mocks/index.js";

export async function POST(request) {
  const body = await readBody(request, validateCalendarBody);
  if (!body.ok) return body.response;
  const { aoi, start, end, series } = body.value;
  return withDataErrors(async () => {
    const serving = await openPublished();
    if (!serving) {
      const region = resolveMockRegion(aoi);
      if (!region.ok) return region.response;
      return Response.json(mockCalendar(region.regionId, series, start, end), { headers: MOCK_HEADERS });
    }
    const resolved = resolveAoi(serving, aoi);
    if (!resolved.ok) return aoiErrorResponse(resolved);
    const { body: calendar, cached } = calendarResponseBody(serving, resolved, body.value);
    return Response.json(calendar, { headers: { "x-hotornot-cache": cached ? "hit" : "miss" } });
  });
}
