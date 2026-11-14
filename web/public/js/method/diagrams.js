import { TIME } from "../../shared/contracts.js";
import { MONTH_LONG } from "../calendar/transform.js";
import { formatWeight } from "../map/point-info.js";
import { CAMERAS, LIMIT_MW_PER_KM2, PATCH_FIRES, PATCH_KM, recordPeriods, satellites } from "./facts.js";
import { escapeHtml } from "./html.js";
import { ANNUAL_ERROR_LIMIT_PCT, MIN_MONTHLY_R } from "./transform.js";

/**
 * Pure models and markup for the five "How it works" diagrams: each function returns data or
 * an HTML/SVG string, and diagrams-dom.js puts them on the page.
 * @typedef {import("./transform.js").DetectionCurve} DetectionCurve
 * @typedef {import("./transform.js").KRow} KRow
 * @typedef {import("./transform.js").ValidationSummary} ValidationSummary
 * @typedef {import("./transform.js").RegionValidation} RegionValidation
 * @typedef {import("./transform.js").RegionName} RegionName
 */

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const grouped = new Intl.NumberFormat("en-US");
const hidden = (text) => `<span class="visually-hidden">${escapeHtml(text)}</span>`;
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const word = (n) => WORDS[n] ?? String(n);
const round1 = (value) => Math.round(value * 10) / 10;
const andList = (items) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** @param {string} iso */
const parts = (iso) => iso.split("-").map(Number);

/** @param {string} iso @param {number} days */
function addDays(iso, days) {
  const [year, month, day] = parts(iso);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** 2012.0 for "2012-01-01". @param {string} iso */
export function yearFraction(iso) {
  const [year, month, day] = parts(iso);
  const start = Date.UTC(year, 0, 1);
  return year + (Date.UTC(year, month - 1, day) - start) / (Date.UTC(year + 1, 0, 1) - start);
}

/** "November 2000", or "2 November 2026" when `exact`. @param {string} iso @param {boolean} [exact] */
function dateText(iso, exact = false) {
  const [year, month, day] = parts(iso);
  return exact ? `${day} ${MONTH_LONG[month - 1]} ${year}` : `${MONTH_LONG[month - 1]} ${year}`;
}

const isMonthStart = (iso) => parts(iso)[2] === 1;

/**
 * "November 2000 to today", "January 2012 to 1 November 2026", "since 2 November 2026".
 * With `exact`, a period that starts or ends inside a month gives the day. `end` is exclusive.
 * @param {string} start @param {string | null} end @param {{ exact?: boolean }} [options]
 */
export function periodText(start, end, { exact = true } = {}) {
  const precise = exact && !isMonthStart(start);
  const from = dateText(start, precise);
  if (end === null) return precise ? `since ${from}` : `${from} to today`;
  const last = addDays(end, -1);
  return `${from} to ${dateText(last, exact && !isMonthStart(end))}`;
}

const labelPx = (width) => (width > 592 ? 148 : 96);
const CHAR_PX = 7.2;

/**
 * Diagram 1: one bar per satellite and a strip of which camera feeds the record, placed in
 * percent of a 2000 to 2027 track `width` px wide (labels included). A period too short to see
 * gets `minPx` and pushes back the end of the one before it.
 * @param {{ today: string, viirsSwitch?: string, width?: number, from?: number, to?: number, minPx?: number }} options
 */
export function timelineLayout({ today, viirsSwitch = TIME.VIIRS_SWITCH, width = 640, from = 2000, to = 2027, minPx = 8 }) {
  const span = to - from;
  const trackPx = Math.max(120, width - labelPx(width));
  const at = (iso) => Math.min(100, Math.max(0, ((yearFraction(iso) - from) / span) * 100));
  const minPct = (minPx / trackPx) * 100;
  /** @template {{ start: string, end: string | null }} T @param {T[]} items @param {(item: T) => string} short @param {(item: T) => string} info */
  const place = (items, short, info) => {
    const placed = items.map((item) => {
      const left = at(item.start);
      return { ...item, left, width: at(item.end ?? today) - left, short: short(item), info: info(item), showText: false };
    });
    placed.forEach((item, i) => {
      if (item.width >= minPct) return;
      item.left = Math.min(item.left, 100 - minPct);
      item.width = minPct;
      const before = placed[i - 1];
      if (before && before.left + before.width > item.left) before.width = item.left - before.left;
    });
    for (const item of placed) item.showText = (item.width / 100) * trackPx >= item.short.length * CHAR_PX + 14;
    return placed;
  };
  const record = place(
    recordPeriods({ viirsSwitch }),
    (period) => period.name,
    (period) => `Our record, ${periodText(period.start, period.end)}: ${period.role}`,
  );
  const bars = place(
    satellites({ viirsSwitch }),
    (sat) => `${sat.start.slice(0, 4)} to ${sat.end ? sat.end.slice(0, 4) : "today"}`,
    (sat) => `${sat.name} (${sat.camera}), ${periodText(sat.start, sat.end, { exact: false })}. ${sat.role}`,
  );
  const step = trackPx >= 420 ? 2 : 5;
  const ticks = [];
  for (let year = from; year < to; year += 1) ticks.push({ year, left: ((year - from) / span) * 100, label: (year - from) % step === 0 });
  return { record, bars, ticks, switchAt: at(`${TIME.CALIBRATION.start_year}-01-01`), trackPx };
}

/** @typedef {ReturnType<typeof timelineLayout>["bars"][number]} TimelineBar */

/** @param {TimelineBar | ReturnType<typeof timelineLayout>["record"][number]} item @param {string} kind */
function barHtml(item, kind) {
  const text = item.showText ? `<span class="tl-text" aria-hidden="true">${escapeHtml(item.short)}</span>` : "";
  return (
    `<button type="button" class="${kind} tl-${item.camera.toLowerCase()}" style="left:${round1(item.left)}%;width:${round1(item.width)}%" ` +
    `data-info="${escapeHtml(item.info)}">${text}${hidden(item.info)}</button>`
  );
}

/** @param {ReturnType<typeof timelineLayout>} layout */
export function timelineHtml(layout) {
  const ticks = layout.ticks
    .map((tick) => {
      const left = `left:${round1(tick.left)}%`;
      return `<span class="tl-tick${tick.label ? " tl-major" : ""}" style="${left}"></span>${tick.label ? `<span class="tl-year" style="${left}">${tick.year}</span>` : ""}`;
    })
    .join("");
  const row = (label, track, extra = "") => `<div class="tl-label">${label}</div><div class="tl-track${extra}">${track}</div>`;
  return (
    `<div class="tl">` +
    `<div class="tl-label" aria-hidden="true"></div><div class="tl-track tl-axis" aria-hidden="true">${ticks}</div>` +
    row("Our record", layout.record.map((item) => barHtml(item, "tl-seg")).join(""), " tl-record") +
    layout.bars.map((sat) => row(`${escapeHtml(sat.name)} <span class="tl-camera">${escapeHtml(sat.camera)}</span>`, barHtml(sat, "tl-bar"))).join("") +
    `<div class="tl-switch" aria-hidden="true" style="--at:${round1(layout.switchAt) / 100}"></div>` +
    `</div>`
  );
}

const ARROW =
  '<svg class="pipe-arrow" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M2 8h11M9 4l4 4-4 4"/></svg>';

/**
 * Diagram 4: one toggle button per pipeline step, the chosen one pressed.
 * @param {readonly { id: string, name: string, figure: string }[]} steps
 * @param {string} chosen
 */
export function pipelineHtml(steps, chosen) {
  return steps
    .map(
      (step, i) =>
        `<li>${i > 0 ? ARROW : ""}<button type="button" id="pipe-${escapeHtml(step.id)}" data-step="${escapeHtml(step.id)}" ` +
        `aria-controls="pipeline-detail" aria-pressed="${step.id === chosen}"><span class="pipe-name">${escapeHtml(step.name)}</span>` +
        `<span class="pipe-figure">${escapeHtml(step.figure)}</span></button></li>`,
    )
    .join("");
}

/** @param {{ name: string, text: readonly string[], link: { href: string, text: string } }} step */
export function pipelineDetailHtml(step) {
  return (
    `<h3>${escapeHtml(step.name)}</h3>${step.text.map((text) => `<p>${escapeHtml(text)}</p>`).join("")}` +
    `<p><a href="${escapeHtml(step.link.href)}">${escapeHtml(step.link.text)}</a></p>`
  );
}

/**
 * Diagram 2: what one camera reports for the toy patch when its strongest fire gives off
 * `strongestMw`. Fires in one square add up, and the square counts once.
 * @param {typeof CAMERAS[number]} camera
 * @param {number} strongestMw
 * @param {readonly { x: number, y: number, share: number }[]} [fires]
 */
export function cameraView(camera, strongestMw, fires = PATCH_FIRES) {
  const n = Math.round(PATCH_KM / camera.pixelKm);
  const limit = LIMIT_MW_PER_KM2 * camera.pixelKm ** 2;
  /** @type {Map<number, { col: number, row: number, mw: number }>} */
  const squares = new Map();
  for (const fire of fires) {
    const col = Math.min(n - 1, Math.floor(fire.x / camera.pixelKm));
    const row = Math.min(n - 1, Math.floor(fire.y / camera.pixelKm));
    const key = row * n + col;
    squares.set(key, { col, row, mw: (squares.get(key)?.mw ?? 0) + fire.share * strongestMw });
  }
  const flagged = [...squares.values()].filter((square) => square.mw >= limit * (1 - 1e-9)).sort((a, b) => a.row - b.row || a.col - b.col);
  return { camera, n, limit, flagged, count: flagged.length, fires: fires.map((fire) => ({ ...fire, mw: fire.share * strongestMw })) };
}

/** @param {number} strongestMw */
export function cameraCounts(strongestMw) {
  const [modis, viirs] = CAMERAS.map((camera) => cameraView(camera, strongestMw).count);
  return { modis, viirs };
}

/** "MODIS sees 0 · VIIRS sees 3" @param {{ modis: number, viirs: number }} counts */
export const countsText = (counts) => `MODIS sees ${counts.modis} · VIIRS sees ${counts.viirs}`;

/** "5 MW", "0.13 MW", "1,000 MW" @param {number} mw */
export const formatMw = (mw) => `${grouped.format(mw >= 10 ? Math.round(mw) : Number(mw.toPrecision(2)))} MW`;

const PATCH_PX = 240;

/** @param {ReturnType<typeof cameraView>} view */
export function cameraSvg(view) {
  const scale = PATCH_PX / PATCH_KM;
  const cell = PATCH_PX / view.n;
  const hits = view.flagged
    .map((square) => `<rect class="cam-hit" x="${round1(square.col * cell + 1.5)}" y="${round1(square.row * cell + 1.5)}" width="${round1(cell - 3)}" height="${round1(cell - 3)}"/>`)
    .join("");
  let grid = "";
  for (let i = 1; i < view.n; i += 1) grid += `M${round1(i * cell)} 0V${PATCH_PX}M0 ${round1(i * cell)}H${PATCH_PX}`;
  const fires = view.fires
    .map((fire) => `<circle class="cam-fire" cx="${round1(fire.x * scale)}" cy="${round1(fire.y * scale)}" r="${round1(2.5 + 2.5 * Math.log10(1 + fire.mw))}"/>`)
    .join("");
  const label = `${view.camera.name} view of the same patch in ${view.camera.squares}: ${view.count} of ${view.n * view.n} squares marked as fire.`;
  return (
    `<svg class="cam-svg" viewBox="0 0 ${PATCH_PX} ${PATCH_PX}" role="img" aria-label="${escapeHtml(label)}">` +
    `<rect class="cam-land" width="${PATCH_PX}" height="${PATCH_PX}"/>${hits}<path class="cam-grid" d="${grid}"/>${fires}` +
    `<rect class="cam-edge" x="0.5" y="0.5" width="${PATCH_PX - 1}" height="${PATCH_PX - 1}"/></svg>`
  );
}

/**
 * The chance MODIS sees a fire of `value` MW, interpolated in log fire strength and held at
 * the curve's ends outside its range.
 * @param {number[]} frp ascending
 * @param {number[]} p
 * @param {number} value
 */
export function curveAt(frp, p, value) {
  if (value <= frp[0]) return p[0];
  if (value >= frp.at(-1)) return p.at(-1);
  const i = frp.findIndex((x) => x >= value);
  const f = (Math.log10(value) - Math.log10(frp[i - 1])) / (Math.log10(frp[i]) - Math.log10(frp[i - 1]));
  return p[i - 1] + f * (p[i] - p[i - 1]);
}

/** The all-land curve, else the first. @param {DetectionCurve} curve */
export function allLandCurve(curve) {
  const line = curve.curves.find((c) => c.land_class === "all") ?? curve.curves[0];
  return line ? { frp: curve.frp_mw, p: line.p } : null;
}

/**
 * The shipped method's factor for a region and calendar month: S-NPP's by default, since
 * S-NPP carries the record from 2012 to the switch.
 * @param {KRow[] | null} kTable @param {string} regionId @param {number} month
 */
export function factorAt(kTable, regionId, month, satellite = "S-NPP") {
  return kTable?.find((row) => row.region_id === regionId && row.month === month && row.satellite === satellite) ?? null;
}

/** "about 23%", "less than 1%" @param {number} p */
export const chanceText = (p) => (p < 0.005 ? "less than 1%" : `about ${Math.round(p * 100)}%`);

/**
 * Diagram 3: what one VIIRS fire counts for. With a detection curve it is the chance MODIS sees
 * a lone fire of that strength, times the region and month factor; with the ratio method every
 * fire counts the factor.
 * @param {{ curve: { frp: number[], p: number[] } | null, kTable: KRow[] | null, regionId: string, month: number, frp: number }} input
 */
export function countedModel({ curve, kTable, regionId, month, frp }) {
  const p = curve ? curveAt(curve.frp, curve.p, frp) : null;
  const factor = factorAt(kTable, regionId, month);
  const weight = factor ? (p ?? 1) * factor.value : null;
  return {
    frp,
    p,
    factor: factor?.value ?? null,
    weight,
    chance: p === null ? null : `MODIS would have seen a fire like this ${chanceText(p)} of the time.`,
    result: weight === null ? null : formatWeight(weight, "S-NPP"),
  };
}

/**
 * The sum beside the curve: chance × factor = what the fire adds to the calendar.
 * @param {ReturnType<typeof countedModel>} model
 * @param {{ place: string }} context "Nile Delta, Egypt in November"
 */
export function equationHtml(model, { place }) {
  const term = (value, name, extra = "") =>
    `<span class="eq-term${extra}"><span class="eq-value">${escapeHtml(value)}</span><span class="eq-name">${escapeHtml(name)}</span></span>`;
  const op = (symbol, words) => `<span class="eq-op" aria-hidden="true">${symbol}</span>${hidden(words)}`;
  const pieces = [];
  if (model.p !== null) pieces.push(term(model.p < 0.005 ? "<1%" : `${Math.round(model.p * 100)}%`, "chance MODIS sees it"), op("×", " times "));
  pieces.push(
    model.factor === null
      ? term("?", `factor for ${place}, published with the data`)
      : term(model.factor.toFixed(model.factor < 1 ? 2 : 1), `factor for ${place}`),
    op("=", " equals "),
    term(model.result ?? "Not known yet", "in the calendar", " eq-result"),
  );
  return `<p class="eq">${pieces.join("")}</p>`;
}

/**
 * Diagram 3's curve, `width` px wide, with the chosen fire marked.
 * @param {{ frp: number[], p: number[] }} curve
 * @param {{ width: number, frp: number, p: number }} marker
 */
export function curveSvg(curve, { width, frp, p }) {
  const height = 200;
  const m = { left: 44, right: 20, top: 30, bottom: 46 };
  const plotW = Math.max(120, width - m.left - m.right);
  const plotH = height - m.top - m.bottom;
  const lo = Math.log10(curve.frp[0]);
  const hi = Math.log10(curve.frp.at(-1));
  const x = (value) => m.left + ((Math.log10(value) - lo) / (hi - lo)) * plotW;
  const y = (prob) => m.top + (1 - prob) * plotH;
  const decades = [];
  for (let e = Math.ceil(lo - 1e-9); e <= Math.floor(hi + 1e-9); e += 1) decades.push(10 ** e);
  const xTicks = decades
    .map((value) => `<text class="dg-small" x="${round1(x(value))}" y="${height - m.bottom + 16}" text-anchor="middle">${grouped.format(value)}</text>`)
    .join("");
  const yTicks = [0, 0.5, 1]
    .map(
      (prob) =>
        `<path class="dg-gridline" d="M${m.left} ${round1(y(prob))}H${round1(m.left + plotW)}"/>` +
        `<text class="dg-small" x="${m.left - 6}" y="${round1(y(prob) + 4)}" text-anchor="end">${prob * 100}%</text>`,
    )
    .join("");
  const line = curve.frp.map((value, i) => `${i === 0 ? "M" : "L"}${round1(x(value))} ${round1(y(curve.p[i]))}`).join("");
  const mx = round1(x(Math.min(Math.max(frp, curve.frp[0]), curve.frp.at(-1))));
  const my = round1(y(p));
  const flip = mx > m.left + plotW - 60;
  const axisName = width < 420 ? "Fire strength, MW" : "Fire strength in megawatts (each step is 10 times stronger)";
  const samples = [1, 10, 100].filter((value) => value >= curve.frp[0] && value <= curve.frp.at(-1));
  const label =
    `Chance that MODIS sees a fire, by its strength: ${samples.map((value) => `${chanceText(curveAt(curve.frp, curve.p, value))} at ${formatMw(value)}`).join(", ")}. ` +
    `Marked: ${formatMw(frp)}, ${chanceText(p)}.`;
  return (
    `<svg class="cv-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)}">` +
    `<text class="dg-small dg-muted" x="${m.left}" y="14">Chance MODIS sees it</text>${yTicks}${xTicks}` +
    `<text class="dg-small dg-muted" x="${round1(m.left + plotW / 2)}" y="${height - 6}" text-anchor="middle">${axisName}</text>` +
    `<path class="cv-guide" d="M${mx} ${round1(y(0))}V${my}H${m.left}"/><path class="cv-line" d="${line}"/>` +
    `<circle class="cv-marker" cx="${mx}" cy="${my}" r="6"/>` +
    `<text class="dg-label" x="${flip ? mx - 10 : mx + 10}" y="${round1(Math.max(m.top + 4, my - 8))}" text-anchor="${flip ? "end" : "start"}">${p < 0.005 ? "<1" : Math.round(p * 100)}%</text>` +
    `</svg>`
  );
}

/**
 * Diagram 5: one step per hidden-years test inside the calibration years, then the decision.
 * Test results are yearly totals from `validation:<region>`; the decision's come from
 * `validation_summary`. Null when neither exists.
 * @param {{ validation: Record<string, RegionValidation | null>, summary: ValidationSummary | null,
 *   regions: RegionName[], shipped: import("../../shared/contracts.js").WeightMethod }} input
 */
export function testSteps({ validation, summary, regions, shipped }) {
  const key = shipped === "model_v1" ? "model" : "ratio";
  const { start_year: first, end_year: last } = TIME.CALIBRATION;
  const years = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const order = regions.map((region) => region.id);
  const rank = (id) => (order.includes(id) ? order.indexOf(id) : order.length);
  /** @type {Map<string, number[]>} */
  const folds = new Map();
  const series = regions
    .filter((region) => validation[region.id]?.months?.length)
    .map((region) => {
      /** @type {Map<number, { modis: number, ours: number | null }>} */
      const totals = new Map();
      for (const month of validation[region.id].months) {
        const [from, to] = month.fold.split("-").map(Number);
        if (from <= last && !folds.has(month.fold)) folds.set(month.fold, years.filter((year) => year >= from && year <= to));
        const year = Math.trunc(month.ym / 100);
        const total = totals.get(year) ?? { modis: 0, ours: 0 };
        total.modis += month.modis;
        total.ours = total.ours !== null && isNumber(month[key]) ? total.ours + month[key] : null;
        totals.set(year, total);
      }
      return { regionId: region.id, name: region.name, totals };
    });
  /** @type {any[]} */
  const steps = [...folds.values()]
    .filter((hiddenYears) => hiddenYears.length > 0)
    .sort((a, b) => a[0] - b[0])
    .map((hiddenYears, i, all) => ({
      kind: "test",
      number: i + 1,
      of: all.length,
      hidden: hiddenYears,
      learned: years.filter((year) => !hiddenYears.includes(year)),
      regions: series.map((s) => ({
        regionId: s.regionId,
        name: s.name,
        years: hiddenYears.map((year) => {
          const total = s.totals.get(year);
          const errorPct = total && total.modis > 0 && isNumber(total.ours) ? ((total.ours - total.modis) / total.modis) * 100 : null;
          return { year, modis: total?.modis ?? null, ours: total?.ours ?? null, errorPct };
        }),
      })),
    }));
  if (summary) {
    const names = new Map(regions.map((region) => [region.id, region.name]));
    const rows = summary.lyo_2012_2019
      .map((row) => {
        const errorPct = row.annual_error_pct[key];
        const r = row.monthly_r[key];
        return {
          regionId: row.region_id,
          name: names.get(row.region_id) ?? row.region_id,
          errorPct: isNumber(errorPct) ? errorPct : null,
          rawPct: isNumber(row.annual_error_pct.raw) ? row.annual_error_pct.raw : null,
          passes: isNumber(errorPct) && isNumber(r) ? errorPct <= ANNUAL_ERROR_LIMIT_PCT && r >= MIN_MONTHLY_R : null,
        };
      })
      .sort((a, b) => rank(a.regionId) - rank(b.regionId));
    steps.push({
      kind: "decision",
      hidden: [],
      learned: years,
      regions: rows,
      method: summary.decision.method,
      passed: summary.decision.passed_regions,
      modelRan: summary.lyo_2012_2019.some((row) => isNumber(row.annual_error_pct.model)),
    });
  }
  return steps.length > 0 ? { years, key, steps } : null;
}

/** @typedef {NonNullable<ReturnType<typeof testSteps>>} TestModel */
/** @typedef {TestModel["steps"][number]} TestStep */

/** "less than 1%", "37%" @param {number} pct */
const sizeText = (pct) => (Math.abs(pct) < 1 ? "less than 1%" : `${grouped.format(Math.round(Math.abs(pct)))}%`);

/** "2% below MODIS", "37% above MODIS" @param {number | null} pct */
export function missText(pct) {
  if (pct === null) return "no number";
  if (Math.abs(pct) < 1) return "less than 1% off";
  return `${sizeText(pct)} ${pct > 0 ? "above" : "below"} MODIS`;
}

/** @param {{ passes: boolean | null }} row */
const passMark = (row) => (row.passes ? " ✓" : row.passes === false ? " ✗" : "");

/** Title and sentence for a step. @param {TestStep} step */
export function stepText(step) {
  if (step.kind === "test") {
    return {
      title: `Test ${step.number} of ${step.of}: ${andList(step.hidden.map(String))} hidden`,
      text: `We learn from the other ${word(step.learned.length)} years, then predict the hidden ${word(step.hidden.length)} and compare with what MODIS really counted.`,
    };
  }
  const passing = step.regions.filter((row) => row.passes).length;
  const raws = step.regions.map((row) => row.rawPct).filter(isNumber);
  let raw = "";
  if (raws.length > 0) {
    const [lo, hi] = [Math.min(...raws), Math.max(...raws)].map(sizeText);
    raw = ` Without the fix, raw VIIRS was off by ${lo === hi ? lo : `${lo} to ${hi}`}.`;
  }
  let verdict = "The detection model did not pass the rule, so the app uses the simpler ratio method.";
  if (!step.modelRan) verdict = "No detection model was tested, so the app uses the simpler ratio method.";
  else if (step.method === "model_v1") {
    verdict = `The detection model passed in ${step.passed} of ${step.regions.length} regions and beat the simpler ratio method, so the app uses it.`;
  }
  return {
    title: "The decision",
    text: `Over the ${word(step.learned.length)} hidden years, our yearly count was within ${ANNUAL_ERROR_LIMIT_PCT}% of MODIS on average, with months that line up closely, in ${passing} of ${step.regions.length} regions.${raw} ${verdict}`,
  };
}

/** @param {TestModel} model @param {TestStep} step */
export function yearBlocksHtml(model, step) {
  const words = { tested: "hidden once and tested", hidden: "hidden, then predicted", learn: "learned from" };
  const items = model.years.map((year) => {
    const state = step.kind === "decision" ? "tested" : step.hidden.includes(year) ? "hidden" : "learn";
    return `<li class="yr yr-${state}"><span>${year}</span>${hidden(`, ${words[state]}`)}</li>`;
  });
  return `<ol class="yr-blocks">${items.join("")}</ol>`;
}

/**
 * A step's results as bars, `width` px wide. A test step shows how far each hidden year's
 * count landed from MODIS (below to the left, above to the right, ±15% shaded); the decision
 * shows each region's average miss beside raw VIIRS's.
 * @param {TestStep} step
 * @param {{ width: number }} options
 */
export function testSvg(step, { width }) {
  const max = 40;
  const labelW = width < 420 ? 118 : 160;
  const x0 = step.kind === "test" ? 40 : 80;
  const barW = Math.max(100, width - x0 - labelW - 8);
  const rowH = 20;
  const nameH = 22;
  const gap = 12;
  const top = 22;
  const perRegion = nameH + (step.kind === "test" ? step.hidden.length : 2) * rowH + gap;
  const height = top + step.regions.length * perRegion;
  const bottom = height - gap;
  const tip = (cls, x, mid, dir) => `<path class="${cls}" d="M${round1(x)} ${round1(mid - 8)}l${6 * dir} 8l${-6 * dir} 8z"/>`;
  const rows = [];
  let guides;
  let y = top;
  /** @param {string} text @param {number} mid */
  const rightLabel = (text, mid) => `<text class="dg-small" x="${round1(x0 + barW + 10)}" y="${round1(mid + 4)}">${escapeHtml(text)}</text>`;
  if (step.kind === "test") {
    const xAt = (pct) => x0 + ((Math.max(-max, Math.min(max, pct)) + max) / (2 * max)) * barW;
    const band = [xAt(-ANNUAL_ERROR_LIMIT_PCT), xAt(ANNUAL_ERROR_LIMIT_PCT)];
    guides =
      `<rect class="ts-band" x="${round1(band[0])}" y="${top}" width="${round1(band[1] - band[0])}" height="${bottom - top}"/>` +
      `<path class="ts-zero" d="M${round1(xAt(0))} ${top}V${bottom}"/>` +
      `<text class="dg-small dg-muted" x="${round1(xAt(0))}" y="14" text-anchor="middle">within ${ANNUAL_ERROR_LIMIT_PCT}%</text>` +
      `<text class="dg-small dg-muted" x="${x0}" y="14">below</text>` +
      `<text class="dg-small dg-muted" x="${round1(x0 + barW)}" y="14" text-anchor="end">above</text>`;
    for (const region of step.regions) {
      rows.push(`<text class="dg-label" x="0" y="${y + 15}">${escapeHtml(region.name)}</text>`);
      y += nameH;
      for (const year of region.years) {
        const mid = y + rowH / 2;
        rows.push(`<text class="dg-small" x="0" y="${round1(mid + 4)}">${year.year}</text>`);
        if (year.errorPct !== null) {
          const [a, b] = [xAt(0), xAt(year.errorPct)];
          const cls = year.errorPct >= 0 ? "ts-over" : "ts-under";
          rows.push(`<rect class="${cls}" x="${round1(Math.min(a, b))}" y="${round1(mid - 6)}" width="${round1(Math.max(1.5, Math.abs(b - a)))}" height="12"/>`);
          if (Math.abs(year.errorPct) > max) rows.push(tip(cls, b, mid, Math.sign(year.errorPct)));
        }
        rows.push(rightLabel(missText(year.errorPct), mid));
        y += rowH;
      }
      y += gap;
    }
  } else {
    const xAt = (pct) => x0 + (Math.min(max, Math.max(0, pct)) / max) * barW;
    guides =
      `<path class="ts-limit" d="M${round1(xAt(ANNUAL_ERROR_LIMIT_PCT))} ${top}V${bottom}"/>` +
      `<text class="dg-small dg-muted" x="${round1(xAt(ANNUAL_ERROR_LIMIT_PCT))}" y="14" text-anchor="middle">${ANNUAL_ERROR_LIMIT_PCT}% limit</text>`;
    for (const region of step.regions) {
      rows.push(`<text class="dg-label" x="0" y="${y + 15}">${escapeHtml(region.name)}</text>`);
      y += nameH;
      const bars = [
        { name: "Ours", pct: region.errorPct, cls: "ts-ours", text: region.errorPct === null ? "no number" : `${sizeText(region.errorPct)} off${passMark(region)}` },
        { name: "Raw VIIRS", pct: region.rawPct, cls: "ts-over", text: region.rawPct === null ? "no number" : `${sizeText(region.rawPct)} off` },
      ];
      for (const bar of bars) {
        const mid = y + rowH / 2;
        rows.push(`<text class="dg-small" x="0" y="${round1(mid + 4)}">${bar.name}</text>`);
        if (bar.pct !== null) {
          rows.push(`<rect class="${bar.cls}" x="${x0}" y="${round1(mid - 6)}" width="${round1(Math.max(1.5, xAt(bar.pct) - x0))}" height="12"/>`);
          if (bar.pct > max) rows.push(tip(bar.cls, xAt(max), mid, 1));
        }
        rows.push(rightLabel(bar.text, mid));
        y += rowH;
      }
      y += gap;
    }
  }
  return (
    `<svg class="ts-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false">` +
    `${guides}${rows.join("")}</svg>`
  );
}

/** A step's results in words, for screen readers. @param {TestStep} step */
export function describeStep(step) {
  if (step.kind === "test") {
    return step.regions.map((region) => `${region.name}: ${region.years.map((year) => `${year.year} ${missText(year.errorPct)}`).join(", ")}.`).join(" ");
  }
  return step.regions
    .map((region) => {
      const ours = region.errorPct === null ? "no number" : `${sizeText(region.errorPct)} off on average${region.passes ? ", within the limit" : region.passes === false ? ", outside the limit" : ""}`;
      const raw = region.rawPct === null ? "no number" : `${sizeText(region.rawPct)} off`;
      return `${region.name}: ours ${ours}; raw VIIRS ${raw}.`;
    })
    .join(" ");
}
