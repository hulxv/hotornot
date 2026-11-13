import { METADATA_CACHE_CONTROL, MOCK_HEADERS, openPublished, readMetadata, withDataErrors } from "../lib/server/calendar.js";
import { mocks } from "../mocks/index.js";

export function GET() {
  return withDataErrors(async () => {
    const serving = await openPublished();
    if (!serving) return Response.json(mocks.metadata, { headers: { ...MOCK_HEADERS, "cache-control": "no-store" } });
    return Response.json(readMetadata(serving), { headers: { "cache-control": METADATA_CACHE_CONTROL } });
  });
}
