import { TIME } from "../../shared/contracts.js";
import { MONTH_LONG } from "../calendar/transform.js";
import { CAMERAS, PIPELINE_STEPS, RUN } from "./facts.js";
import {
  allLandCurve,
  cameraView,
  cameraSvg,
  countedModel,
  countsText,
  curveAt,
  curveSvg,
  describeStep,
  equationHtml,
  formatMw,
  pipelineDetailHtml,
  pipelineHtml,
  stepText,
  testSteps,
  testSvg,
  timelineHtml,
  timelineLayout,
  yearBlocksHtml,
} from "./diagrams.js";
import { escapeHtml } from "./html.js";
import { formatDate } from "./transform.js";

/** @typedef {import("./transform.js").MethodBody} MethodBody */

export const STEP_MS = 3500;
const CAMERAS_DEFAULT_MW = 10;
const COUNTED_DEFAULT_MW = 5;

/** The value a control holds after an input or change event. @param {any} control */
const controlValue = (control) => control.value ?? control.getAttribute?.("value") ?? "";

/**
 * Draws the five diagrams into method.html and wires their controls. `body` is the
 * /api/method body, or null when it did not load: the timeline, the cameras and the pipeline
 * need no data, so they draw either way.
 * @param {MethodBody | null} body
 * @param {Document} [doc]
 */
export function mountDiagrams(body, doc = document) {
  const byId = (id) => doc.getElementById(id);
  /** @type {Map<any, { width: number, draw: () => void }>} */
  const sized = new Map();
  const observer =
    typeof ResizeObserver === "function"
      ? new ResizeObserver((entries) => {
          for (const entry of entries) {
            const item = sized.get(entry.target);
            if (item && entry.target.clientWidth !== item.width) item.draw();
          }
        })
      : null;
  /** Calls `draw(width)` now and whenever the element's width changes. @param {any} element @param {(width: number) => void} draw @param {number} fallback */
  const fit = (element, draw, fallback) => {
    const item = {
      width: 0,
      draw() {
        item.width = element.clientWidth;
        draw(item.width || fallback);
      },
    };
    item.draw();
    sized.set(element, item);
    observer?.observe(element);
    return item;
  };

  const today = body?.published_at?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const viirsSwitch = body?.method?.viirs_switch ?? TIME.VIIRS_SWITCH;

  const timeline = byId("timeline");
  if (timeline) {
    fit(timeline, (width) => (timeline.innerHTML = timelineHtml(timelineLayout({ today, viirsSwitch, width }))), 640);
    const info = byId("timeline-info");
    const show = (event) => {
      const bar = event.target?.closest?.("[data-info]");
      if (bar && info) info.textContent = bar.getAttribute("data-info");
    };
    for (const type of ["mouseover", "focusin", "click"]) timeline.addEventListener(type, show);
  }

  const strength = byId("cameras-strength");
  if (strength) {
    const draw = (mw) => {
      const views = CAMERAS.map((camera) => cameraView(camera, mw));
      for (const view of views) {
        const panel = byId(`cameras-${view.camera.id}`);
        if (panel) panel.innerHTML = cameraSvg(view);
      }
      const counts = countsText({ modis: views[0].count, viirs: views[1].count });
      const shown = byId("cameras-counts");
      if (shown) shown.textContent = counts;
      const out = byId("cameras-strength-value");
      if (out) out.textContent = formatMw(mw);
      strength.setAttribute("aria-valuetext", `${formatMw(mw)}: ${counts}`);
    };
    draw(CAMERAS_DEFAULT_MW);
    strength.addEventListener("input", (event) => draw(10 ** Number(controlValue(event.target))));
  }

  mountCounted(body, doc, fit);

  const steps = byId("pipeline-steps");
  const detail = byId("pipeline-detail");
  if (steps && detail) {
    steps.innerHTML = pipelineHtml(PIPELINE_STEPS, PIPELINE_STEPS[0].id);
    detail.innerHTML = pipelineDetailHtml(PIPELINE_STEPS[0]);
    steps.addEventListener("click", (event) => {
      const button = event.target?.closest?.("[data-step]");
      if (!button) return;
      const id = button.getAttribute("data-step");
      for (const step of PIPELINE_STEPS) byId(`pipe-${step.id}`)?.setAttribute("aria-pressed", String(step.id === id));
      detail.innerHTML = pipelineDetailHtml(PIPELINE_STEPS.find((step) => step.id === id));
    });
    const run = byId("pipeline-run");
    if (run) run.textContent = `Figures from the run of ${formatDate(RUN.date)}, rounded.`;
  }

  const player = mountTests(body, doc, fit);
  return { observer, player };
}

/**
 * Diagram 3. Without a detection curve (the ratio method) the strength slider and the curve
 * are hidden, since every fire in a region and month then counts the same.
 * @param {MethodBody | null} body
 * @param {Document} doc
 * @param {(element: any, draw: (width: number) => void, fallback: number) => { draw: () => void }} fit
 */
function mountCounted(body, doc, fit) {
  const byId = (id) => doc.getElementById(id);
  const curveBox = byId("counted-curve");
  const equation = byId("counted-eq");
  if (!curveBox || !equation) return;
  if (!body) {
    equation.innerHTML = '<p class="chart-empty">Not available: the results did not load.</p>';
    return;
  }
  const curve = body.detection_curve ? allLandCurve(body.detection_curve) : null;
  const regions = body.regions;
  const state = {
    regionId: regions[0]?.id ?? "",
    month: Number((body.published_at ?? new Date().toISOString()).slice(5, 7)),
    frp: curve ? Math.min(Math.max(COUNTED_DEFAULT_MW, curve.frp[0]), curve.frp.at(-1)) : COUNTED_DEFAULT_MW,
  };
  const slider = byId("counted-strength");
  const region = byId("counted-region");
  const month = byId("counted-month");
  if (region) {
    region.innerHTML = regions
      .map((r) => `<option value="${escapeHtml(r.id)}"${r.id === state.regionId ? " selected" : ""}>${escapeHtml(r.name)}</option>`)
      .join("");
  }
  if (month) {
    month.innerHTML = MONTH_LONG.map((name, i) => `<option value="${i + 1}"${i + 1 === state.month ? " selected" : ""}>${name}</option>`).join("");
  }
  const strengthRow = byId("counted-strength-row");
  if (strengthRow) strengthRow.hidden = !curve;
  curveBox.hidden = !curve;
  if (curve && slider) {
    slider.setAttribute("min", String(Math.log10(curve.frp[0])));
    slider.setAttribute("max", String(Math.log10(curve.frp.at(-1))));
    slider.setAttribute("value", String(Math.log10(state.frp)));
  }
  const note = byId("counted-note");
  const chance = byId("counted-chance");
  let sized = null;
  const draw = () => {
    const model = countedModel({ curve, kTable: body.k_table, regionId: state.regionId, month: state.month, frp: state.frp });
    const name = regions.find((r) => r.id === state.regionId)?.name ?? state.regionId;
    equation.innerHTML = equationHtml(model, { place: `${name} in ${MONTH_LONG[state.month - 1]}` });
    if (chance) {
      chance.textContent =
        model.chance ?? "This data version uses the ratio method: every VIIRS fire in a region and month counts the same, whatever its strength.";
    }
    if (note) {
      note.hidden = model.factor !== null;
      note.textContent = body.k_table ? "No factor is published for this region and month." : "The region factors come with published data; the development mocks have none.";
    }
    const out = byId("counted-strength-value");
    if (out) out.textContent = formatMw(state.frp);
    slider?.setAttribute("aria-valuetext", `${formatMw(state.frp)}: ${model.chance ?? ""} ${model.result ?? ""}`.trim());
    sized?.draw();
  };
  if (curve) sized = fit(curveBox, (width) => (curveBox.innerHTML = curveSvg(curve, { width, frp: state.frp, p: curveAt(curve.frp, curve.p, state.frp) })), 560);
  draw();
  slider?.addEventListener("input", (event) => {
    state.frp = 10 ** Number(controlValue(event.target));
    draw();
  });
  region?.addEventListener("change", (event) => {
    state.regionId = controlValue(event.target);
    draw();
  });
  month?.addEventListener("change", (event) => {
    state.month = Number(controlValue(event.target));
    draw();
  });
}

/**
 * Diagram 5: Back, Play and Next step through the tests to the decision. Play pauses, and
 * starts again from the first test once the decision is showing.
 * @param {MethodBody | null} body
 * @param {Document} doc
 * @param {(element: any, draw: (width: number) => void, fallback: number) => { draw: () => void }} fit
 */
function mountTests(body, doc, fit) {
  const byId = (id) => doc.getElementById(id);
  const setText = (id, text) => {
    const element = byId(id);
    if (element) element.textContent = text;
  };
  const bars = byId("test-bars");
  if (!bars) return null;
  const model = body
    ? testSteps({ validation: body.validation, summary: body.validation_summary, regions: body.regions, shipped: body.method.weight_method })
    : null;
  const controls = byId("test-controls");
  if (!model) {
    if (controls) controls.hidden = true;
    bars.innerHTML = `<p class="chart-empty">${body ? "The test results are not published yet." : "Not available: the results did not load."}</p>`;
    return null;
  }
  const back = byId("test-back");
  const play = byId("test-play");
  const next = byId("test-next");
  const last = model.steps.length - 1;
  let index = 0;
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  const sized = fit(bars, (width) => (bars.innerHTML = testSvg(model.steps[index], { width })), 640);
  const show = (i) => {
    index = i;
    const step = model.steps[i];
    const text = stepText(step);
    const blocks = byId("test-blocks");
    if (blocks) blocks.innerHTML = yearBlocksHtml(model, step);
    setText("test-title", text.title);
    setText("test-text", text.text);
    setText("test-words", describeStep(step));
    sized.draw();
    if (back) back.disabled = i === 0;
    if (next) next.disabled = i === last;
  };
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (play) play.textContent = "Play";
  };
  const start = () => {
    if (index === last) show(0);
    if (play) play.textContent = "Pause";
    timer = setInterval(() => {
      show(index + 1);
      if (index === last) stop();
    }, STEP_MS);
  };
  show(0);
  back?.addEventListener("click", () => {
    stop();
    if (index > 0) show(index - 1);
  });
  next?.addEventListener("click", () => {
    stop();
    if (index < last) show(index + 1);
  });
  play?.addEventListener("click", () => (timer === null ? start() : stop()));
  return { model, show, stop, get index() { return index; }, get playing() { return timer !== null; } };
}
