// The API and published-data shapes, used by the browser and the server.

/**
 * @typedef {"nile_delta" | "california" | "se_australia" | "n_argentina"} RegionId
 * @typedef {"harmonized" | "raw"} Series
 * @typedef {"ratio_v1" | "model_v1"} WeightMethod
 * @typedef {"invalid_aoi" | "too_many_vertices" | "outside_regions" | "too_small" | "bad_range" | "too_many_rows" | "data_unavailable"} ErrorCode
 * @typedef {[number, number]} Position [lon, lat]
 * @typedef {{ type: "Polygon", coordinates: [Position[]] }} Aoi
 * @typedef {{ aoi: Aoi, start: string, end: string, series: Series }} CalendarRequest
 * @typedef {{ aoi: Aoi }} CurrentMonthRequest
 * @typedef {{ ok: false, code: ErrorCode, message: string }} Invalid
 * @typedef {{ error: { code: ErrorCode, message: string, regions?: RegionId[] } }} ApiError
 * @typedef {{ id: RegionId, name: string, bbox: [number, number, number, number],
 *   coverage: { start: string, sp_until: string, nrt_until: string } }} RegionMeta
 * @typedef {{ data_version: string, units: string, grid_deg: number, regions: RegionMeta[],
 *   method: { weight_method: WeightMethod, model_version: string | null, calibration_years: string,
 *   baseline: string, viirs_switch: string }, attribution: string }} Metadata
 * @typedef {{ year: number, month: number, value: number | null, modis_raw: number | null,
 *   viirs_raw: number | null, median: number | null, anomaly_log2: number | null,
 *   difference: number | null, rank: number | null, of_years: number | null, provisional: boolean,
 *   partial_coverage: boolean }} CalendarMonth
 * @typedef {{ region_id: RegionId, units: string, data_version: string, weight_method: WeightMethod,
 *   clipped_fraction: number, aoi: { cells: number, covered_cells: number, area_km2: number,
 *   snapped_fraction: number }, baseline: { start_year: number, end_year: number },
 *   fire_season: number[], months: CalendarMonth[] }} CalendarResponse
 * @typedef {{ year: number, month: number, days_covered: number, value: number, median: number,
 *   rank: number, of_years: number, provisional: boolean, partial_coverage: boolean,
 *   history?: { year: number, value: number }[] }} CurrentMonthResponse
 * @typedef {{ hotspot_id: string, satellite: string, sensor: string, acq_utc: string,
 *   acq_date: string, lat: number, lon: number, daynight: "D" | "N", frp_mw: number,
 *   confidence: string, fire_type: number | null, processing: "SP" | "NRT", in_series: boolean,
 *   weight: number | null, weight_method: WeightMethod, cell_id: number }} TileRow
 */

export const REGION_IDS = Object.freeze(["nile_delta", "california", "se_australia", "n_argentina"]);
export const SERIES = Object.freeze(["harmonized", "raw"]);
export const WEIGHT_METHODS = Object.freeze(["ratio_v1", "model_v1"]);
export const SATELLITES = Object.freeze(["Terra", "Aqua", "S-NPP", "NOAA-20"]);
export const UNITS = "modis_equivalent_hotspots";
export const GRID_DEG = 0.05;
export const MAX_AOI_VERTICES = 500;
export const MIN_COVERED_CELLS = 4;
export const MAX_EXPORT_ROWS = 1_000_000;

export const TIME = Object.freeze({
  RECORD_START: "2000-11-01",
  AQUA_START: "2002-07-04",
  BASELINE: Object.freeze({ start_year: 2003, end_year: 2025 }),
  CALIBRATION: Object.freeze({ start_year: 2012, end_year: 2019 }),
  SNPP_START: "2012-01-20",
  N20_START: "2018-04-01",
  VIIRS_SWITCH: "2026-11-02",
});

export const ERROR_CODES = Object.freeze([
  "invalid_aoi",
  "too_many_vertices",
  "outside_regions",
  "too_small",
  "bad_range",
  "too_many_rows",
  "data_unavailable",
]);

/** @type {Readonly<Record<ErrorCode, 400 | 422 | 503>>} */
export const ERROR_STATUS = Object.freeze({
  invalid_aoi: 422,
  too_many_vertices: 422,
  outside_regions: 422,
  too_small: 422,
  bad_range: 400,
  too_many_rows: 422,
  data_unavailable: 503,
});

export const TILE_COLUMNS = Object.freeze([
  "hotspot_id",
  "satellite",
  "sensor",
  "acq_utc",
  "acq_date",
  "lat",
  "lon",
  "daynight",
  "frp_mw",
  "confidence",
  "fire_type",
  "processing",
  "in_series",
  "weight",
  "weight_method",
  "cell_id",
]);
export const HOTSPOT_EXPORT_COLUMNS = Object.freeze(TILE_COLUMNS.filter((column) => column !== "cell_id"));

/**
 * @param {"hotspots" | "summary"} kind
 * @param {RegionId} regionId
 * @param {string} start YYYY-MM
 * @param {string} end YYYY-MM
 */
export function exportFilename(kind, regionId, start, end) {
  return `hotornot_${kind}_${regionId}_${start}_${end}.csv`;
}

/** @param {string} yearMonth YYYY-MM */
export function yearMonthToYm(yearMonth) {
  return Number(yearMonth.slice(0, 4)) * 100 + Number(yearMonth.slice(5, 7));
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isYearMonth = (value) => typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const isPosition = (p) =>
  Array.isArray(p) &&
  p.length === 2 &&
  Number.isFinite(p[0]) &&
  Number.isFinite(p[1]) &&
  Math.abs(p[0]) <= 180 &&
  Math.abs(p[1]) <= 90;

/** @returns {Invalid} */
const invalid = (code, message) => ({ ok: false, code, message });

/**
 * Structure and size only. Self-intersection and region checks belong to `shared/aoi.js`.
 * @returns {{ ok: true, value: Aoi } | Invalid}
 */
export function validateAoiShape(aoi) {
  if (!isObject(aoi) || aoi.type !== "Polygon") {
    return invalid("invalid_aoi", 'aoi must be a GeoJSON object with type "Polygon"');
  }
  const rings = aoi.coordinates;
  if (!Array.isArray(rings) || rings.length !== 1 || !Array.isArray(rings[0])) {
    return invalid("invalid_aoi", "aoi.coordinates must hold exactly one ring");
  }
  const ring = rings[0];
  if (ring.length - 1 > MAX_AOI_VERTICES) {
    return invalid("too_many_vertices", `the polygon has ${ring.length - 1} vertices; the limit is ${MAX_AOI_VERTICES}`);
  }
  if (ring.length < 4) return invalid("invalid_aoi", "a ring needs at least 4 positions");
  const bad = ring.findIndex((p) => !isPosition(p));
  if (bad >= 0) {
    return invalid("invalid_aoi", `aoi.coordinates[0][${bad}] must be [lon, lat] with lon in [-180, 180] and lat in [-90, 90]`);
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    return invalid("invalid_aoi", "the ring must be closed: its last position must equal its first");
  }
  return { ok: true, value: aoi };
}

/**
 * CONTRACTS has no code for a bad `series` or a body that is not an object; they map to
 * `bad_range` and `invalid_aoi`.
 * @returns {{ ok: true, value: CalendarRequest } | Invalid}
 */
export function validateCalendarRequest(body) {
  if (!isObject(body)) return invalid("invalid_aoi", "the body must be a JSON object with an aoi polygon");
  const aoi = validateAoiShape(body.aoi);
  if (!aoi.ok) return aoi;
  for (const key of ["start", "end"]) {
    if (!isYearMonth(body[key])) return invalid("bad_range", `${key} must be a month written YYYY-MM`);
  }
  if (body.start > body.end) return invalid("bad_range", "start must not be after end");
  if (!SERIES.includes(body.series)) return invalid("bad_range", 'series must be "harmonized" or "raw"');
  return { ok: true, value: { aoi: aoi.value, start: body.start, end: body.end, series: body.series } };
}

export const validateExportRequest = validateCalendarRequest;

/** A real calendar date written YYYY-MM-DD. */
const isIsoDate = (value) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** @param {string} yearMonth YYYY-MM */
const lastDayOf = (yearMonth) => {
  const [year, month] = yearMonth.split("-").map(Number);
  return `${yearMonth}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
};

/**
 * `POST /api/points`: an aoi and either `from` and `to` dates (YYYY-MM-DD) or the calendar's
 * `start` and `end` months, which mean their first and last days.
 * @returns {{ ok: true, value: { aoi: Aoi, from: string, to: string } } | Invalid}
 */
export function validatePointsRequest(body) {
  if (!isObject(body)) return invalid("invalid_aoi", "the body must be a JSON object with an aoi polygon");
  const aoi = validateAoiShape(body.aoi);
  if (!aoi.ok) return aoi;
  let from;
  let to;
  if (body.from !== undefined || body.to !== undefined) {
    for (const key of ["from", "to"]) {
      if (!isIsoDate(body[key])) return invalid("bad_range", `${key} must be a date written YYYY-MM-DD`);
    }
    ({ from, to } = body);
  } else {
    for (const key of ["start", "end"]) {
      if (!isYearMonth(body[key])) return invalid("bad_range", `${key} must be a month written YYYY-MM, or give from and to dates`);
    }
    from = `${body.start}-01`;
    to = lastDayOf(body.end);
  }
  if (from > to) return invalid("bad_range", "from must not be after to");
  if (from < "2000-01-01" || to > "2099-12-31") return invalid("bad_range", "dates must lie between 2000 and 2099");
  return { ok: true, value: { aoi: aoi.value, from, to } };
}

/**
 * `start`, `end` and `series` are accepted and ignored.
 * @returns {{ ok: true, value: CurrentMonthRequest } | Invalid}
 */
export function validateCurrentMonthRequest(body) {
  if (!isObject(body)) return invalid("invalid_aoi", "the body must be a JSON object with an aoi polygon");
  const aoi = validateAoiShape(body.aoi);
  return aoi.ok ? { ok: true, value: { aoi: aoi.value } } : aoi;
}

// Shape checks return a list of problems, each prefixed with its path; an empty list means valid.

/** @typedef {((value: unknown, path: string) => string[]) & { optional?: boolean }} Check */

const MAX_PROBLEMS = 20;
const problem = (path, message) => [`${path}: ${message}`];

/** @returns {Check} */
function number({ min = -Infinity, max = Infinity, integer = false, above } = {}) {
  return (value, path) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return problem(path, "expected a finite number");
    if (integer && !Number.isInteger(value)) return problem(path, "expected an integer");
    if (value < min || value > max) return problem(path, `expected a number in [${min}, ${max}]`);
    if (above !== undefined && !(value > above)) return problem(path, `expected a number above ${above}`);
    return [];
  };
}
const int = (options = {}) => number({ ...options, integer: true });

/** @returns {Check} */
function string(pattern, label) {
  return (value, path) =>
    typeof value === "string" && pattern.test(value) ? [] : problem(path, `expected ${label}`);
}

/** @returns {Check} */
function oneOf(values) {
  return (value, path) => (values.includes(value) ? [] : problem(path, `expected one of ${JSON.stringify(values)}`));
}

/** @type {Check} */
const boolean = (value, path) => (typeof value === "boolean" ? [] : problem(path, "expected true or false"));

/** @returns {Check} */
const nullable = (check) => (value, path) => (value === null ? [] : check(value, path));

/** @returns {Check} */
function optional(check) {
  const wrapped = (value, path) => (value === undefined ? [] : check(value, path));
  wrapped.optional = true;
  return wrapped;
}

/** @returns {Check} */
function array(check, { min = 0 } = {}) {
  return (value, path) => {
    if (!Array.isArray(value)) return problem(path, "expected an array");
    if (value.length < min) return problem(path, `expected at least ${min} items`);
    const problems = [];
    for (let i = 0; i < value.length && problems.length < MAX_PROBLEMS; i += 1) {
      problems.push(...check(value[i], `${path}[${i}]`));
    }
    return problems;
  };
}

/** @returns {Check} */
function tuple(checks) {
  return (value, path) =>
    Array.isArray(value) && value.length === checks.length
      ? checks.flatMap((check, i) => check(value[i], `${path}[${i}]`))
      : problem(path, `expected ${checks.length} items`);
}

/**
 * Unknown fields are problems: responses must match CONTRACTS exactly.
 * @param {Record<string, Check>} shape
 * @returns {Check}
 */
function object(shape) {
  return (value, path) => {
    if (!isObject(value)) return problem(path, "expected an object");
    const problems = [];
    for (const [key, check] of Object.entries(shape)) {
      if (!(key in value)) {
        if (!check.optional) problems.push(`${path}.${key}: missing`);
      } else {
        problems.push(...check(value[key], `${path}.${key}`));
      }
    }
    for (const key of Object.keys(value)) if (!(key in shape)) problems.push(`${path}.${key}: unexpected field`);
    return problems;
  };
}

/**
 * @param {Check} check
 * @param {(value: any) => string | null} rule
 * @returns {Check}
 */
function refine(check, rule) {
  return (value, path) => {
    const problems = check(value, path);
    if (problems.length > 0) return problems;
    const message = rule(value);
    return message ? problem(path, message) : [];
  };
}

const isRealDate = (text) => {
  const time = Date.parse(`${text.slice(0, 10)}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(text.slice(0, 10));
};

const lon = number({ min: -180, max: 180 });
const lat = number({ min: -90, max: 90 });
const month = int({ min: 1, max: 12 });
const count = int({ min: 0 });
const amount = number({ min: 0 });
const nonEmpty = string(/\S/, "a non-empty string");
const regionId = oneOf(REGION_IDS);
const weightMethod = oneOf(WEIGHT_METHODS);
const dataVersion = string(/^v\d+$/, "a version like v3");
const yearSpan = string(/^\d{4}-\d{4}$/, "YYYY-YYYY");
const cellId = int({ min: 0, max: 3600 * 7200 - 1 });
const ym = refine(int({ min: 100001 }), (v) => (v % 100 >= 1 && v % 100 <= 12 ? null : "expected year * 100 + month"));
const isoDate = refine(string(/^\d{4}-\d{2}-\d{2}$/, "a YYYY-MM-DD date"), (v) => (isRealDate(v) ? null : "not a real date"));
const isoDateTime = refine(
  string(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/, "an ISO 8601 time with a zone"),
  (v) => (isRealDate(v) && !Number.isNaN(Date.parse(v)) ? null : "not a real time"),
);
const bbox = refine(tuple([lon, lat, lon, lat]), ([west, south, east, north]) =>
  west < east && south < north ? null : "expected [west, south, east, north]",
);
const rankPair = (v) =>
  (v.rank === null ? v.of_years === null : v.of_years !== null && v.rank <= v.of_years)
    ? null
    : "rank and of_years must both be null, or 1 <= rank <= of_years";

const CALENDAR_MONTH_FIELDS = {
  year: int(),
  month,
  value: nullable(amount),
  modis_raw: nullable(count),
  viirs_raw: nullable(count),
  median: nullable(amount),
  anomaly_log2: nullable(number()),
  difference: nullable(number()),
  rank: nullable(int({ min: 1 })),
  of_years: nullable(int({ min: 1 })),
  provisional: boolean,
  partial_coverage: boolean,
};

/** One CSV row per month with these columns, in this order. */
export const SUMMARY_EXPORT_COLUMNS = Object.freeze(Object.keys(CALENDAR_MONTH_FIELDS));

const metadata = object({
  data_version: dataVersion,
  units: oneOf([UNITS]),
  grid_deg: oneOf([GRID_DEG]),
  regions: array(
    object({
      id: regionId,
      name: nonEmpty,
      bbox,
      coverage: object({ start: isoDate, sp_until: isoDate, nrt_until: isoDate }),
    }),
    { min: 1 },
  ),
  method: object({
    weight_method: weightMethod,
    model_version: nullable(nonEmpty),
    calibration_years: yearSpan,
    baseline: yearSpan,
    viirs_switch: isoDate,
  }),
  attribution: nonEmpty,
});

const calendarResponse = object({
  region_id: regionId,
  units: oneOf([UNITS]),
  data_version: dataVersion,
  weight_method: weightMethod,
  clipped_fraction: number({ min: 0, max: 1 }),
  aoi: refine(
    object({ cells: count, covered_cells: count, area_km2: amount, snapped_fraction: amount }),
    (v) => (v.covered_cells <= v.cells ? null : "covered_cells cannot exceed cells"),
  ),
  baseline: object({ start_year: int(), end_year: int() }),
  fire_season: array(month),
  months: array(refine(object(CALENDAR_MONTH_FIELDS), rankPair)),
});

const currentMonthResponse = refine(
  object({
    year: int(),
    month,
    days_covered: int({ min: 0, max: 31 }),
    value: amount,
    median: amount,
    rank: int({ min: 1 }),
    of_years: int({ min: 1 }),
    provisional: boolean,
    partial_coverage: boolean,
    history: optional(array(object({ year: int(), value: amount }))),
  }),
  rankPair,
);

const apiError = object({
  error: object({ code: oneOf(ERROR_CODES), message: nonEmpty, regions: optional(array(regionId)) }),
});

const latest = object({ version: dataVersion, published_at: isoDateTime });

const currentMonthMeta = object({ year: int(), month, days_covered: int({ min: 0, max: 31 }) });

const methodScores = object({ raw: number(), ratio: number(), model: optional(nullable(number())) });
const regionScores = object({ region_id: regionId, annual_error_pct: methodScores, monthly_r: methodScores });
const validationSummary = object({
  decision: object({ method: weightMethod, passed_regions: int({ min: 0, max: REGION_IDS.length }), rule: nonEmpty }),
  lyo_2012_2019: array(regionScores),
  block_2020_2025: array(regionScores),
  n20_seam: array(
    object({ region_id: regionId, annual_error_pct: number(), monthly_r: number({ min: -1, max: 1 }) }),
  ),
  drift: optional(array(object({ region_id: regionId, year: int(), modis_snpp_ratio: nullable(amount) }))),
});

const regionValidation = object({
  months: array(
    object({
      ym,
      modis: amount,
      viirs_raw: amount,
      ratio: amount,
      model: optional(nullable(amount)),
      fold: yearSpan,
    }),
  ),
  n20: array(object({ ym, snpp: amount, n20: amount })),
});

const detectionCurve = refine(
  object({
    frp_mw: array(number({ above: 0 }), { min: 2 }),
    curves: array(object({ land_class: nonEmpty, p: array(number({ min: 0, max: 1 })) }), { min: 1 }),
  }),
  (v) => (v.curves.every((curve) => curve.p.length === v.frp_mw.length) ? null : "every p must match frp_mw in length"),
);

const kTable = array(
  object({
    region_id: regionId,
    month,
    satellite: oneOf(["S-NPP", "NOAA-20"]),
    value: number({ above: 0 }),
    level: oneOf(["region_month", "pooled_3month", "region_year"]),
  }),
);

const regionCells = object({ region_id: regionId, cells: array(object({ cell_id: cellId, covered: oneOf([0, 1]) })) });

const tileRow = object({
  hotspot_id: string(/^[0-9a-f]{16}$/, "16 lowercase hex characters"),
  satellite: oneOf(SATELLITES),
  sensor: oneOf(["MODIS", "VIIRS_375"]),
  acq_utc: string(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/, "YYYY-MM-DDTHH:MMZ"),
  acq_date: isoDate,
  lat,
  lon,
  daynight: oneOf(["D", "N"]),
  // FIRMS delivers a few slightly negative FRP values (down to about -1.5 MW) as-is.
  frp_mw: number(),
  confidence: nonEmpty,
  fire_type: nullable(int({ min: 0, max: 3 })),
  processing: oneOf(["SP", "NRT"]),
  in_series: boolean,
  weight: nullable(amount),
  weight_method: weightMethod,
  cell_id: cellId,
});

/** @param {Check} check @param {string} name @returns {(value: unknown) => string[]} */
const named = (check, name) => (value) => check(value, name);

export const checkMetadata = named(metadata, "metadata");
export const checkCalendarResponse = named(calendarResponse, "calendar");
export const checkCurrentMonthResponse = named(currentMonthResponse, "current_month");
export const checkApiError = named(apiError, "body");
export const checkLatest = named(latest, "latest");
export const checkCurrentMonthMeta = named(currentMonthMeta, "current_month");
export const checkValidationSummary = named(validationSummary, "validation_summary");
export const checkRegionValidation = named(regionValidation, "validation");
export const checkDetectionCurve = named(detectionCurve, "detection_curve");
export const checkKTable = named(kTable, "k_table");
/** Not a CONTRACTS artifact: one region's `region_cells` rows, as the mocks and fixtures hold them. */
export const checkRegionCells = named(regionCells, "region_cells");
/** One point-tile row after CSV parsing. */
export const checkTileRow = named(tileRow, "row");

/**
 * Checks a `serving.sqlite` meta value by key, including `validation:<region_id>`.
 * @param {string} key
 * @param {unknown} value
 */
export function checkMeta(key, value) {
  const checks = {
    metadata: checkMetadata,
    current_month: checkCurrentMonthMeta,
    validation_summary: checkValidationSummary,
    detection_curve: checkDetectionCurve,
    k_table: checkKTable,
    attribution: named(nonEmpty, "attribution"),
  };
  if (key in checks) return checks[key](value);
  const region = key.startsWith("validation:") ? key.slice("validation:".length) : null;
  if (region !== null && REGION_IDS.includes(region)) return named(regionValidation, key)(value);
  return [`${key}: unknown meta key`];
}
