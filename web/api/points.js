import { handlePoints } from "../lib/server/points.js";

/** @param {Request} request */
export const POST = (request) => handlePoints(request);
