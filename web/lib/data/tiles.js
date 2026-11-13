import { once } from "node:events";
import { createReadStream } from "node:fs";
import { Readable, pipeline } from "node:stream";
import { createGunzip } from "node:zlib";
import { TILE_COLUMNS } from "../../public/shared/contracts.js";
import { DataError } from "./source.js";

/** @typedef {import("./source.js").Dataset} Dataset */
/** @typedef {import("../../public/shared/contracts.js").TileRow} TileRow */

/**
 * @typedef {object} TileQuery
 * @property {string} regionId
 * @property {Iterable<string>} tileIds read in this order
 * @property {Iterable<number> | null} [cellIds] null or absent: every cell
 * @property {number} [ymStart] inclusive, from `acq_date`
 * @property {number} [ymEnd] inclusive
 */

const HEADER = TILE_COLUMNS.join(",");
const SAFE_REGION = /^[a-z0-9_]+$/;
const SAFE_TILE = /^[ns]\d{2}[ew]\d{3}$/;

/**
 * Streams the rows of `points/{regionId}/{tileId}.csv.gz` that match the cell set and `ym`
 * range, tile by tile; inside a tile, rows keep the published order (`cell_id`, `acq_utc`).
 * @param {Dataset} dataset
 * @param {TileQuery} query
 * @returns {AsyncGenerator<TileRow>}
 */
export async function* readTileRows(dataset, { regionId, tileIds, cellIds = null, ymStart = 0, ymEnd = 999999 }) {
  const cells = cellIds ? new Set(cellIds) : null;
  if (cells?.size === 0) return;
  let lastCell = Infinity;
  if (cells) {
    lastCell = -1;
    for (const cell of cells) if (cell > lastCell) lastCell = cell;
  }
  if (!SAFE_REGION.test(regionId)) throw new DataError("unknown_region", `bad region id "${regionId}"`);
  for (const tileId of tileIds) {
    if (!SAFE_TILE.test(tileId)) throw new DataError("bad_tile", `bad tile id "${tileId}"`);
    const location = dataset.locate(`points/${regionId}/${tileId}.csv.gz`);
    const parser = new TileParser(location, cells, lastCell, ymStart, ymEnd);
    const stream = await openTile(dataset.remote, location);
    try {
      for await (const chunk of stream) {
        yield* parser.push(chunk);
        if (parser.done) break;
      }
    } catch (error) {
      if (error instanceof DataError) throw error;
      if (String(error.code).startsWith("Z_")) {
        throw new DataError("bad_tile", `${location} is not valid gzip: ${error.message}`, { cause: error });
      }
      if (dataset.remote) throw new DataError("fetch_failed", `reading ${location} failed: ${error.message}`, { cause: error });
      throw error;
    }
    yield* parser.end();
  }
}

/** @returns {Promise<AsyncIterable<string>>} */
async function openTile(remote, location) {
  let body;
  if (remote) {
    let response;
    try {
      response = await fetch(location);
    } catch (error) {
      throw new DataError("fetch_failed", `GET ${location} failed: ${error.cause?.message ?? error.message}`, { cause: error });
    }
    if (response.status === 404) throw new DataError("missing_tile", `no tile at ${location}`);
    if (!response.ok || !response.body) throw new DataError("fetch_failed", `GET ${location} returned ${response.status}`);
    body = Readable.fromWeb(response.body);
    // fetch has already gunzipped a body served with Content-Encoding: gzip.
    if (/\bgzip\b/.test(response.headers.get("content-encoding") ?? "")) return body.setEncoding("utf8");
  } else {
    body = createReadStream(location);
    try {
      await once(body, "open");
    } catch (error) {
      if (error.code === "ENOENT") throw new DataError("missing_tile", `no tile at ${location}`, { cause: error });
      throw error;
    }
  }
  return pipeline(body, createGunzip(), () => {}).setEncoding("utf8");
}

class TileParser {
  done = false;
  #rest = "";
  #line = 0;

  /**
   * @param {string} location
   * @param {Set<number> | null} cells
   * @param {number} lastCell
   * @param {number} ymStart
   * @param {number} ymEnd
   */
  constructor(location, cells, lastCell, ymStart, ymEnd) {
    this.location = location;
    this.cells = cells;
    this.lastCell = lastCell;
    this.ymStart = ymStart;
    this.ymEnd = ymEnd;
  }

  /** @param {string} text @returns {TileRow[]} */
  push(text) {
    const lines = (this.#rest + text).split("\n");
    this.#rest = lines.pop() ?? "";
    return this.#parse(lines);
  }

  /** @returns {TileRow[]} */
  end() {
    if (this.done) return [];
    const rows = this.#parse(this.#rest === "" ? [] : [this.#rest]);
    if (this.#line === 0) throw new DataError("bad_tile", `${this.location} is empty`);
    return rows;
  }

  /** @param {string[]} lines */
  #parse(lines) {
    const rows = [];
    for (let line of lines) {
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.#line += 1;
      if (this.#line === 1) {
        if (line.replace(/^﻿/, "") !== HEADER) {
          throw new DataError("bad_tile", `${this.location}: header is not the CONTRACTS tile header: ${line.slice(0, 200)}`);
        }
        continue;
      }
      if (line === "") continue;
      const fields = line.includes('"') ? splitQuoted(line) : line.split(",");
      if (fields.length !== TILE_COLUMNS.length) {
        throw new DataError("bad_tile", `${this.location} line ${this.#line}: ${fields.length} fields, expected ${TILE_COLUMNS.length}`);
      }
      const cellId = Number(fields[15]);
      if (cellId > this.lastCell) {
        this.done = true;
        break;
      }
      if (this.cells && !this.cells.has(cellId)) continue;
      const date = fields[4];
      const ym = Number(date.slice(0, 4)) * 100 + Number(date.slice(5, 7));
      if (ym < this.ymStart || ym > this.ymEnd) continue;
      rows.push(this.#row(fields, cellId));
    }
    return rows;
  }

  /** @param {string[]} f @param {number} cellId @returns {TileRow} */
  #row(f, cellId) {
    return {
      hotspot_id: f[0],
      satellite: f[1],
      sensor: f[2],
      acq_utc: f[3],
      acq_date: f[4],
      lat: Number(f[5]),
      lon: Number(f[6]),
      daynight: f[7],
      frp_mw: Number(f[8]),
      confidence: f[9],
      fire_type: f[10] === "" ? null : Number(f[10]),
      processing: f[11],
      in_series: this.#boolean(f[12]),
      weight: f[13] === "" ? null : Number(f[13]),
      weight_method: f[14],
      cell_id: cellId,
    };
  }

  #boolean(text) {
    if (text === "true") return true;
    if (text === "false") return false;
    throw new DataError("bad_tile", `${this.location} line ${this.#line}: in_series is "${text}", expected true or false`);
  }
}

/** RFC 4180 fields, for the rare line with quotes. @param {string} line */
function splitQuoted(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      fields.push(field);
      field = "";
    } else field += char;
  }
  fields.push(field);
  return fields;
}
