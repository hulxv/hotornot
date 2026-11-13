import { ERROR_STATUS } from "../../public/shared/contracts.js";

/** @typedef {import("../../public/shared/contracts.js").ErrorCode} ErrorCode */
/** @typedef {import("../../public/shared/contracts.js").RegionId} RegionId */

/**
 * @param {ErrorCode} code
 * @param {string} message
 * @param {RegionId[]} [regions]
 */
export function errorResponse(code, message, regions) {
  const error = regions ? { code, message, regions } : { code, message };
  return Response.json({ error }, { status: ERROR_STATUS[code] });
}

/**
 * Parses a JSON body and runs a `contracts.js` validator, answering with the CONTRACTS error
 * body when either fails.
 * @template T
 * @param {Request} request
 * @param {(body: unknown) => ({ ok: true, value: T } | { ok: false, code: ErrorCode, message: string })} validate
 * @returns {Promise<{ ok: true, value: T } | { ok: false, response: Response }>}
 */
export async function readBody(request, validate) {
  let body;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: errorResponse("invalid_aoi", "the body must be JSON with an aoi polygon") };
  }
  const result = validate(body);
  return result.ok ? result : { ok: false, response: errorResponse(result.code, result.message) };
}

/** @param {string} filename @param {BodyInit} body */
export function csvResponse(filename, body) {
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
