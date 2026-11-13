import { handleCurrentMonth } from "../lib/server/exports.js";

/** @param {Request} request */
export const POST = (request) => handleCurrentMonth(request);
