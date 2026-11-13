import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkLatest } from "../../public/shared/contracts.js";

const WEB_DIR = fileURLToPath(new URL("../../", import.meta.url));

export const DEFAULT_DATA_BASE = "./public/data";
export const LATEST_TTL_MS = 10 * 60 * 1000;
const KEEP_VERSIONS = 2;
const SQLITE_MAGIC = "SQLite format 3\0";

/**
 * @typedef {"missing_latest" | "bad_latest" | "fetch_failed" | "bad_database" | "unknown_region" |
 *   "missing_tile" | "bad_tile"} DataErrorCode
 */

export class DataError extends Error {
  /**
   * @param {DataErrorCode} code
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(code, message, options) {
    super(message, options);
    this.name = "DataError";
    this.code = code;
  }
}

/**
 * One published version, opened read-only.
 * @typedef {object} Dataset
 * @property {string} version
 * @property {string} publishedAt
 * @property {DatabaseSync} db
 * @property {boolean} remote
 * @property {(relativePath: string) => string} locate path or URL of a file in the version directory
 */

/**
 * @typedef {object} DataSourceOptions
 * @property {string} [baseUrl] defaults to `DATA_BASE_URL`, then `./public/data`; relative paths start at `web/`
 * @property {string} [cacheDir] where remote databases are downloaded; defaults to `os.tmpdir()/hotornot-data`
 * @property {number} [ttlMs] how long `latest.json` is trusted before it is read again
 * @property {() => number} [now]
 */

export class DataSource {
  /** @type {{ version: string, published_at: string, checkedAt: number } | null} */
  #latest = null;
  /** @type {Promise<{ version: string, published_at: string, checkedAt: number }> | null} */
  #latestRequest = null;
  /** Least recently used first. @type {Map<string, Promise<Dataset>>} */
  #datasets = new Map();

  /** @param {DataSourceOptions} [options] */
  constructor({ baseUrl, cacheDir, ttlMs = LATEST_TTL_MS, now = Date.now } = {}) {
    const base = baseUrl || process.env.DATA_BASE_URL || DEFAULT_DATA_BASE;
    this.remote = /^https?:\/\//i.test(base);
    this.base = this.remote
      ? base.replace(/\/+$/, "")
      : resolve(WEB_DIR, base.startsWith("file:") ? fileURLToPath(base) : base);
    const key = createHash("sha256").update(this.base).digest("hex").slice(0, 16);
    this.cacheDir = join(cacheDir ?? join(tmpdir(), "hotornot-data"), key);
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /** @param {string} relativePath */
  locate(relativePath) {
    return this.remote ? `${this.base}/${relativePath}` : join(this.base, relativePath);
  }

  /**
   * The version `latest.json` points at. Concurrent first calls share one download and one
   * `DatabaseSync`.
   * @returns {Promise<Dataset>}
   */
  async open() {
    const { version, published_at } = await this.latest();
    let dataset = this.#datasets.get(version);
    if (dataset) {
      this.#datasets.delete(version);
    } else {
      dataset = this.#openVersion(version, published_at);
      dataset.catch(() => {
        if (this.#datasets.get(version) === dataset) this.#datasets.delete(version);
      });
    }
    this.#datasets.set(version, dataset);
    this.#evict();
    return dataset;
  }

  /** Reads `latest.json` at most once per `ttlMs`; when a refresh fails, the last good answer stays. */
  async latest() {
    if (this.#latest && this.now() - this.#latest.checkedAt < this.ttlMs) return this.#latest;
    this.#latestRequest ??= this.#readLatest()
      .then(
        ({ version, published_at }) => (this.#latest = { version, published_at, checkedAt: this.now() }),
        (error) => {
          if (!this.#latest) throw error;
          console.warn(`hotornot data: keeping ${this.#latest.version}; ${error.message}`);
          this.#latest.checkedAt = this.now();
          return this.#latest;
        },
      )
      .finally(() => {
        this.#latestRequest = null;
      });
    return this.#latestRequest;
  }

  close() {
    for (const dataset of this.#datasets.values()) dataset.then((d) => d.db.close(), () => {});
    this.#datasets.clear();
  }

  async #readLatest() {
    const location = this.locate("latest.json");
    let text;
    if (this.remote) {
      const response = await get(location);
      if (response.status === 404) throw new DataError("missing_latest", `no latest.json at ${location}`);
      if (!response.ok) throw new DataError("fetch_failed", `GET ${location} returned ${response.status}`);
      text = await response.text();
    } else {
      try {
        text = await readFile(location, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") throw new DataError("missing_latest", `no latest.json at ${location}`, { cause: error });
        throw error;
      }
    }
    let latest;
    try {
      latest = JSON.parse(text);
    } catch (error) {
      throw new DataError("bad_latest", `${location} is not JSON`, { cause: error });
    }
    const problems = checkLatest(latest);
    if (problems.length > 0) throw new DataError("bad_latest", `${location}: ${problems.join("; ")}`);
    return latest;
  }

  /** @returns {Promise<Dataset>} */
  async #openVersion(version, publishedAt) {
    const file = this.remote ? await this.#download(version) : this.locate(`${version}/serving.sqlite`);
    return {
      version,
      publishedAt,
      db: openReadOnly(file),
      remote: this.remote,
      locate: (relativePath) => this.locate(`${version}/${relativePath}`),
    };
  }

  async #download(version) {
    const target = join(this.cacheDir, version, "serving.sqlite");
    if (await isFile(target)) return target;
    await mkdir(dirname(target), { recursive: true });
    const url = this.locate(`${version}/serving.sqlite`);
    const response = await get(url);
    if (!response.ok || !response.body) throw new DataError("fetch_failed", `GET ${url} returned ${response.status}`);
    const part = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.part`;
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(part));
      const expected = Number(response.headers.get("content-length"));
      const { size } = await stat(part);
      if (expected && !response.headers.has("content-encoding") && size !== expected) {
        throw new DataError("fetch_failed", `${url}: received ${size} of ${expected} bytes`);
      }
      if ((await readHead(part, SQLITE_MAGIC.length)) !== SQLITE_MAGIC) {
        throw new DataError("bad_database", `${url} is not a SQLite database`);
      }
      await rename(part, target);
    } catch (error) {
      await rm(part, { force: true });
      if (error instanceof DataError) throw error;
      throw new DataError("fetch_failed", `downloading ${url} failed: ${error.message}`, { cause: error });
    }
    return target;
  }

  #evict() {
    for (const [version, dataset] of this.#datasets) {
      if (this.#datasets.size <= KEEP_VERSIONS) break;
      this.#datasets.delete(version);
      dataset.then(
        (d) => {
          d.db.close();
          if (this.remote) return rm(join(this.cacheDir, version), { recursive: true, force: true });
        },
        () => {},
      );
    }
  }
}

/** @param {string} file */
function openReadOnly(file) {
  const url = pathToFileURL(file);
  // A published version never changes, so SQLite may skip locking and the -wal/-shm files.
  // This also means a database left in WAL mode must be checkpointed before it is published.
  url.searchParams.set("immutable", "1");
  let db;
  try {
    db = new DatabaseSync(url, { readOnly: true });
    db.prepare("SELECT count(*) FROM meta").get();
    return db;
  } catch (error) {
    db?.close();
    throw new DataError("bad_database", `cannot read ${file}: ${error.message}`, { cause: error });
  }
}

/** @param {string} url */
async function get(url) {
  try {
    return await fetch(url);
  } catch (error) {
    throw new DataError("fetch_failed", `GET ${url} failed: ${error.cause?.message ?? error.message}`, { cause: error });
  }
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readHead(path, length) {
  const handle = await open(path, "r");
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, 0);
    return buffer.toString("latin1", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** @type {DataSource | null} */
let defaultSource = null;

/** The process-wide source configured by `DATA_BASE_URL`, created on first use. */
export function getDataSource() {
  return (defaultSource ??= new DataSource());
}

/** Closes the default source so the next `getDataSource()` reads `DATA_BASE_URL` again. */
export function resetDataSource() {
  defaultSource?.close();
  defaultSource = null;
}
