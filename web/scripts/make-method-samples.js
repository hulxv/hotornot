// Writes the data behind the two explorable widgets on "How it works" from the pipeline
// database, opened read-only. The committed modules in public/js/method/samples/ are what the
// page uses; this script is how they were made. From web/:
//
//   node scripts/make-method-samples.js [path/to/hotornot.sqlite]
//
// The path defaults to $HOTORNOT_DB, then ../pipeline/data/hotornot.sqlite.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cellOf } from "../public/shared/grid.js";

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = join(WEB_DIR, "public", "js", "method", "samples");
const REGIONS_FILE = join(WEB_DIR, "..", "pipeline", "config", "regions.json");

export const CHOICES = Object.freeze({
  region: "nile_delta",
  // Rice-straw season: Aqua passed 4 to 5 minutes after S-NPP's afternoon pass and MODIS also
  // looked at its night pass, so every VIIRS fire of the day has a matchup label.
  day: "2017-09-13",
  closeUpKm: 8,
  // A static source the mask uses (31.3519 N, 30.3166 E, near Idku), over the last 90 days of
  // unlabelled data before the v3 run.
  flare: { lat: 31.3519, lon: 30.3166, start: "2026-08-16", halfSpots: 6 },
  places: [
    { name: "Cairo", lat: 30.044, lon: 31.236 },
    { name: "Alexandria", lat: 31.2, lon: 29.919 },
  ],
});

const SATELLITES = ["Terra", "Aqua", "S-NPP", "NOAA-20"];
const IN_SERIES = new Set(["modis", "snpp", "n20_gapfill", "n20"]);
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const KM_PER_DEG = 111.195;

const round = (x, digits) => (x === null || x === undefined ? null : Number(x.toFixed(digits)));
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/** @param {string} path */
export function openDb(path) {
  return new DatabaseSync(path, { readOnly: true, timeout: 300_000 });
}

/** @param {DatabaseSync} db @param {string} name */
function artifact(db, name) {
  const row = db.prepare("SELECT json FROM artifacts WHERE name = ?").get(name);
  if (!row) throw new Error(`artifact ${name} is missing; run the pipeline first`);
  return JSON.parse(String(row.json));
}

/**
 * Sutherland-Hodgman: the part of a polygon ring inside a [west, south, east, north] box.
 * @param {number[][]} ring
 * @param {number[]} bbox
 */
export function clipRing(ring, [west, south, east, north]) {
  const edges = [
    { inside: (p) => p[0] >= west, cut: (a, b) => cutAt(a, b, 0, west) },
    { inside: (p) => p[0] <= east, cut: (a, b) => cutAt(a, b, 0, east) },
    { inside: (p) => p[1] >= south, cut: (a, b) => cutAt(a, b, 1, south) },
    { inside: (p) => p[1] <= north, cut: (a, b) => cutAt(a, b, 1, north) },
  ];
  let points = ring;
  for (const edge of edges) {
    const next = [];
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if (edge.inside(b)) {
        if (!edge.inside(a)) next.push(edge.cut(a, b));
        next.push(b);
      } else if (edge.inside(a)) {
        next.push(edge.cut(a, b));
      }
    }
    points = next;
    if (points.length === 0) break;
  }
  return points;
}

function cutAt(a, b, axis, value) {
  const t = (value - a[axis]) / (b[axis] - a[axis]);
  const p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  p[axis] = value;
  return p;
}

/** @param {DatabaseSync} db @param {number[]} bbox */
function landInBox(db, bbox) {
  const row = db.prepare("SELECT geometry FROM country_boundaries WHERE name = 'Egypt'").get();
  const geometry = JSON.parse(String(row.geometry));
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons
    .map((polygon) => clipRing(polygon[0], bbox).map(([lon, lat]) => [round(lon, 3), round(lat, 3)]))
    .map((ring) => ring.filter((p, i) => i === 0 || p[0] !== ring[i - 1][0] || p[1] !== ring[i - 1][1]))
    .filter((ring) => ring.length >= 3);
}

/** @param {DatabaseSync} db @param {string} regionId @param {string} from @param {string} to */
function rawDuplicates(db, regionId, from, to) {
  const sources = db.prepare("SELECT DISTINCT source FROM raw_hotspots WHERE region_id = ?").all(regionId).map((r) => String(r.source));
  // Same key as normalize: one hotspot_id per satellite, date, time and position at 5 decimals.
  const query = db.prepare(
    `SELECT substr(acq_date, 1, 7) AS month, COUNT(*) - 1 AS extra FROM raw_hotspots
     WHERE region_id = ? AND source = ? AND acq_date BETWEEN ? AND ?
     GROUP BY satellite, acq_date, acq_time, printf('%.5f', latitude), printf('%.5f', longitude) HAVING COUNT(*) > 1`,
  );
  /** @type {Record<string, number>} */
  const byMonth = {};
  for (const source of sources) {
    for (const row of query.all(regionId, source, from, to)) byMonth[String(row.month)] = (byMonth[String(row.month)] ?? 0) + Number(row.extra);
  }
  return byMonth;
}

/**
 * One day of in-box detections with everything the pipeline decided about each.
 * @param {DatabaseSync} db
 * @param {{ region: { id: string, name: string, bbox: number[] }, day: string, method: string, closeUpKm: number,
 *   places: { name: string, lat: number, lon: number }[] }} options
 */
export function oneDaySample(db, { region, day, method, closeUpKm, places }) {
  const rowsQuery = db.prepare(
    `SELECT h.hotspot_id, h.satellite, h.sensor, h.acq_utc, h.lat, h.lon, h.frp_mw, h.fire_type, h.daynight, h.scan_km, h.track_km,
            h.cell_id, s.role, s.in_series, m.label, w.weight
     FROM hotspots h LEFT JOIN series s USING (hotspot_id) LEFT JOIN matchups m USING (hotspot_id)
       LEFT JOIN weights w ON w.hotspot_id = h.hotspot_id AND w.method = ?
     WHERE h.region_id = ? AND h.satellite = ? AND h.acq_date = ? AND h.in_box = 1`,
  );
  const raw = SATELLITES.flatMap((satellite) => rowsQuery.all(method, region.id, satellite, day));
  raw.sort((a, b) => String(a.acq_utc).localeCompare(String(b.acq_utc)) || Number(a.lon) - Number(b.lon));
  const rows = raw.map((r) => {
    const modis = r.sensor === "MODIS";
    // The page works the 5 km cell out from lat and lon, so the sample does not carry it.
    if (cellOf(Number(r.lat), Number(r.lon)) !== Number(r.cell_id)) throw new Error(`cell of ${r.hotspot_id} differs from the grid rule`);
    return {
      sat: String(r.satellite),
      time: String(r.acq_utc).slice(11, 16),
      lat: Number(r.lat),
      lon: Number(r.lon),
      frp: Number(r.frp_mw),
      type: r.fire_type === null ? null : Number(r.fire_type),
      night: r.daynight === "N",
      role: String(r.role),
      label: r.label === null ? null : Number(r.label),
      weight: modis ? (Number(r.in_series) === 1 ? 1 : null) : round(r.weight === null ? null : Number(r.weight), 4),
      ...(modis ? { scan: Number(r.scan_km), track: Number(r.track_km) } : {}),
    };
  });

  const ym = Number(day.slice(0, 4)) * 100 + Number(day.slice(5, 7));
  const first = `${day.slice(0, 7)}-01`;
  const length = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate();
  const last = `${day.slice(0, 7)}-${String(length).padStart(2, "0")}`;
  const dayQuery = db.prepare(
    `SELECT h.acq_date AS date, SUM(CASE WHEN h.sensor = 'MODIS' THEN 1 ELSE w.weight END) AS total
     FROM hotspots h JOIN series s USING (hotspot_id) LEFT JOIN weights w ON w.hotspot_id = h.hotspot_id AND w.method = ?
     WHERE h.region_id = ? AND h.satellite = ? AND h.acq_date BETWEEN ? AND ? AND h.in_box = 1 AND s.in_series = 1
     GROUP BY h.acq_date`,
  );
  const exact = new Array(length).fill(0);
  for (const satellite of SATELLITES) {
    for (const row of dayQuery.all(method, region.id, satellite, first, last)) exact[Number(String(row.date).slice(8, 10)) - 1] += Number(row.total ?? 0);
  }

  const factorTable = method === "model_v1" ? "k_factors" : "ratio_factors";
  const factorColumn = method === "model_v1" ? "k" : "factor";
  const factor = db
    .prepare(`SELECT ${factorColumn} AS value, level FROM ${factorTable} WHERE region_id = ? AND month = ? AND satellite = 'S-NPP'`)
    .get(region.id, Number(day.slice(5, 7)));

  const nearby = rawDuplicates(db, region.id, addDays(day, -1), addDays(day, 1));
  const everywhere = rawDuplicates(db, region.id, "0000-01-01", "9999-12-31");

  return {
    region: { id: region.id, name: region.name, bbox: region.bbox },
    date: day,
    method,
    factor: factor ? { value: round(Number(factor.value), 4), level: String(factor.level) } : null,
    duplicates: {
      day: Object.values(rawDuplicates(db, region.id, day, day)).reduce((a, b) => a + b, 0),
      nearby: Object.values(nearby).reduce((a, b) => a + b, 0),
      regionByMonth: everywhere,
    },
    closeUp: closeUpBox(rows, closeUpKm),
    land: landInBox(db, region.bbox),
    places,
    month: {
      ym,
      name: `${MONTH_NAMES[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`,
      days: exact.map((v) => round(v, 4)),
      total: round(exact.reduce((a, b) => a + b, 0), 4),
    },
    rows,
  };
}

/**
 * A square `km` across around the MODIS detection whose surroundings hold the most VIIRS fires
 * MODIS saw, then the most VIIRS fires: where the Match step has the most to show.
 * @param {{ sat: string, lat: number, lon: number, label: number | null, role: string, scan?: number }[]} rows
 * @param {number} km
 */
function closeUpBox(rows, km) {
  const half = km / 2;
  const window = (center) => {
    const dLat = half / KM_PER_DEG;
    const dLon = half / (KM_PER_DEG * Math.cos((center.lat * Math.PI) / 180));
    return [round(center.lon - dLon, 4), round(center.lat - dLat, 4), round(center.lon + dLon, 4), round(center.lat + dLat, 4)];
  };
  let best = null;
  for (const center of rows.filter((r) => r.scan !== undefined)) {
    const box = window(center);
    const inside = rows.filter((r) => r.scan === undefined && IN_SERIES.has(r.role) && r.lon >= box[0] && r.lon <= box[2] && r.lat >= box[1] && r.lat <= box[3]);
    const score = inside.filter((r) => (r.label ?? 0) > 0).length * 1000 + inside.length;
    if (!best || score > best.score) best = { score, box };
  }
  return best?.box ?? null;
}

/**
 * 90 days of every detection in a small box of persistence spots around a static source.
 * @param {DatabaseSync} db
 * @param {{ regionId: string, lat: number, lon: number, start: string, halfSpots: number }} options
 */
export function flareSample(db, { regionId, lat, lon, start, halfSpots }) {
  const params = artifact(db, "static_mask:report").params;
  const spot = Number(params.bucket_deg);
  const days = Number(params.window_days);
  const end = addDays(start, days - 1);
  const source = db
    .prepare("SELECT lat, lon, n_days, fire_type FROM static_sources WHERE region_id = ? ORDER BY (lat - ?) * (lat - ?) + (lon - ?) * (lon - ?) LIMIT 1")
    .get(regionId, lat, lat, lon, lon);
  if (!source || Math.hypot(Number(source.lat) - lat, Number(source.lon) - lon) > 0.01) throw new Error(`no static source near ${lat}, ${lon}`);
  const row0 = Math.floor(Number(source.lat) / spot) - halfSpots;
  const col0 = Math.floor(Number(source.lon) / spot) - halfSpots;
  const n = 2 * halfSpots;
  const query = db.prepare(
    `SELECT h.hotspot_id, h.acq_utc, h.acq_date, h.lat, h.lon, h.daynight, k.reason
     FROM hotspots h LEFT JOIN static_mask k USING (hotspot_id)
     WHERE h.region_id = ? AND h.satellite = ? AND h.acq_date BETWEEN ? AND ? AND h.lat BETWEEN ? AND ? AND h.lon BETWEEN ? AND ?`,
  );
  const pad = spot / 10;
  const found = SATELLITES.flatMap((satellite) =>
    query.all(regionId, satellite, start, end, row0 * spot - pad, (row0 + n) * spot + pad, col0 * spot - pad, (col0 + n) * spot + pad),
  )
    .filter((r) => {
      const row = Math.floor(Number(r.lat) / spot) - row0;
      const col = Math.floor(Number(r.lon) / spot) - col0;
      return row >= 0 && row < n && col >= 0 && col < n;
    })
    .sort((a, b) => String(a.acq_utc).localeCompare(String(b.acq_utc)));
  /** @type {Record<string, number>} */
  const masked = {};
  for (const r of found) if (r.reason) masked[String(r.reason)] = (masked[String(r.reason)] ?? 0) + 1;
  const dayIndex = (iso) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 864e5) + 1;
  return {
    region: regionId,
    start,
    days,
    rule: { spotDeg: spot, minDays: Number(params.min_days), windowDays: days, radiusKm: Number(params.radius_km) },
    source: { lat: round(Number(source.lat), 5), lon: round(Number(source.lon), 5), nDays: Number(source.n_days), type: Number(source.fire_type) },
    box: { row0, col0, rows: n, cols: n },
    masked,
    // Positions in 1e-5 degrees from the box's south-west corner: FIRMS gives at most 5 decimals.
    rows: found.map((r) => {
      const dLat = Math.round(Number(r.lat) * 1e5) - row0 * spot * 1e5;
      const dLon = Math.round(Number(r.lon) * 1e5) - col0 * spot * 1e5;
      const unit = Math.round(spot * 1e5);
      if (Math.floor(dLat / unit) !== Math.floor(Number(r.lat) / spot) - row0 || Math.floor(dLon / unit) !== Math.floor(Number(r.lon) / spot) - col0) {
        throw new Error(`${r.hotspot_id} would change spot when stored in 1e-5 degrees`);
      }
      return [dayIndex(String(r.acq_date)), Math.round(dLat), Math.round(dLon), r.daynight === "N" ? 1 : 0];
    }),
  };
}

/** A module exporting `value` as `name`, with the array under `rowsKey` one item per line. */
export function moduleText(name, value, rowsKey = "rows") {
  const { [rowsKey]: rows, ...rest } = value;
  const head = Object.entries(rest).map(([key, item]) => `  ${JSON.stringify(key)}: ${JSON.stringify(item)},`);
  const body = rows.map((row) => `    ${JSON.stringify(row)}`).join(",\n");
  return (
    "// Generated by web/scripts/make-method-samples.js from the pipeline database. Do not edit.\n" +
    `export const ${name} = {\n${head.join("\n")}\n  ${JSON.stringify(rowsKey)}: [\n${body}\n  ],\n};\n`
  );
}

function main(argv) {
  const path = resolve(WEB_DIR, argv[0] ?? process.env.HOTORNOT_DB ?? "../pipeline/data/hotornot.sqlite");
  const regions = JSON.parse(readFileSync(REGIONS_FILE, "utf8")).regions;
  const region = regions.find((r) => r.id === CHOICES.region);
  const db = openDb(path);
  try {
    const method = String(artifact(db, "publish:report").method);
    const day = oneDaySample(db, { region, day: CHOICES.day, method, closeUpKm: CHOICES.closeUpKm, places: CHOICES.places });
    const flare = flareSample(db, { regionId: region.id, ...CHOICES.flare });
    mkdirSync(OUT_DIR, { recursive: true });
    const files = [
      ["one-day.js", moduleText("ONE_DAY", day)],
      ["flare.js", moduleText("FLARE", flare)],
    ];
    for (const [name, text] of files) {
      writeFileSync(join(OUT_DIR, name), text);
      console.log(`${name}: ${Buffer.byteLength(text)} bytes`);
    }
    const viirs = day.rows.filter((r) => r.scan === undefined);
    console.log(
      `${day.date}: ${day.rows.length} detections (${day.rows.length - viirs.length} MODIS, ${viirs.length} VIIRS), ` +
        `${day.rows.filter((r) => r.type !== 0).length} not vegetation, ${day.duplicates.day} duplicates (${day.duplicates.nearby} on the days either side); ` +
        `day ${day.month.days[Number(day.date.slice(8)) - 1]} of ${day.month.name} ${day.month.total}`,
    );
    console.log(`flare: ${flare.rows.length} detections from ${flare.start} over ${flare.days} days; masked by the pipeline ${JSON.stringify(flare.masked)}`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
