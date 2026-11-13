import { HOTSPOT_EXPORT_COLUMNS, exportFilename, validateExportRequest } from "../../public/shared/contracts.js";
import { csvTable } from "../../lib/csv.js";
import { csvResponse, readBody } from "../../lib/server/http.js";
import { mocks, resolveMockRegion } from "../../mocks/index.js";

export async function POST(request) {
  const body = await readBody(request, validateExportRequest);
  if (!body.ok) return body.response;
  const { aoi, start, end } = body.value;
  const region = resolveMockRegion(aoi);
  if (!region.ok) return region.response;
  const rows = mocks.hotspotsNile.filter((row) => {
    const month = row.acq_date.slice(0, 7);
    return month >= start && month <= end;
  });
  return csvResponse(exportFilename("hotspots", region.regionId, start, end), csvTable(HOTSPOT_EXPORT_COLUMNS, rows));
}
