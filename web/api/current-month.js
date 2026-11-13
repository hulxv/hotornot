import { validateCurrentMonthRequest } from "../public/shared/contracts.js";
import { readBody } from "../lib/server/http.js";
import { mocks, resolveMockRegion } from "../mocks/index.js";

export async function POST(request) {
  const body = await readBody(request, validateCurrentMonthRequest);
  if (!body.ok) return body.response;
  const region = resolveMockRegion(body.value.aoi);
  if (!region.ok) return region.response;
  return Response.json(mocks.currentMonth);
}
