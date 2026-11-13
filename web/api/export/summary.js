import { handleSummaryExport } from "../../lib/server/exports.js";

/** @param {Request} request */
export const POST = (request) => handleSummaryExport(request);
