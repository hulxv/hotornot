// The two explorable widgets in "From raw data to the calendar": one real day through the
// pipeline, and the Clean step's gas-flare rule over 90 days. Pure state functions and SVG/HTML
// strings first; mountExplorables at the end wires them to the page.
import { GRID_DEG } from "../../shared/contracts.js";
import { formatWeight } from "../map/point-info.js";
import { formatMw } from "./diagrams.js";
import { escapeHtml } from "./html.js";
import { FLARE } from "./samples/flare.js";
import { ONE_DAY } from "./samples/one-day.js";
import { formatDate } from "./transform.js";

const MODIS = new Set(["Terra", "Aqua"]);
const IN_SERIES = new Set(["modis", "snpp", "n20_gapfill", "n20"]);
// The 0.05° grid: the cell of a point, and a cell's center as [lon, lat].
const COLS = Math.round(360 / GRID_DEG);
const gridIndex = (deg) => Math.floor(Math.round(deg / GRID_DEG * 1e6) / 1e6);
const cellOf = (lat, lon) => gridIndex(lat + 90) * COLS + gridIndex(lon + 180);
const cellCenter = (id) => [((id % COLS) + 0.5) * GRID_DEG - 180, (Math.floor(id / COLS) + 0.5) * GRID_DEG - 90];
const KM_PER_DEG = 111.195;
const round1 = (x) => Math.round(x * 10) / 10;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const two = (x) => x.toFixed(2);
const oneDecimal = (x) => x.toFixed(1);
const percent = (x) => `${(x * 100).toFixed(1)}%`;
const shortDate = (iso) => formatDate(iso).replace(/ \d{4}$/, "");
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/** @typedef {typeof import("./samples/one-day.js").ONE_DAY} DaySample */
/** @typedef {DaySample["rows"][number]} DayRow */

export const DAY_STEPS = Object.freeze([
  Object.freeze({ id: "arrive", name: "Arrive", pipe: "download" }),
  Object.freeze({ id: "clean", name: "Clean", pipe: "clean" }),
  Object.freeze({ id: "match", name: "Match", pipe: "match" }),
  Object.freeze({ id: "weigh", name: "Weigh", pipe: "learn" }),
  Object.freeze({ id: "add", name: "Add up", pipe: "weigh" }),
]);
export const STEP = Object.freeze({ arrive: 0, clean: 1, match: 2, weigh: 3, add: 4 });

/** The widget step a step of the pipeline diagram jumps to, or -1 when none applies. @param {string} pipeId */
export const stepForPipe = (pipeId) => DAY_STEPS.findIndex((step) => step.pipe === pipeId);

/** "MODIS saw it", "missed it", or not covered by a MODIS look within 15 minutes. @param {DayRow} row */
function matchOf(row) {
  if (MODIS.has(row.sat) || !IN_SERIES.has(row.role)) return null;
  if (row.label === null) return "unseen";
  return row.label > 0 ? "saw" : "missed";
}

/**
 * Everything the steps need, worked out once from the sample.
 * @param {DaySample} sample
 */
export function dayModel(sample) {
  const rows = sample.rows.map((row, index) => ({
    ...row,
    index,
    inSeries: IN_SERIES.has(row.role),
    cell: cellOf(row.lat, row.lon),
    modis: MODIS.has(row.sat),
    aside: row.role === "non_vegetation" || row.role === "static_masked",
    match: matchOf(row),
  }));
  /** @type {Map<number, { cell: number, sum: number, n: number }>} */
  const cells = new Map();
  for (const row of rows) {
    if (!row.inSeries || row.weight === null) continue;
    const cell = cells.get(row.cell) ?? { cell: row.cell, sum: 0, n: 0 };
    cell.sum += row.weight;
    cell.n += 1;
    cells.set(row.cell, cell);
  }
  const bySat = new Map();
  for (const row of rows) bySat.set(row.sat, (bySat.get(row.sat) ?? 0) + 1);
  const dayIndex = Number(sample.date.slice(8, 10)) - 1;
  return {
    sample,
    rows,
    cells: [...cells.values()].sort((a, b) => b.sum - a.sum),
    bySat,
    dayIndex,
    total: rows.reduce((sum, row) => sum + (row.inSeries && row.weight !== null ? row.weight : 0), 0),
  };
}

/** @typedef {ReturnType<typeof dayModel>} DayModel */

/**
 * The widget at step `step` (0 to 4): its words, counters, log and what each detection shows.
 * @param {DayModel} model
 * @param {number} step
 */
export function dayState(model, step) {
  const s = Math.min(Math.max(0, Math.round(step)), DAY_STEPS.length - 1);
  const { sample, rows } = model;
  const arrived = rows.length;
  const aside = rows.filter((row) => row.aside);
  const modis = rows.filter((row) => row.modis);
  const viirs = rows.filter((row) => row.match !== null);
  const saw = viirs.filter((row) => row.match === "saw").length;
  const missed = viirs.filter((row) => row.match === "missed").length;
  const unseen = viirs.length - saw - missed;
  const duplicates = sample.duplicates.day;
  const date = formatDate(sample.date);
  const monthName = sample.month.name;
  const share = sample.month.total > 0 ? model.total / sample.month.total : 0;
  const satellites = [...model.bySat].map(([sat, n]) => `${n} from ${MODIS.has(sat) ? "MODIS" : "VIIRS"} on ${sat}`).join(", ");
  const looked = unseen === 0 ? `all ${viirs.length}` : `${saw + missed} of the ${viirs.length}`;
  const duplicateText =
    duplicates === 0
      ? "No record arrived twice this day, so there were no duplicates to remove."
      : `${plural(duplicates, "record")} arrived twice and the copies were removed.`;
  const factor = sample.factor ? `, times the Nile Delta's factor for ${monthName.split(" ")[0]} (${two(sample.factor.value)})` : "";

  const words = [
    {
      text: `Everything the satellites spotted over the Nile Delta on ${date}: ${arrived} detections. Gray dots come from MODIS, the older camera, white dots from VIIRS, the newer one.`,
      log: [`${arrived} detections arrived: ${satellites}.`],
    },
    {
      text: `NASA's archive marks ${aside.length} of them as steady heat sources, such as gas flares at oil and gas sites. They are not vegetation fires, so they step aside. ${duplicateText}`,
      log: [
        duplicates === 0 ? "Removed 0 duplicates: this day had none." : `Removed ${plural(duplicates, "duplicate")}.`,
        `Set aside ${plural(aside.length, "steady heat source")} (gas flares and the like).`,
      ],
    },
    {
      text: `MODIS looked at the same places within 15 minutes of VIIRS. It saw ${saw} of the ${viirs.length} VIIRS fires and missed ${missed}${unseen ? `; ${unseen} it did not look at in time` : ""}. The close-up shows MODIS's squares at their real size, about 1 km across.`,
      log: [`MODIS looked at ${looked} VIIRS fires within 15 minutes: saw ${saw}, missed ${missed}.`],
    },
    {
      text: `Each VIIRS fire shrinks to its weight: the chance MODIS would have seen a fire that strong${factor}. MODIS's own dots are not added: since 2012 they are only the yardstick.`,
      log: [`Weighed ${viirs.length} VIIRS fires: together they count as ${two(model.total)} MODIS detections.`],
    },
    {
      text: `The weights add up in 5 km squares, and the squares add up to ${two(model.total)} for the day. ${monthName} comes to ${oneDecimal(sample.month.total)} on the calendar, and this day is ${percent(share)} of it.`,
      log: [`Added ${two(model.total)} to ${monthName}, which comes to ${oneDecimal(sample.month.total)} (this day is ${percent(share)}).`],
    },
  ];

  return {
    step: s,
    id: DAY_STEPS[s].id,
    name: DAY_STEPS[s].name,
    title: `Step ${s + 1} of ${DAY_STEPS.length}: ${DAY_STEPS[s].name}`,
    text: words[s].text,
    log: words.slice(0, s + 1).flatMap((w, i) => w.log.map((text) => ({ text, latest: i === s }))),
    counters: {
      arrived,
      duplicates: s >= STEP.clean ? duplicates : 0,
      setAside: s >= STEP.clean ? aside.length : 0,
      detections: s >= STEP.clean ? arrived - duplicates - aside.length : arrived,
      modis: modis.length,
      viirs: viirs.length,
      weighed: s >= STEP.weigh ? model.total : null,
    },
    match: s >= STEP.match ? { saw, missed, unseen } : null,
    cells: s >= STEP.add ? model.cells : null,
    day: s >= STEP.add ? { total: model.total, month: sample.month.total, share } : null,
  };
}

/** @typedef {ReturnType<typeof dayState>} DayState */

/** @param {[string, string | number][]} items */
const countersHtml = (items) => items.map(([name, value]) => `<div><dt>${name}</dt><dd>${value}</dd></div>`).join("");

/** The counters as `<dt>`/`<dd>` pairs. @param {DayState} state */
export const dayCountersHtml = ({ counters: c }) =>
  countersHtml([
    ["Detections", c.detections],
    ["Set aside", c.setAside],
    ["Weighed total", c.weighed === null ? "not yet" : two(c.weighed)],
  ]);

/** @param {DayState} state */
export function dayProgressHtml(state) {
  return DAY_STEPS.map(
    (step, i) => `<li${i === state.step ? ' aria-current="step"' : ""}${i < state.step ? ' class="done"' : ""}>${escapeHtml(step.name)}</li>`,
  ).join("");
}

/** @param {DayState} state */
export function dayLogHtml(state) {
  return state.log.map((line) => `<li${line.latest ? ' class="latest"' : ""}>${escapeHtml(line.text)}</li>`).join("");
}

/** A sentence for screen readers: the step, the counters and what changed. @param {DayModel} model @param {DayState} state */
export function describeDay(model, state) {
  const c = state.counters;
  const parts = [`${state.title}.`, state.text, `${c.detections} detections on the map, ${c.setAside} set aside.`];
  if (c.weighed !== null) parts.push(`Weighed total ${two(c.weighed)}.`);
  return parts.join(" ");
}

/**
 * What one detection shows at this step, for the picker under the maps.
 * @param {DayModel} model
 * @param {DayState} state
 * @param {number} index
 */
export function pickText(model, state, index) {
  const row = model.rows[index];
  if (!row) return "";
  const camera = row.modis ? "MODIS" : "VIIRS";
  const base = `${row.sat} (${camera}), ${row.night ? "night" : "day"} pass at ${row.time} UTC, fire strength ${formatMw(row.frp)}.`;
  const s = state.step;
  let more = "";
  if (row.aside) {
    more = s >= STEP.clean ? "NASA marks it a steady heat source, such as a gas flare: set aside." : "";
  } else if (row.modis) {
    if (s === STEP.match) more = `A MODIS detection. Its square is about ${row.scan?.toFixed(1)} by ${row.track?.toFixed(1)} km.`;
    else if (s >= STEP.weigh) more = "Not added: since 2012 MODIS is only the yardstick.";
  } else if (s === STEP.clean) {
    more = "A vegetation fire: kept.";
  } else if (s === STEP.match) {
    more =
      row.match === "saw"
        ? `MODIS looked within 15 minutes and saw it${row.label < 1 ? `, in a square it shares with ${row.label === 0.5 ? "another VIIRS fire" : "other VIIRS fires"}` : ""}.`
        : row.match === "missed"
          ? "MODIS looked within 15 minutes and missed it."
          : "MODIS did not look here within 15 minutes.";
  } else if (s === STEP.weigh) {
    more = `${formatWeight(row.weight, row.sat)}.`;
  } else if (s === STEP.add) {
    const cell = model.cells.find((c) => c.cell === row.cell);
    if (cell) more = `${formatWeight(row.weight, row.sat)}. Its 5 km square adds up to ${two(cell.sum)} from ${plural(cell.n, "fire")}.`;
  }
  return more ? `${base} ${more}` : base;
}

/** The detection the picker starts on: the strongest VIIRS fire MODIS saw inside the close-up. @param {DayModel} model */
export function defaultPick(model) {
  const box = model.sample.closeUp;
  const inside = (row) => !box || (row.lon >= box[0] && row.lon <= box[2] && row.lat >= box[1] && row.lat <= box[3]);
  const candidates = model.rows.filter((row) => row.match === "saw" && inside(row)).sort((a, b) => b.frp - a.frp);
  return candidates[0]?.index ?? 0;
}

/** Height of a map of `bbox` drawn `width` px wide, east-west distances scaled to the box's middle. @param {number[]} bbox @param {number} width */
export function mapHeight(bbox, width) {
  const kx = Math.cos((((bbox[1] + bbox[3]) / 2) * Math.PI) / 180);
  return (width * (bbox[3] - bbox[1])) / ((bbox[2] - bbox[0]) * kx);
}

function projector(bbox, width, height) {
  const [west, south, east, north] = bbox;
  return {
    x: (lon) => ((lon - west) / (east - west)) * width,
    y: (lat) => ((north - lat) / (north - south)) * height,
    km: width / ((east - west) * KM_PER_DEG * Math.cos((((south + north) / 2) * Math.PI) / 180)),
  };
}

/** A scale bar of `km`, labelled, at the map's lower left. */
function scaleBar(px, km, height) {
  const y = round1(height - 10);
  const len = round1(px * km);
  return (
    `<path class="ex-scale" d="M10 ${y}H${round1(10 + len)}M10 ${round1(y - 4)}V${y}M${round1(10 + len)} ${round1(y - 4)}V${y}"/>` +
    `<text class="dg-small" x="${round1(14 + len)}" y="${y}">${km} km</text>`
  );
}

const TRAY = 30;

/**
 * Where each set-aside detection sits in the strip under the main map.
 * @param {number} count
 * @param {number} width
 * @param {number} top
 */
export function trayPlaces(count, width, top) {
  const left = 82;
  const step = count > 1 ? Math.min(16, (width - left - 10) / (count - 1)) : 0;
  return Array.from({ length: count }, (_, k) => ({ x: round1(left + k * step), y: round1(top + TRAY / 2) }));
}

/**
 * The main map (`view` "map") or the close-up ("closeUp") at this step. With `animate`, the
 * change this step makes moves: set-aside dots travel to the strip, VIIRS dots shrink, squares
 * fade in. The page's CSS turns that off under reduced motion.
 * @param {DayModel} model
 * @param {DayState} state
 * @param {{ width: number, view?: "map" | "closeUp", pick?: number | null, animate?: boolean }} options
 */
export function dayMapSvg(model, state, { width, view = "map", pick = null, animate = false }) {
  const main = view === "map";
  const bbox = main ? model.sample.region.bbox : model.sample.closeUp;
  if (!bbox) return "";
  const w = Math.max(120, Math.round(width));
  const mapH = Math.round(mapHeight(bbox, w));
  const height = main ? mapH + TRAY : mapH;
  const p = projector(bbox, w, mapH);
  const s = state.step;
  const r = main ? Math.min(5, Math.max(3, w / 150)) : 7;
  const inBox = (row) => row.lon >= bbox[0] && row.lon <= bbox[2] && row.lat >= bbox[1] && row.lat <= bbox[3];
  const parts = [`<rect class="ex-sea" width="${w}" height="${mapH}"/>`];

  for (const ring of model.sample.land) {
    parts.push(`<path class="ex-land" d="${ring.map(([lon, lat], i) => `${i ? "L" : "M"}${round1(p.x(lon))} ${round1(p.y(lat))}`).join("")}Z"/>`);
  }
  if (main) {
    parts.push(`<text class="dg-small dg-muted" x="${round1(w * 0.36)}" y="16">Mediterranean Sea</text>`);
    for (const place of model.sample.places) {
      const x = round1(p.x(place.lon));
      const y = round1(p.y(place.lat));
      parts.push(`<circle class="ex-place" cx="${x}" cy="${y}" r="2.5"/><text class="dg-small dg-muted" x="${x}" y="${round1(y + 14)}" text-anchor="middle">${escapeHtml(place.name)}</text>`);
    }
    const box = model.sample.closeUp;
    if (box) {
      parts.push(
        `<rect class="ex-frame" x="${round1(p.x(box[0]))}" y="${round1(p.y(box[3]))}" width="${round1(p.x(box[2]) - p.x(box[0]))}" height="${round1(p.y(box[1]) - p.y(box[3]))}"/>`,
      );
    }
  }

  if (s >= STEP.add) {
    const max = Math.max(...model.cells.map((c) => c.sum));
    const half = GRID_DEG / 2;
    if (!main) {
      let grid = "";
      for (let lon = Math.ceil(bbox[0] / GRID_DEG) * GRID_DEG; lon < bbox[2]; lon += GRID_DEG) grid += `M${round1(p.x(lon))} 0V${mapH}`;
      for (let lat = Math.ceil(bbox[1] / GRID_DEG) * GRID_DEG; lat < bbox[3]; lat += GRID_DEG) grid += `M0 ${round1(p.y(lat))}H${w}`;
      parts.push(`<path class="ex-cellgrid" d="${grid}"/>`);
    }
    for (const cell of model.cells) {
      const [lon, lat] = cellCenter(cell.cell);
      if (lon + half < bbox[0] || lon - half > bbox[2] || lat + half < bbox[1] || lat - half > bbox[3]) continue;
      const x0 = Math.max(0, p.x(lon - half));
      const x1 = Math.min(w, p.x(lon + half));
      const y0 = Math.max(0, p.y(lat + half));
      const y1 = Math.min(mapH, p.y(lat - half));
      const opacity = main ? 0.35 + 0.65 * (cell.sum / max) : 0.12 + 0.18 * (cell.sum / max);
      parts.push(
        `<rect class="ex-cell${animate ? " ex-anim-in" : ""}" x="${round1(x0)}" y="${round1(y0)}" width="${round1(x1 - x0)}" height="${round1(y1 - y0)}" fill-opacity="${opacity.toFixed(2)}"/>`,
      );
      if (!main && x1 - x0 > 40 && y1 - y0 > 24) {
        parts.push(`<text class="ex-cell-sum" x="${round1((x0 + x1) / 2)}" y="${round1(y0 + 18)}" text-anchor="middle">${two(cell.sum)}</text>`);
      }
    }
  }

  if (s >= STEP.match) {
    for (const row of model.rows) {
      if (!row.modis || row.scan === undefined || !inBox(row)) continue;
      const halfW = (row.scan / 2) * p.km;
      const halfH = (row.track / 2) * p.km;
      const size = (v) => round1(Math.max(2, 2 * v));
      parts.push(
        `<rect class="ex-foot" x="${round1(p.x(row.lon) - Math.max(1, halfW))}" y="${round1(p.y(row.lat) - Math.max(1, halfH))}" width="${size(halfW)}" height="${size(halfH)}"/>`,
      );
    }
  }

  const tray = main ? trayPlaces(model.rows.filter((row) => row.aside).length, w, mapH) : [];
  if (main && s >= STEP.clean) {
    parts.push(`<path class="ex-tray" d="M0 ${mapH + 0.5}H${w}"/><text class="dg-small dg-muted" x="8" y="${round1(mapH + TRAY / 2 + 4)}">Set aside</text>`);
  }
  /** @type {Map<number, { x: number, y: number, r: number }>} */
  const where = new Map();
  let k = 0;
  for (const row of model.rows) {
    const x = round1(p.x(row.lon));
    const y = round1(p.y(row.lat));
    if (row.aside && s >= STEP.clean) {
      const place = tray[k++];
      if (!place) continue;
      const move = animate && s === STEP.clean ? ` ex-anim-aside" style="--dx: ${round1(x - place.x)}px; --dy: ${round1(y - place.y)}px` : "";
      parts.push(`<circle class="ex-dot ex-aside${move}" cx="${place.x}" cy="${place.y}" r="${round1(r * 0.8)}" data-i="${row.index}"/>`);
      where.set(row.index, { x: place.x, y: place.y, r: r * 0.8 });
      continue;
    }
    if (!inBox(row)) continue;
    if (row.modis) {
      const reference = s >= STEP.weigh ? " ex-reference" : "";
      parts.push(`<circle class="ex-dot ex-modis${reference}" cx="${x}" cy="${y}" r="${round1(r)}" data-i="${row.index}"/>`);
      where.set(row.index, { x, y, r });
      continue;
    }
    if (s >= STEP.add) {
      where.set(row.index, { x, y, r: main ? 2 : 4 });
      if (!main) parts.push(`<circle class="ex-dot ex-viirs ex-added" cx="${x}" cy="${y}" r="${round1(Math.max(1, r * Math.sqrt(row.weight ?? 0)))}" data-i="${row.index}"/>`);
      continue;
    }
    let cls = "ex-viirs";
    let radius = r;
    let extra = "";
    if (s === STEP.match) cls += row.match === "saw" ? " ex-saw" : " ex-missed";
    if (s === STEP.weigh) {
      radius = Math.max(main ? 0.8 : 1, r * Math.sqrt(row.weight ?? 0));
      if (animate) extra = ` ex-anim-shrink" style="--s0: ${(r / radius).toFixed(2)}`;
    }
    parts.push(`<circle class="ex-dot ${cls}${extra}" cx="${x}" cy="${y}" r="${round1(radius)}" data-i="${row.index}"/>`);
    where.set(row.index, { x, y, r: radius });
  }
  const picked = pick === null ? null : where.get(pick);
  if (picked) parts.push(`<circle class="ex-pick" cx="${picked.x}" cy="${picked.y}" r="${round1(Math.max(picked.r, 3) + 4)}"/>`);
  parts.push(scaleBar(p.km, main ? 50 : 1, mapH));

  const c = state.counters;
  const label = main
    ? `Map of the Nile Delta on ${formatDate(model.sample.date)}, ${state.title}: ${c.detections} detections on the map, ${c.setAside} set aside${c.weighed === null ? "" : `, weighed total ${two(c.weighed)}`}.`
    : `Close-up ${Math.round((bbox[2] - bbox[0]) * KM_PER_DEG * Math.cos((((bbox[1] + bbox[3]) / 2) * Math.PI) / 180))} km across around one MODIS detection, ${state.title}.`;
  return (
    `<svg class="ex-svg" viewBox="0 0 ${w} ${height}" width="${w}" height="${height}" role="img" aria-label="${escapeHtml(label)}">` +
    `${parts.join("")}</svg>`
  );
}

/**
 * Each day's total of the month, the sample's day marked: dashed until the Add up step.
 * @param {DayModel} model
 * @param {DayState} state
 * @param {{ width: number }} options
 */
export function monthSvg(model, state, { width }) {
  const w = Math.max(200, Math.round(width));
  const height = 110;
  const m = { left: 8, right: 8, top: 24, bottom: 22 };
  const days = model.sample.month.days;
  const max = Math.max(...days);
  const slot = (w - m.left - m.right) / days.length;
  const plotH = height - m.top - m.bottom;
  const added = state.step >= STEP.add;
  const bars = days
    .map((value, i) => {
      const h = Math.max(1, (value / max) * plotH);
      const x = round1(m.left + i * slot + 1);
      const y = round1(m.top + plotH - h);
      const cls = i === model.dayIndex ? (added ? "ex-bar-day" : "ex-bar-wait") : "ex-bar";
      return `<rect class="${cls}" x="${x}" y="${y}" width="${round1(Math.max(1, slot - 2))}" height="${round1(h)}"/>`;
    })
    .join("");
  const ticks = [0, 9, 19, days.length - 1]
    .map((i) => `<text class="dg-small dg-muted" x="${round1(m.left + (i + 0.5) * slot)}" y="${height - 6}" text-anchor="middle">${i + 1}</text>`)
    .join("");
  const dx = m.left + (model.dayIndex + 0.5) * slot;
  const dy = m.top + plotH - (days[model.dayIndex] / max) * plotH - 6;
  const tag = added ? `<text class="dg-label" x="${round1(dx)}" y="${round1(dy)}" text-anchor="middle">${two(days[model.dayIndex])}</text>` : "";
  const date = formatDate(model.sample.date);
  const label =
    `Each day of ${model.sample.month.name}, as counted for the calendar. ` +
    (added ? `${date} adds ${two(days[model.dayIndex])} of the month's ${oneDecimal(model.sample.month.total)}.` : `${date} is not added yet.`);
  return (
    `<svg class="ex-svg" viewBox="0 0 ${w} ${height}" width="${w}" height="${height}" role="img" aria-label="${escapeHtml(label)}">` +
    `${bars}${ticks}${tag}</svg>`
  );
}

/** The line under the month's bars. @param {DayModel} model @param {DayState} state */
export function monthText(model, state) {
  const { name, total } = model.sample.month;
  if (state.step < STEP.add) return `Each bar is one day of ${name}. Step 5 adds ${shortDate(model.sample.date)} to it.`;
  return `${shortDate(model.sample.date)} adds ${two(model.total)} to ${name}, which comes to ${oneDecimal(total)} on the calendar: ${percent(model.total / total)} of it.`;
}

/** @typedef {typeof import("./samples/flare.js").FLARE} FlareSample */

/**
 * Detections by day and the spot each falls in. A spot is the pipeline's persistence bucket,
 * floor(lat / 0.004) by floor(lon / 0.004); rows give positions in 1e-5 degrees from the box's
 * south-west corner, so a spot is a whole number of those units.
 * @param {FlareSample} sample
 */
export function flareModel(sample) {
  const { spotDeg } = sample.rule;
  const { row0, col0, rows: nRows, cols: nCols } = sample.box;
  const unit = Math.round(spotDeg * 1e5);
  const detections = sample.rows
    .map(([day, dLat, dLon, night]) => ({
      day,
      lat: (row0 * unit + dLat) / 1e5,
      lon: (col0 * unit + dLon) / 1e5,
      night: night === 1,
      row: Math.floor(dLat / unit),
      col: Math.floor(dLon / unit),
    }))
    .filter((d) => d.row >= 0 && d.row < nRows && d.col >= 0 && d.col < nCols && d.day >= 1 && d.day <= sample.days);
  /** @type {Map<string, { row: number, col: number, days: Set<number> }>} */
  const spots = new Map();
  for (const d of detections) {
    const key = `${d.row},${d.col}`;
    const spot = spots.get(key) ?? { row: d.row, col: d.col, days: new Set() };
    spot.days.add(d.day);
    spots.set(key, spot);
  }
  const list = [...spots.values()].map((spot) => ({ row: spot.row, col: spot.col, days: [...spot.days].sort((a, b) => a - b) }));
  return { sample, detections, spots: list };
}

/** @typedef {ReturnType<typeof flareModel>} FlareModel */

/**
 * Day `day` (1 to 90): that day's detections, and for every spot seen so far the days it has
 * shown heat. A spot is flagged on the day its count reaches the rule's 20.
 * @param {FlareModel} model
 * @param {number} day
 */
export function flareState(model, day) {
  const { days, rule, start } = model.sample;
  const d = Math.min(Math.max(1, Math.round(day)), days);
  const today = model.detections.filter((det) => det.day === d);
  const todayKeys = new Set(today.map((det) => `${det.row},${det.col}`));
  const spots = model.spots
    .map((spot) => {
      const seen = spot.days.filter((x) => x <= d).length;
      const flaggedOn = spot.days.length >= rule.minDays ? spot.days[rule.minDays - 1] : null;
      return { row: spot.row, col: spot.col, seen, flagged: flaggedOn !== null && flaggedOn <= d, flaggedOn, today: todayKeys.has(`${spot.row},${spot.col}`) };
    })
    .filter((spot) => spot.seen > 0);
  return {
    day: d,
    of: days,
    date: addDays(start, d - 1),
    today,
    spots,
    flagged: spots.filter((spot) => spot.flagged).length,
    newlyFlagged: spots.filter((spot) => spot.flaggedOn === d),
  };
}

/** @typedef {ReturnType<typeof flareState>} FlareState */

/** @param {FlareState} state */
export const flareCountersHtml = (state) =>
  countersHtml([
    ["Day", `${state.day} of ${state.of}`],
    ["Hot spots seen today", state.today.length],
    ["Spots flagged", state.flagged],
  ]);

/** What happened on this day, in one sentence. @param {FlareModel} model @param {FlareState} state */
export function flareNews(model, state) {
  const when = `Day ${state.day}, ${shortDate(state.date)}:`;
  const { minDays } = model.sample.rule;
  if (state.newlyFlagged.length > 0) {
    const n = state.newlyFlagged.length;
    return `${when} ${n === 1 ? "a spot has" : `${n} spots have`} now shown heat on ${minDays} days. From now on ${n === 1 ? "its" : "their"} detections count as a steady heat source, not a vegetation fire.`;
  }
  if (state.today.length === 0) return `${when} nothing seen in this box.`;
  const lit = state.spots.filter((spot) => spot.today);
  const busiest = Math.max(...lit.map((spot) => spot.seen));
  return lit.length === 1
    ? `${when} ${plural(state.today.length, "hot spot")}, in a spot seen on ${plural(busiest, "day")} so far.`
    : `${when} ${plural(state.today.length, "hot spot")} in ${lit.length} spots; the busiest has been seen on ${plural(busiest, "day")} so far.`;
}

/** @param {FlareModel} model @param {FlareState} state */
export function describeFlare(model, state) {
  const busiest = Math.max(0, ...state.spots.map((spot) => spot.seen));
  return (
    `${flareNews(model, state)} ${plural(state.spots.length, "spot")} seen so far; the busiest on ${plural(busiest, "day")}. ` +
    `${plural(state.flagged, "spot")} flagged as steady heat sources.`
  );
}

/**
 * The flare box at this day: spots shaded by the days they have shown heat, flagged spots in
 * the NOT color, and today's detections. With `animate`, today's detections flash.
 * @param {FlareModel} model
 * @param {FlareState} state
 * @param {{ width: number, animate?: boolean }} options
 */
export function flareSvg(model, state, { width, animate = false }) {
  const { spotDeg, minDays } = model.sample.rule;
  const { row0, col0, rows, cols } = model.sample.box;
  const bbox = [col0 * spotDeg, row0 * spotDeg, (col0 + cols) * spotDeg, (row0 + rows) * spotDeg];
  const w = Math.max(160, Math.round(width));
  const h = Math.round(mapHeight(bbox, w));
  const p = projector(bbox, w, h);
  const cw = w / cols;
  const ch = h / rows;
  let grid = "";
  for (let i = 1; i < cols; i += 1) grid += `M${round1(i * cw)} 0V${h}`;
  for (let i = 1; i < rows; i += 1) grid += `M0 ${round1(i * ch)}H${w}`;
  const parts = [`<rect class="ex-land" width="${w}" height="${h}"/>`, `<path class="ex-spotgrid" d="${grid}"/>`];
  const yOf = (row) => (rows - 1 - row) * ch;
  for (const spot of state.spots) {
    const x = round1(spot.col * cw + 1);
    const y = round1(yOf(spot.row) + 1);
    const fill = spot.flagged ? "" : ` fill-opacity="${(0.05 + 0.2 * Math.min(spot.seen, minDays) / minDays).toFixed(2)}"`;
    parts.push(`<rect class="${spot.flagged ? "ex-spot-flag" : "ex-spot"}" x="${x}" y="${y}" width="${round1(cw - 2)}" height="${round1(ch - 2)}"${fill}/>`);
    if (cw >= 18 && ch >= 16) {
      parts.push(`<text class="ex-spot-n" x="${round1(spot.col * cw + cw / 2)}" y="${round1(yOf(spot.row) + ch / 2 + 4)}" text-anchor="middle">${spot.seen}</text>`);
    }
  }
  const flagged = state.spots.filter((spot) => spot.flagged);
  if (flagged.length > 0) {
    const top = Math.min(...flagged.map((spot) => yOf(spot.row)));
    const left = Math.min(...flagged.map((spot) => spot.col * cw));
    const right = Math.max(...flagged.map((spot) => (spot.col + 1) * cw));
    const y = top > 22 ? top - 8 : Math.max(...flagged.map((spot) => yOf(spot.row) + ch)) + 16;
    const x = Math.min(Math.max((left + right) / 2, 70), w - 70);
    parts.push(`<text class="ex-flag-label" x="${round1(x)}" y="${round1(y)}" text-anchor="middle">Steady heat source</text>`);
  }
  for (const det of state.today) {
    const cls = det.night ? "ex-today-night" : "ex-today";
    parts.push(`<circle class="${cls}${animate ? " ex-flash" : ""}" cx="${round1(p.x(det.lon))}" cy="${round1(p.y(det.lat))}" r="5"/>`);
  }
  parts.push(scaleBar(p.km, 1, h));
  const label = `${state.spots.length} spots seen by day ${state.day} of ${state.of}, ${state.flagged} flagged; ${plural(state.today.length, "hot spot")} today.`;
  return `<svg class="ex-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${escapeHtml(label)}">${parts.join("")}</svg>`;
}

/**
 * The day widget's "For scientists" fold: where each part of the sample comes from.
 * @param {DaySample} sample
 */
export function dayScienceHtml(sample) {
  const modis = sample.rows.filter((row) => MODIS.has(row.sat)).length;
  const elsewhere = Object.entries(sample.duplicates.regionByMonth).map(([month, n]) => `${n} in ${month}`).join(", ");
  const factor = sample.factor ? ` (k = ${sample.factor.value}, level <code>${escapeHtml(sample.factor.level)}</code>)` : "";
  return [
    `Rows: <code>hotspots</code> with <code>in_box = 1</code> in <code>${escapeHtml(sample.region.id)}</code> on ${sample.date}, ${modis} MODIS and ` +
      `${sample.rows.length - modis} VIIRS, joined to <code>series</code>, <code>matchups</code> and <code>weights</code>.`,
    `Clean: FIRMS type other than 0, role <code>non_vegetation</code>. <code>raw_hotspots</code> has ${sample.duplicates.day} duplicates on this day and ` +
      `${sample.duplicates.nearby} on the days either side by the normalize key${elsewhere ? `; the region's only ones are ${elsewhere}` : ""}.`,
    "Match: the <code>matchups</code> label, the 1/m share of the Aqua hotspots on a MYD14 granule within 15 minutes whose pixel, scaled 1.5 times, " +
      "contains the VIIRS point. MODIS from 2012 on (<code>modis_overlap</code>) is never added.",
    `Weigh and add up: <code>${escapeHtml(sample.method)}</code> weights${factor}, the model's share for a fire like this one rather than its own label; ` +
      `in-series weights summed by 0.05° cell and day add up to ${escapeHtml(sample.month.name)}'s calendar value, ${sample.month.total.toFixed(2)}.`,
  ]
    .map((text) => `<p>${text}</p>`)
    .join("");
}

/**
 * The flare widget's "For scientists" fold: the rule as coded, and what the pipeline did here.
 * @param {FlareSample} sample
 */
export function flareScienceHtml(sample) {
  const { spotDeg, minDays, windowDays, radiusKm } = sample.rule;
  const masked = Object.values(sample.masked).reduce((a, b) => a + b, 0);
  return [
    `The <code>persistent</code> rule: a near-real-time detection is set aside when its bucket, floor(lat / ${spotDeg}) by floor(lon / ${spotDeg}), ` +
      `has detections from any satellite on at least ${minDays} distinct days in the ${windowDays} days ending on its date. Here the count starts on day 1; ` +
      "the pipeline also counts the days before.",
    `This place is also a known flare (heat on ${sample.source.nDays} days of NASA's last labelled year), so the pipeline set aside ${masked} of these ` +
      `${sample.rows.length} detections from the first day, as they lie within ${radiusKm} km of it. ${formatDate(sample.start)} to ` +
      `${formatDate(addDays(sample.start, sample.days - 1))}.`,
  ]
    .map((text) => `<p>${text}</p>`)
    .join("");
}

/** The day slider's output: "Day 39 of 90 · 23 September 2026". @param {FlareState} state */
export const flareDayText = (state) => `Day ${state.day} of ${state.of} · ${formatDate(state.date)}`;

// Milliseconds per step for each speed: a pipeline step needs time to read, a day of the flare
// box only a glance.
export const SPEEDS = Object.freeze({
  day: Object.freeze({ slow: 6000, normal: 3500, fast: 1500 }),
  flare: Object.freeze({ slow: 700, normal: 300, fast: 120 }),
});

/** @param {any} element @param {"textContent" | "innerHTML"} key @param {string} value */
const fill = (element, key, value) => {
  if (element) element[key] = value;
};

/** The value a control holds after an input or change event. @param {any} control */
const controlValue = (control) => control?.value ?? control?.getAttribute?.("value") ?? "";

/** Calls `draw(width)` now and whenever the element's width changes. */
function sizer() {
  /** @type {Map<any, { width: number, draw: () => void }>} */
  const items = new Map();
  const observer =
    typeof ResizeObserver === "function"
      ? new ResizeObserver((entries) => {
          for (const entry of entries) {
            const item = items.get(entry.target);
            if (item && entry.target.clientWidth !== item.width) item.draw();
          }
        })
      : null;
  /** @param {any} element @param {(width: number) => void} draw @param {number} fallback */
  return (element, draw, fallback) => {
    const item = {
      width: 0,
      draw() {
        item.width = element.clientWidth;
        draw(item.width || fallback);
      },
    };
    items.set(element, item);
    observer?.observe(element);
    item.draw();
    return item;
  };
}

/**
 * Whether the reader asked for less motion, kept current. `override` replaces the media query
 * (tests, and pages without one).
 * @param {Document} doc
 * @param {boolean | undefined} override
 */
function motionPreference(doc, override) {
  const query = override === undefined ? doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)") : null;
  /** @type {{ reduced: boolean, listeners: (() => void)[] }} */
  const motion = { reduced: override ?? Boolean(query?.matches), listeners: [] };
  query?.addEventListener?.("change", (event) => {
    motion.reduced = event.matches;
    for (const listener of motion.listeners) listener();
  });
  return motion;
}

/**
 * Play/Pause with a speed choice. Play steps at once, then every `speeds[speed]` ms (a new
 * speed applies from now), and starts again from the beginning when it is already at the end.
 * Under reduced motion Play is off; the other controls still work.
 * @param {{ play: any, speed: any, note: any, speeds: Record<string, number>, last: number, index: () => number,
 *   show: (i: number) => void, motion: ReturnType<typeof motionPreference> }} options
 */
function makePlayer({ play, speed, note, speeds, last, index, show, motion }) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  const delay = () => speeds[controlValue(speed)] ?? speeds.normal;
  const stop = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (play) play.textContent = "Play";
  };
  const schedule = () => {
    timer = index() >= last ? null : setTimeout(tick, delay());
    if (timer === null) stop();
  };
  const tick = () => {
    show(index() + 1);
    schedule();
  };
  const start = () => {
    if (motion.reduced) return;
    if (play) play.textContent = "Pause";
    show(index() >= last ? 0 : index() + 1);
    schedule();
  };
  const applyMotion = () => {
    if (motion.reduced) stop();
    if (play) play.disabled = motion.reduced;
    if (speed) speed.disabled = motion.reduced;
    if (note) note.hidden = !motion.reduced;
  };
  motion.listeners.push(applyMotion);
  applyMotion();
  play?.addEventListener("click", () => (timer === null ? start() : stop()));
  speed?.addEventListener("change", () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = setTimeout(tick, delay());
  });
  return { start, stop, get playing() { return timer !== null; } };
}

/**
 * Widget 1: one real day through the pipeline's steps. A click on a step of the pipeline
 * diagram jumps here too.
 * @param {Document} doc
 * @param {ReturnType<typeof sizer>} fit
 * @param {ReturnType<typeof motionPreference>} motion
 */
function mountDay(doc, fit, motion) {
  const byId = (id) => doc.getElementById(id);
  const setText = (id, text) => fill(byId(id), "textContent", text);
  const setHtml = (id, html) => fill(byId(id), "innerHTML", html);
  const mapBox = byId("day-map");
  if (!mapBox) return null;
  const model = dayModel(ONE_DAY);
  const last = DAY_STEPS.length - 1;
  let state = dayState(model, 0);
  let pick = defaultPick(model);
  let animate = false;

  setHtml("day-science", dayScienceHtml(ONE_DAY));
  const pickInput = byId("day-pick");
  pickInput?.setAttribute("max", String(model.rows.length));
  const closeBox = byId("day-closeup");
  const monthBox = byId("day-month");
  const maps = [
    fit(mapBox, (width) => (mapBox.innerHTML = dayMapSvg(model, state, { width, view: "map", pick, animate })), 600),
    closeBox ? fit(closeBox, (width) => (closeBox.innerHTML = dayMapSvg(model, state, { width, view: "closeUp", pick, animate })), 300) : null,
  ].filter(Boolean);
  const month = monthBox ? fit(monthBox, (width) => (monthBox.innerHTML = monthSvg(model, state, { width })), 600) : null;

  const showPick = () => {
    const text = pickText(model, state, pick);
    setText("day-pick-info", text);
    if (pickInput) {
      pickInput.value = String(pick + 1);
      pickInput.setAttribute("value", String(pick + 1));
      pickInput.setAttribute("aria-valuetext", `Detection ${pick + 1} of ${model.rows.length}: ${text}`);
    }
  };
  const setPick = (i) => {
    if (!Number.isInteger(i) || i < 0 || i >= model.rows.length || i === pick) return;
    pick = i;
    for (const item of maps) item.draw();
    showPick();
  };
  const back = byId("day-back");
  const next = byId("day-next");
  const show = (i) => {
    state = dayState(model, i);
    setHtml("day-steps", dayProgressHtml(state));
    setText("day-title", state.title);
    setText("day-text", state.text);
    setHtml("day-counters", dayCountersHtml(state));
    setHtml("day-log", dayLogHtml(state));
    setText("day-words", describeDay(model, state));
    setText("day-month-text", monthText(model, state));
    animate = true;
    for (const item of maps) item.draw();
    animate = false;
    month?.draw();
    showPick();
    if (back) back.disabled = state.step === 0;
    if (next) next.disabled = state.step === last;
  };
  const player = makePlayer({
    play: byId("day-play"),
    speed: byId("day-speed"),
    note: byId("day-motion-note"),
    speeds: SPEEDS.day,
    last,
    index: () => state.step,
    show,
    motion,
  });
  show(0);

  back?.addEventListener("click", () => {
    player.stop();
    if (state.step > 0) show(state.step - 1);
  });
  next?.addEventListener("click", () => {
    player.stop();
    if (state.step < last) show(state.step + 1);
  });
  byId("day-reset")?.addEventListener("click", () => {
    player.stop();
    pick = defaultPick(model);
    show(0);
  });
  pickInput?.addEventListener("input", (event) => setPick(Number(controlValue(event.target)) - 1));
  for (const box of [mapBox, closeBox]) {
    for (const type of ["mouseover", "click"]) {
      box?.addEventListener(type, (event) => {
        const dot = event.target?.closest?.("[data-i]");
        if (dot) setPick(Number(dot.getAttribute("data-i")));
      });
    }
  }
  byId("pipeline-steps")?.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-step]");
    const i = button ? stepForPipe(button.getAttribute("data-step")) : -1;
    if (i < 0) return;
    player.stop();
    show(i);
  });
  return {
    model,
    show,
    stop: player.stop,
    player,
    get step() {
      return state.step;
    },
    get pick() {
      return pick;
    },
  };
}

/**
 * Widget 2: 90 days around a gas flare, with a day slider and Play.
 * @param {Document} doc
 * @param {ReturnType<typeof sizer>} fit
 * @param {ReturnType<typeof motionPreference>} motion
 */
function mountFlare(doc, fit, motion) {
  const byId = (id) => doc.getElementById(id);
  const setText = (id, text) => fill(byId(id), "textContent", text);
  const box = byId("flare-map");
  if (!box) return null;
  const model = flareModel(FLARE);
  let state = flareState(model, 1);
  let animate = false;
  fill(byId("flare-science"), "innerHTML", flareScienceHtml(FLARE));
  const slider = byId("flare-day");
  slider?.setAttribute("max", String(FLARE.days));
  const map = fit(box, (width) => (box.innerHTML = flareSvg(model, state, { width, animate })), 360);

  /** @param {number} day @param {boolean} [announce] */
  const show = (day, announce = false) => {
    state = flareState(model, day);
    const news = flareNews(model, state);
    if (slider) {
      slider.value = String(state.day);
      slider.setAttribute("value", String(state.day));
      slider.setAttribute("aria-valuetext", `${flareDayText(state)}. ${news}`);
    }
    setText("flare-day-value", flareDayText(state));
    fill(byId("flare-counters"), "innerHTML", flareCountersHtml(state));
    setText("flare-news", news);
    setText("flare-words", describeFlare(model, state));
    if (announce || state.newlyFlagged.length > 0) setText("flare-live", news);
    animate = true;
    map.draw();
    animate = false;
  };
  const player = makePlayer({
    play: byId("flare-play"),
    speed: byId("flare-speed"),
    note: byId("flare-motion-note"),
    speeds: SPEEDS.flare,
    last: FLARE.days,
    index: () => state.day,
    show: (day) => show(Math.max(1, day)),
    motion,
  });
  show(1);
  slider?.addEventListener("input", (event) => {
    player.stop();
    show(Number(controlValue(event.target)));
  });
  byId("flare-reset")?.addEventListener("click", () => {
    player.stop();
    show(1, true);
  });
  return {
    model,
    show,
    stop: player.stop,
    player,
    get day() {
      return state.day;
    },
    get state() {
      return state;
    },
  };
}

/**
 * Mounts both widgets where method.html has their containers. Play pauses when the page loses
 * focus or is hidden.
 * @param {Document} [doc]
 * @param {{ reducedMotion?: boolean }} [options]
 */
export function mountExplorables(doc = document, { reducedMotion } = {}) {
  const fit = sizer();
  const motion = motionPreference(doc, reducedMotion);
  const day = mountDay(doc, fit, motion);
  const flare = mountFlare(doc, fit, motion);
  const pause = () => {
    day?.stop();
    flare?.stop();
  };
  doc.defaultView?.addEventListener?.("blur", pause);
  doc.addEventListener?.("visibilitychange", () => {
    if (doc.visibilityState === "hidden") pause();
  });
  return { day, flare, pause, motion };
}
