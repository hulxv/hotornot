import { SUMMARY_EXPORT_COLUMNS, exportFilename, validateExportRequest } from "../../public/shared/contracts.js";
import { csvTable } from "../../lib/csv.js";
import { csvResponse, readBody } from "../../lib/server/http.js";
import { mockCalendar, resolveMockRegion } from "../../mocks/index.js";

export async function POST(request) {
  const body = await readBody(request, validateExportRequest);
  if (!body.ok) return body.response;
  const { aoi, start, end, series } = body.value;
  const region = resolveMockRegion(aoi);
  if (!region.ok) return region.response;
  const { months } = mockCalendar(region.regionId, series, start, end);
  return csvResponse(exportFilename("summary", region.regionId, start, end), csvTable(SUMMARY_EXPORT_COLUMNS, months));
}
