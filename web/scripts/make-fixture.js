// Builds a small synthetic published-data directory in the published layout:
//   latest.json, v3/serving.sqlite, v3/points/nile_delta/{n30e030,n30e031}.csv.gz
// Usage: node scripts/make-fixture.js [outDir]   (default tests/fixtures/data)
//
// Only nile_delta is consistent end to end: its cells and cell_days are aggregated from the
// hotspots in its two tiles. The other regions have synthetic cells and cell_days with
// points = 0 and no tiles, for snapping and speed tests.
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { csvTable } from "../lib/csv.js";
import detectionCurve from "../mocks/detection_curve.json" with { type: "json" };
import metadata from "../mocks/metadata.json" with { type: "json" };
import validationNile from "../mocks/validation-nile_delta.json" with { type: "json" };
import validationSummary from "../mocks/validation_summary.json" with { type: "json" };
import { TILE_COLUMNS } from "../public/shared/contracts.js";
import { cellOf, cellsInBbox, center, tileOf } from "../public/shared/grid.js";

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
export const FIXTURE_VERSION = metadata.data_version;
export const FIXTURE_PUBLISHED_AT = "2026-11-13T12:00:00Z";
export const FIXTURE_TILES = Object.freeze(["n30e030", "n30e031"]);
export const CURRENT_MONTH = Object.freeze({ year: 2026, month: 11, days_covered: 13 });

const FIRST_YM = 200011;
const LAST_YM = CURRENT_MONTH.year * 100 + CURRENT_MONTH.month;
const SP_UNTIL = "2026-06-30";
const WEIGHT_METHOD = metadata.method.weight_method;
const SNPP_OUTAGES = [
  ["2016-02-10", "2016-02-12"],
  ["2019-03-01", "2019-03-05"],
  ["2022-07-26", "2022-08-09"],
];

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE regions (region_id TEXT PRIMARY KEY, name TEXT NOT NULL, bbox TEXT NOT NULL,
  sp_until TEXT NOT NULL, nrt_until TEXT NOT NULL, tiles TEXT NOT NULL);
CREATE TABLE region_cells (region_id TEXT NOT NULL, cell_id INTEGER NOT NULL, covered INTEGER NOT NULL,
  PRIMARY KEY (region_id, cell_id)) WITHOUT ROWID;
CREATE TABLE cells (region_id TEXT NOT NULL, cell_id INTEGER NOT NULL, ym INTEGER NOT NULL,
  harmonized REAL NOT NULL, modis_raw INTEGER NOT NULL, viirs_raw INTEGER NOT NULL, points INTEGER NOT NULL,
  PRIMARY KEY (region_id, cell_id, ym)) WITHOUT ROWID;
CREATE TABLE months (region_id TEXT NOT NULL, ym INTEGER NOT NULL, terra_only INTEGER NOT NULL,
  viirs_source TEXT, viirs_missing_days INTEGER NOT NULL, provisional INTEGER NOT NULL,
  days_covered INTEGER NOT NULL, PRIMARY KEY (region_id, ym));
CREATE TABLE cell_days (region_id TEXT NOT NULL, cell_id INTEGER NOT NULL, year INTEGER NOT NULL,
  day INTEGER NOT NULL, harmonized REAL NOT NULL, PRIMARY KEY (region_id, cell_id, year, day)) WITHOUT ROWID;
`;

/** Peak months of each region's fire season, used to shape the synthetic data. */
const SEASONS = {
  nile_delta: { 5: 2, 6: 2, 10: 4, 11: 5 },
  california: { 7: 3, 8: 4, 9: 4, 10: 3 },
  se_australia: { 10: 2, 11: 3, 12: 4, 1: 4, 2: 3 },
  n_argentina: { 7: 2, 8: 4, 9: 5, 10: 3 },
};
const SYNTHETIC_DENSITY = {
  california: { active: 0.3, months: 2 },
  se_australia: { active: 1, months: 2 },
  n_argentina: { active: 0.3, months: 2 },
};

/** Mulberry32: a seeded generator, so every build is identical. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;
const pad = (value, width) => String(value).padStart(width, "0");

/** Rough rectangles for Bolivia and Brazil, the countries n_argentina excludes. */
function covered(regionId, cellId) {
  if (regionId !== "n_argentina") return 1;
  const [lon, lat] = center(cellId);
  return (lat > -22.9 && lon < -62.6) || (lat > -24 && lon > -58) ? 0 : 1;
}

const daysIn = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

function monthList() {
  const yms = [];
  for (let ym = FIRST_YM; ym <= LAST_YM; ym = ym % 100 === 12 ? ym + 89 : ym + 1) yms.push(ym);
  return yms;
}

const isOutage = (date) => SNPP_OUTAGES.some(([from, to]) => date >= from && date <= to);
const outageMonths = new Set(
  SNPP_OUTAGES.flatMap(([from, to]) => [from, to].map((date) => Number(date.slice(0, 4) + date.slice(5, 7)))),
);

function monthFlags(ym) {
  const year = Math.trunc(ym / 100);
  const month = ym % 100;
  let viirsSource = null;
  if (ym >= 201201) viirsSource = ym === LAST_YM || (ym >= 201804 && outageMonths.has(ym)) ? "SNPP+N20" : "SNPP";
  let missing = 0;
  if (ym === 201201) missing = 19;
  else if (ym < 201804 && outageMonths.has(ym)) missing = 3;
  return {
    ym,
    terra_only: ym < 200207 ? 1 : 0,
    viirs_source: viirsSource,
    viirs_missing_days: missing,
    provisional: ym > Number(SP_UNTIL.slice(0, 4) + SP_UNTIL.slice(5, 7)) ? 1 : 0,
    days_covered: ym === LAST_YM ? CURRENT_MONTH.days_covered : daysIn(year, month),
  };
}

function kTable() {
  const rows = [];
  for (const { id } of metadata.regions) {
    for (let month = 1; month <= 12; month += 1) {
      for (const satellite of ["S-NPP", "NOAA-20"]) {
        rows.push({
          region_id: id,
          month,
          satellite,
          value: round(0.3 + 0.08 * Math.sin(month) + (satellite === "NOAA-20" ? 0.04 : 0), 3),
          level: SEASONS[id][month] ? "region_month" : "pooled_3month",
        });
      }
    }
  }
  return rows;
}

function weightedMonth(rand, season) {
  const weights = Array.from({ length: 12 }, (_, i) => season[i + 1] ?? 0.4);
  let pick = rand() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < 12; i += 1) {
    pick -= weights[i];
    if (pick < 0) return i + 1;
  }
  return 12;
}

const SATELLITE_HOURS = {
  Terra: { D: [8, 9], N: [19, 20] },
  Aqua: { D: [10, 11], N: [22, 23] },
  "S-NPP": { D: [10, 11], N: [22, 23] },
  "NOAA-20": { D: [10, 11], N: [21, 22] },
};

function observers(date) {
  const list = [];
  if (date >= "2000-11-01") list.push("Terra");
  if (date >= "2002-07-04") list.push("Aqua");
  if (date >= "2012-01-20" && date <= "2026-11-01" && !isOutage(date)) list.push("S-NPP");
  if (date >= "2018-04-01") list.push("NOAA-20");
  return list;
}

/** One satellite's detections of a fire, with the series role P06 would give them. */
function detections(rand, k, satellite, date, cell) {
  const modis = satellite === "Terra" || satellite === "Aqua";
  const count = modis ? 1 : 1 + Math.floor(rand() * 3);
  const daynight = rand() < 0.85 ? "D" : "N";
  const [h0, h1] = SATELLITE_HOURS[satellite][daynight];
  const time = `${pad(h0 + Math.floor(rand() * (h1 - h0 + 1)), 2)}${pad(Math.floor(rand() * 60), 2)}`;
  const processing = date <= SP_UNTIL ? "SP" : "NRT";
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const corner = { lat: Math.floor(cell / 7200) / 20 - 90, lon: (cell % 7200) / 20 - 180 };
    const lat = round(corner.lat + rand() * 0.0499, 5);
    const lon = round(corner.lon + rand() * 0.0499, 5);
    const fireType = processing === "NRT" ? null : rand() < 0.04 ? 2 : 0;
    const masked = processing === "NRT" && rand() < 0.08;
    const vegetation = fireType === 0 || (fireType === null && !masked);
    let role;
    if (!vegetation) role = masked ? "static_masked" : "non_vegetation";
    else if (modis) role = date <= "2011-12-31" ? "modis" : "modis_overlap";
    else if (satellite === "S-NPP") role = "snpp";
    else if (date >= "2026-11-02") role = "n20";
    else role = isOutage(date) ? "n20_gapfill" : "n20_overlap";
    let weight = null;
    if (vegetation) weight = modis ? 1 : round(k(Number(date.slice(5, 7)), satellite) * (0.7 + 0.6 * rand()), 4);
    rows.push({
      hotspot_id: createHash("sha1")
        .update(`${satellite}|${date}|${time}|${lat.toFixed(5)}|${lon.toFixed(5)}`)
        .digest("hex")
        .slice(0, 16),
      satellite,
      sensor: modis ? "MODIS" : "VIIRS_375",
      acq_utc: `${date}T${time.slice(0, 2)}:${time.slice(2)}Z`,
      acq_date: date,
      lat,
      lon,
      daynight,
      frp_mw: round(modis ? 5 + rand() * 75 : 0.5 + rand() * 20, 2),
      confidence: modis ? String(20 + Math.floor(rand() * 81)) : rand() < 0.15 ? "l" : rand() < 0.82 ? "n" : "h",
      fire_type: fireType,
      processing,
      in_series: ["modis", "snpp", "n20_gapfill", "n20"].includes(role),
      weight,
      weight_method: WEIGHT_METHOD,
      cell_id: cellOf(lat, lon),
      role,
    });
  }
  return rows;
}

function nileHotspots(rand, k) {
  const area = cellsInBbox([30, 30, 32, 31]);
  const active = Array.from({ length: 150 }, () => area[Math.floor(rand() * area.length)]);
  const fires = [];
  for (const ym of monthList()) {
    const year = Math.trunc(ym / 100);
    const month = ym % 100;
    const days = ym === LAST_YM ? CURRENT_MONTH.days_covered : daysIn(year, month);
    const events = Math.floor(rand() * 2 * 3 * (SEASONS.nile_delta[month] ?? 0.3));
    for (let i = 0; i < events; i += 1) {
      const date = `${year}-${pad(month, 2)}-${pad(1 + Math.floor(rand() * days), 2)}`;
      fires.push({ date, cell: active[Math.floor(rand() * active.length)] });
    }
  }
  for (const date of ["2012-01-25", "2016-02-11", "2019-03-02", "2022-07-28", "2026-11-01", "2026-11-02", "2026-11-13"]) {
    fires.push({ date, cell: active[0] });
  }
  const seen = new Set();
  const rows = [];
  for (const { date, cell } of fires) {
    for (const satellite of observers(date)) {
      if (rand() > (satellite === "Terra" || satellite === "Aqua" ? 0.6 : 0.9)) continue;
      for (const row of detections(rand, k, satellite, date, cell)) {
        if (seen.has(row.hotspot_id)) continue;
        seen.add(row.hotspot_id);
        rows.push(row);
      }
    }
  }
  return rows.sort((a, b) => a.cell_id - b.cell_id || a.acq_utc.localeCompare(b.acq_utc) || a.hotspot_id.localeCompare(b.hotspot_id));
}

/** `cells` and `cell_days` rows aggregated from hotspots, as P10 builds them. */
function aggregate(hotspots) {
  const cells = new Map();
  const days = new Map();
  for (const row of hotspots) {
    const ym = Number(row.acq_date.slice(0, 4) + row.acq_date.slice(5, 7));
    const key = `${row.cell_id}:${ym}`;
    const cell = cells.get(key) ?? { cell_id: row.cell_id, ym, harmonized: 0, modis_raw: 0, viirs_raw: 0, points: 0 };
    cells.set(key, cell);
    cell.points += 1;
    if (row.sensor === "MODIS" && row.weight !== null) cell.modis_raw += 1;
    if (!row.in_series) continue;
    cell.harmonized += row.weight;
    if (row.sensor === "VIIRS_375") cell.viirs_raw += 1;
    if (ym % 100 === CURRENT_MONTH.month) {
      const dayKey = `${row.cell_id}:${row.acq_date}`;
      const day = days.get(dayKey) ?? {
        cell_id: row.cell_id,
        year: Math.trunc(ym / 100),
        day: Number(row.acq_date.slice(8, 10)),
        harmonized: 0,
      };
      days.set(dayKey, day);
      day.harmonized += row.weight;
    }
  }
  return { cells: [...cells.values()], days: [...days.values()] };
}

function syntheticCells(rand, regionId, regionCells, k) {
  const { active, months } = SYNTHETIC_DENSITY[regionId];
  const cells = [];
  const days = [];
  for (const { cell_id, covered: isCovered } of regionCells) {
    if (!isCovered || rand() >= active) continue;
    const yms = new Set();
    const count = 1 + Math.floor(rand() * (2 * months - 1));
    for (let i = 0; i < count; i += 1) {
      const ym = (2000 + Math.floor(rand() * 27)) * 100 + weightedMonth(rand, SEASONS[regionId]);
      if (ym >= FIRST_YM && ym <= LAST_YM) yms.add(ym);
    }
    for (const ym of [...yms].sort((a, b) => a - b)) {
      const month = ym % 100;
      const viirs = ym >= 201201;
      const modisRaw = viirs ? Math.floor(rand() * 4) : 1 + Math.floor(rand() * 4);
      const viirsRaw = viirs ? 1 + Math.floor(rand() * 12) : 0;
      const harmonized = viirs ? round(viirsRaw * k(month, "S-NPP") * (0.7 + 0.6 * rand()), 4) : modisRaw;
      cells.push({ cell_id, ym, harmonized, modis_raw: modisRaw, viirs_raw: viirsRaw, points: 0 });
      if (month !== CURRENT_MONTH.month) continue;
      const year = Math.trunc(ym / 100);
      const last = ym === LAST_YM ? CURRENT_MONTH.days_covered : daysIn(year, month);
      const first = 1 + Math.floor(rand() * (last - 1));
      const share = round(harmonized * rand(), 4);
      days.push({ cell_id, year, day: first, harmonized: share });
      days.push({ cell_id, year, day: first + 1, harmonized: harmonized - share });
    }
  }
  return { cells, days };
}

function writeDatabase(file, regions, meta) {
  rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.exec("BEGIN");
  const insertMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(meta)) insertMeta.run(key, JSON.stringify(value));
  const insertRegion = db.prepare("INSERT INTO regions VALUES (?, ?, ?, ?, ?, ?)");
  const insertRegionCell = db.prepare("INSERT INTO region_cells VALUES (?, ?, ?)");
  const insertCell = db.prepare("INSERT INTO cells VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insertMonth = db.prepare("INSERT INTO months VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insertDay = db.prepare("INSERT INTO cell_days VALUES (?, ?, ?, ?, ?)");
  for (const r of regions) {
    insertRegion.run(r.id, r.name, JSON.stringify(r.bbox), r.coverage.sp_until, r.coverage.nrt_until, JSON.stringify(r.tiles));
    for (const c of r.regionCells) insertRegionCell.run(r.id, c.cell_id, c.covered);
    for (const c of r.cells) insertCell.run(r.id, c.cell_id, c.ym, c.harmonized, c.modis_raw, c.viirs_raw, c.points);
    for (const m of r.months) {
      insertMonth.run(r.id, m.ym, m.terra_only, m.viirs_source, m.viirs_missing_days, m.provisional, m.days_covered);
    }
    for (const d of r.days) insertDay.run(r.id, d.cell_id, d.year, d.day, d.harmonized);
  }
  db.exec("COMMIT");
  db.close();
}

/**
 * Writes `latest.json` and `v3/` into `outDir`, replacing only those.
 * @param {string} outDir
 */
export function buildFixture(outDir) {
  const rand = random(20261113);
  const kRows = kTable();
  const kIndex = new Map(kRows.map((row) => [`${row.region_id}:${row.month}:${row.satellite}`, row.value]));
  const versionDir = join(outDir, FIXTURE_VERSION);
  rmSync(versionDir, { recursive: true, force: true });
  mkdirSync(join(versionDir, "points", "nile_delta"), { recursive: true });

  const regions = metadata.regions.map((region) => {
    const k = (month, satellite) => kIndex.get(`${region.id}:${month}:${satellite}`);
    const regionCells = cellsInBbox(region.bbox).map((cell_id) => ({ cell_id, covered: covered(region.id, cell_id) }));
    let data;
    let tiles = [];
    if (region.id === "nile_delta") {
      const hotspots = nileHotspots(rand, k);
      data = aggregate(hotspots);
      tiles = [...FIXTURE_TILES];
      for (const tile of tiles) {
        const rows = hotspots.filter((row) => tileOf(row.cell_id) === tile);
        writeFileSync(join(versionDir, "points", "nile_delta", `${tile}.csv.gz`), gzipSync(csvTable(TILE_COLUMNS, rows)));
      }
    } else {
      data = syntheticCells(rand, region.id, regionCells, k);
    }
    return {
      ...region,
      tiles,
      regionCells,
      cells: data.cells.sort((a, b) => a.cell_id - b.cell_id || a.ym - b.ym),
      days: data.days.sort((a, b) => a.cell_id - b.cell_id || a.year - b.year || a.day - b.day),
      months: monthList().map(monthFlags),
    };
  });

  writeDatabase(join(versionDir, "serving.sqlite"), regions, {
    metadata,
    current_month: CURRENT_MONTH,
    validation_summary: validationSummary,
    "validation:nile_delta": validationNile,
    detection_curve: detectionCurve,
    k_table: kRows,
    attribution: metadata.attribution,
  });
  writeFileSync(join(outDir, "latest.json"), `${JSON.stringify({ version: FIXTURE_VERSION, published_at: FIXTURE_PUBLISHED_AT })}\n`);
  return {
    dir: outDir,
    version: FIXTURE_VERSION,
    regions: regions.map((r) => ({ id: r.id, region_cells: r.regionCells.length, cells: r.cells.length, cell_days: r.days.length })),
    bytes: statSync(join(versionDir, "serving.sqlite")).size,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = resolve(WEB_DIR, process.argv[2] ?? "tests/fixtures/data");
  mkdirSync(outDir, { recursive: true });
  const started = performance.now();
  const summary = buildFixture(outDir);
  for (const region of summary.regions) console.log(region);
  console.log(`${outDir}: ${summary.version}, serving.sqlite ${summary.bytes} bytes, ${Math.round(performance.now() - started)} ms`);
}
