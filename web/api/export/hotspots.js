import { handleHotspotExport } from "../../lib/server/exports.js";

/** @param {Request} request */
export const POST = (request) => handleHotspotExport(request);
