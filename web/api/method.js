import { DataError } from "../lib/data/source.js";
import { openServing } from "../lib/data/serving.js";
import { checkMeta } from "../public/shared/contracts.js";
import { mocks } from "../mocks/index.js";

/**
 * @typedef {import("../public/shared/contracts.js").Metadata} Metadata
 * @typedef {import("../lib/data/source.js").DataSource} DataSource
 *
 * @typedef {object} MethodBody
 * @property {string | null} data_version null when no data version is published
 * @property {string | null} published_at
 * @property {Metadata["method"]} method
 * @property {{ id: string, name: string }[]} regions display order
 * @property {string} attribution
 * @property {string[]} mock meta keys answered from the W01 mocks instead of published data
 * @property {object | null} validation_summary
 * @property {Record<string, object | null>} validation by region id
 * @property {object | null} detection_curve
 * @property {object[] | null} k_table
 */

const MOCK_META = {
  metadata: mocks.metadata,
  validation_summary: mocks.validationSummary,
  "validation:nile_delta": mocks.validationNile,
  detection_curve: mocks.detectionCurve,
};

/**
 * A published meta value that passes its shape check in contracts.js. A malformed one is reported
 * and dropped rather than replaced by a mock, so a publish bug never hides behind mock numbers.
 * @param {import("../lib/data/serving.js").Serving} serving
 * @param {string} key
 */
function publishedMeta(serving, key) {
  let value;
  try {
    value = serving.getMeta(key);
  } catch (error) {
    console.warn(`/api/method: meta "${key}" in ${serving.version} is not JSON: ${error.message}`);
    return null;
  }
  if (value === undefined) return undefined;
  const problems = checkMeta(key, value);
  if (problems.length > 0) {
    console.warn(`/api/method: meta "${key}" in ${serving.version} fails its shape check: ${problems.slice(0, 3).join("; ")}`);
    return null;
  }
  return value;
}

/** @param {import("../lib/data/serving.js").Serving} serving @param {string} key */
function hasMeta(serving, key) {
  try {
    return serving.getMeta(key) !== undefined;
  } catch {
    return true;
  }
}

/**
 * The method page's data: the P08 and P09 artifacts and `k_table` from the published
 * `serving.meta`. Without a published version everything comes from the W01 mocks. With one,
 * the validation set (`validation_summary`, `validation:<region>`, `detection_curve`) falls back
 * to the mocks only while `validation_summary` is unpublished; once it is published, a missing
 * artifact is null, which is how a `ratio_v1`-only run looks. There is no `k_table` mock.
 * @param {DataSource} [source] defaults to the process-wide `DATA_BASE_URL` source
 * @returns {Promise<MethodBody>}
 */
export async function methodBody(source) {
  let serving = null;
  try {
    serving = await openServing(source);
  } catch (error) {
    if (!(error instanceof DataError)) throw error;
    if (error.code !== "missing_latest") console.warn(`/api/method: serving mocks, data unavailable: ${error.message}`);
  }

  /** @type {string[]} */
  const mock = [];
  /** @param {string} key @param {boolean} allowMock */
  const read = (key, allowMock) => {
    const value = serving ? publishedMeta(serving, key) : undefined;
    if (value !== undefined) return value;
    if (allowMock && key in MOCK_META) {
      mock.push(key);
      return MOCK_META[key];
    }
    return null;
  };

  /** @type {Metadata} */
  let metadata = read("metadata", true);
  if (!metadata) {
    mock.push("metadata");
    metadata = mocks.metadata;
  }
  const validationMocked = !serving || !hasMeta(serving, "validation_summary");
  const validation_summary = read("validation_summary", validationMocked);
  /** @type {Record<string, object | null>} */
  const validation = {};
  for (const region of metadata.regions) validation[region.id] = read(`validation:${region.id}`, validationMocked);
  const detection_curve = read("detection_curve", validationMocked);
  const k_table = read("k_table", false);

  return {
    data_version: serving ? serving.version : null,
    published_at: serving ? serving.dataset.publishedAt : null,
    method: metadata.method,
    regions: metadata.regions.map(({ id, name }) => ({ id, name })),
    attribution: metadata.attribution,
    mock,
    validation_summary,
    validation,
    detection_curve,
    k_table,
  };
}

export async function GET() {
  const body = await methodBody();
  return Response.json(body, {
    headers: { "cache-control": body.mock.length > 0 ? "no-store" : "public, max-age=600" },
  });
}
