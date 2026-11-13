import { DataError, getDataSource } from "./source.js";
import { readTileRows } from "./tiles.js";

/** @typedef {import("./source.js").Dataset} Dataset */
/** @typedef {import("./source.js").DataSource} DataSource */
/** @typedef {import("./tiles.js").TileQuery} TileQuery */
/** @typedef {import("../../public/shared/contracts.js").TileRow} TileRow */

/**
 * @typedef {object} Region
 * @property {string} region_id
 * @property {string} name
 * @property {[number, number, number, number]} bbox
 * @property {string} sp_until
 * @property {string} nrt_until
 * @property {string[]} tiles
 *
 * @typedef {{ cell_id: number, covered: 0 | 1 }} RegionCell
 * @typedef {{ ym: number, harmonized: number, modis_raw: number, viirs_raw: number, points: number }} MonthSums
 * @typedef {{ region_id: string, ym: number, terra_only: number, viirs_source: string | null,
 *   viirs_missing_days: number, provisional: number, days_covered: number }} MonthFlags
 * @typedef {{ year: number, day: number, harmonized: number }} DaySum
 */

const FIRST_YEAR = 2000;
const MONTH_SLOTS = 100 * 12;
const SUM_FIELDS = 5;

// Summing per month in a JavaScript aggregate skips the GROUP BY sort, which is most of the
// cost: over a million cell-months it takes about 300 ms instead of 600 ms.
const monthSums = {
  start: () => new Float64Array(MONTH_SLOTS * SUM_FIELDS),
  step(sums, ym, harmonized, modisRaw, viirsRaw, points) {
    const at = ((Math.trunc(ym / 100) - FIRST_YEAR) * 12 + (ym % 100) - 1) * SUM_FIELDS;
    if (!(at >= 0 && at < sums.length)) throw new RangeError(`cells.ym ${ym} is outside ${FIRST_YEAR} to 2099`);
    sums[at] += harmonized;
    sums[at + 1] += modisRaw;
    sums[at + 2] += viirsRaw;
    sums[at + 3] += points;
    sums[at + 4] += 1;
    return sums;
  },
  result(sums) {
    const months = [];
    for (let at = 0; at < sums.length; at += SUM_FIELDS) {
      if (sums[at + 4] === 0) continue;
      const slot = at / SUM_FIELDS;
      months.push({
        ym: (FIRST_YEAR + Math.trunc(slot / 12)) * 100 + (slot % 12) + 1,
        harmonized: sums[at],
        modis_raw: sums[at + 1],
        viirs_raw: sums[at + 2],
        points: sums[at + 3],
      });
    }
    return JSON.stringify(months);
  },
};

/** @param {Iterable<number>} cellIds */
const jsonList = (cellIds) => JSON.stringify(Array.isArray(cellIds) ? cellIds : Array.from(cellIds));

/**
 * Typed reads of one version's `serving.sqlite`. Every value it returns is shared between
 * callers: treat it as read-only.
 */
export class Serving {
  /** @type {readonly Region[] | null} */
  #regions = null;
  /** @type {Map<string, readonly RegionCell[]>} */
  #regionCells = new Map();
  #sql;

  /** @param {Dataset} dataset */
  constructor(dataset) {
    this.dataset = dataset;
    this.version = dataset.version;
    const db = dataset.db;
    db.aggregate("hotornot_month_sums", monthSums);
    this.#sql = {
      meta: db.prepare("SELECT value FROM meta WHERE key = ?"),
      regions: db.prepare("SELECT region_id, name, bbox, sp_until, nrt_until, tiles FROM regions ORDER BY region_id"),
      regionCells: db.prepare("SELECT cell_id, covered FROM region_cells WHERE region_id = ? ORDER BY cell_id"),
      sumCells: db.prepare(
        `SELECT hotornot_month_sums(ym, harmonized, modis_raw, viirs_raw, points) AS months FROM cells
         WHERE region_id = ? AND cell_id IN (SELECT value FROM json_each(?)) AND ym BETWEEN ? AND ?`,
      ),
      months: db.prepare(
        `SELECT region_id, ym, terra_only, viirs_source, viirs_missing_days, provisional, days_covered
         FROM months WHERE region_id = ? ORDER BY ym`,
      ),
      cellDays: db.prepare(
        `SELECT year, day, SUM(harmonized) AS harmonized FROM cell_days
         WHERE region_id = ? AND cell_id IN (SELECT value FROM json_each(?))
         GROUP BY year, day ORDER BY year, day`,
      ),
    };
  }

  /**
   * The parsed JSON value of a `meta` key, or `undefined` when the key is absent.
   * @param {string} key
   */
  getMeta(key) {
    const row = this.#sql.meta.get(key);
    return row ? JSON.parse(row.value) : undefined;
  }

  /** @returns {readonly Region[]} sorted by `region_id` */
  getRegions() {
    this.#regions ??= Object.freeze(
      this.#sql.regions.all().map((row) =>
        Object.freeze({
          region_id: row.region_id,
          name: row.name,
          bbox: JSON.parse(row.bbox),
          sp_until: row.sp_until,
          nrt_until: row.nrt_until,
          tiles: JSON.parse(row.tiles),
        }),
      ),
    );
    return this.#regions;
  }

  /**
   * @param {string} regionId
   * @returns {Region}
   */
  getRegion(regionId) {
    const region = this.getRegions().find((r) => r.region_id === regionId);
    if (!region) throw new DataError("unknown_region", `no region "${regionId}" in data version ${this.version}`);
    return region;
  }

  /**
   * Every cell centered inside the region's bbox, sorted by `cell_id`.
   * @param {string} regionId
   * @returns {readonly RegionCell[]}
   */
  getRegionCells(regionId) {
    let cells = this.#regionCells.get(regionId);
    if (!cells) {
      this.getRegion(regionId);
      cells = Object.freeze(this.#sql.regionCells.all(regionId).map((row) => ({ ...row })));
      this.#regionCells.set(regionId, cells);
    }
    return cells;
  }

  /**
   * Per-month sums over the given cells, only for months that have `cells` rows, sorted by `ym`.
   * Duplicate cell ids count once. NULL values count as 0.
   * @param {string} regionId
   * @param {Iterable<number>} cellIds
   * @param {number} [ymStart] inclusive
   * @param {number} [ymEnd] inclusive
   * @returns {MonthSums[]}
   */
  sumCells(regionId, cellIds, ymStart = 0, ymEnd = 999999) {
    this.getRegion(regionId);
    const ids = jsonList(cellIds);
    if (ids === "[]") return [];
    const row = this.#sql.sumCells.get(regionId, ids, ymStart, ymEnd);
    return JSON.parse(row.months);
  }

  /**
   * @param {string} regionId
   * @returns {MonthFlags[]} sorted by `ym`
   */
  getMonths(regionId) {
    this.getRegion(regionId);
    return this.#sql.months.all(regionId).map((row) => ({ ...row }));
  }

  /**
   * Per-day sums of `cell_days.harmonized` over the given cells: the calendar month in
   * `meta.current_month`, every year. Only days with rows appear, sorted by year then day.
   * @param {string} regionId
   * @param {Iterable<number>} cellIds
   * @returns {DaySum[]}
   */
  sumCellDays(regionId, cellIds) {
    this.getRegion(regionId);
    const ids = jsonList(cellIds);
    if (ids === "[]") return [];
    return this.#sql.cellDays.all(regionId, ids).map((row) => ({ ...row }));
  }

  /**
   * Point-tile rows for the region. Tiles the region does not list (no published hotspots) are
   * skipped; without `tileIds` every listed tile is read.
   * @param {Omit<TileQuery, "tileIds"> & { tileIds?: Iterable<string> | null }} query
   * @returns {AsyncGenerator<TileRow>}
   */
  tileRows({ tileIds = null, ...query }) {
    const { tiles } = this.getRegion(query.regionId);
    const wanted = tileIds ? new Set(tileIds) : null;
    return readTileRows(this.dataset, { ...query, tileIds: wanted ? tiles.filter((t) => wanted.has(t)) : tiles });
  }
}

/** @type {WeakMap<Dataset, Serving>} */
const servings = new WeakMap();

/**
 * The current version. Use one `Serving` for every query of a request, so they all read the
 * same version.
 * @param {DataSource} [source]
 * @returns {Promise<Serving>}
 */
export async function openServing(source = getDataSource()) {
  const dataset = await source.open();
  let serving = servings.get(dataset);
  if (!serving) {
    serving = new Serving(dataset);
    servings.set(dataset, serving);
  }
  return serving;
}
