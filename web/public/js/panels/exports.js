import { exportFilename } from "../../shared/contracts.js";
import { ApiError, postExport } from "../client-api.js";
import { h } from "./dom.js";

/**
 * @typedef {import("../../shared/contracts.js").CalendarRequest} CalendarRequest
 * @typedef {import("../../shared/contracts.js").CalendarResponse} CalendarResponse
 * @typedef {import("../../shared/contracts.js").Metadata} Metadata
 * @typedef {import("./messages.js").Message} Message
 * @typedef {{
 *   request: CalendarRequest,
 *   response: CalendarResponse,
 *   metadata: Metadata,
 *   view: import("../url-state.js").View,
 *   toPng: () => string,
 * }} ExportContext
 */

/** @param {string} csvName */
export const sidecarFilename = (csvName) => csvName.replace(/\.csv$/i, "") + ".metadata.json";

/**
 * @param {string} regionId
 * @param {string} start
 * @param {string} end
 * @param {string} view
 */
export const pngFilename = (regionId, start, end, view) => `hotornot_calendar_${regionId}_${start}_${end}_${view}.png`;

/**
 * The JSON saved next to each CSV: the `/api/metadata` body unchanged under `metadata`, plus the
 * request and area that produced the file, so the file can be reproduced.
 * @param {"hotspots" | "summary"} kind
 * @param {string} file
 * @param {ExportContext} context
 * @param {Date} [now]
 */
export function sidecar(kind, file, { request, response, metadata }, now = new Date()) {
  return {
    file,
    kind,
    exported_at: now.toISOString(),
    request,
    region_id: response.region_id,
    units: response.units,
    data_version: response.data_version,
    weight_method: response.weight_method,
    clipped_fraction: response.clipped_fraction,
    aoi: response.aoi,
    baseline: response.baseline,
    metadata,
  };
}

/** Object URLs of the last downloads, released when the next export starts. */
let liveUrls = [];

/**
 * @param {Blob} blob
 * @param {string} filename
 * @returns {string} the object URL, kept alive until the next export
 */
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  liveUrls.push(url);
  saveUrl(url, filename);
  return url;
}

/** @param {string} url @param {string} filename */
function saveUrl(url, filename) {
  const link = h("a", { href: url, download: filename, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * The download buttons and their status line.
 * @param {HTMLElement} container
 * @param {{ getContext: () => ExportContext | null, describeError: (error: ApiError) => Message }} options
 */
export function createExportsPanel(container, { getContext, describeError }) {
  const buttons = {
    hotspots: h("button", { type: "button", class: "button", "data-export": "hotspots", text: "Hotspots (CSV)" }),
    summary: h("button", { type: "button", class: "button", "data-export": "summary", text: "Monthly summary (CSV)" }),
    png: h("button", { type: "button", class: "button", "data-export": "png", text: "Calendar image (PNG)" }),
  };
  const status = h("div", { class: "exports__status", role: "status" });
  let busy = false;
  let ready = false;

  const list = h(
    "ul",
    { class: "exports__list" },
    h("li", {}, buttons.hotspots, h("span", { class: "exports__hint", text: "Every MODIS and VIIRS hotspot in the area and years, with its weight." })),
    h("li", {}, buttons.summary, h("span", { class: "exports__hint", text: "One row per month: value, median, anomaly, rank and flags." })),
    h("li", {}, buttons.png, h("span", { class: "exports__hint", text: "The calendar as drawn, with its title and legend." })),
  );
  container.replaceChildren(
    list,
    h("p", { class: "exports__note muted", text: "Each CSV is followed by a .metadata.json file with the data version, method and area." }),
    status,
  );

  const sync = () => {
    for (const button of Object.values(buttons)) button.disabled = busy || !ready;
  };

  /** @param {(Node | string)[]} parts */
  const say = (...parts) => status.replaceChildren(...parts);

  /** @param {"hotspots" | "summary"} kind */
  async function exportCsv(kind) {
    const context = getContext();
    if (!context) return;
    const label = kind === "hotspots" ? "hotspot CSV" : "monthly summary";
    say(`Preparing the ${label}…`);
    const { blob, filename } = await postExport(kind, context.request);
    const name = filename ?? exportFilename(kind, context.response.region_id, context.request.start, context.request.end);
    saveBlob(blob, name);
    const metaName = sidecarFilename(name);
    const metaBlob = new Blob([`${JSON.stringify(sidecar(kind, name, context), null, 2)}\n`], { type: "application/json" });
    const metaUrl = saveBlob(metaBlob, metaName);
    say(
      `Saved ${name} (${formatBytes(blob.size)}) and ${metaName}. If your browser blocked the second file, `,
      h("a", { href: metaUrl, download: metaName, text: "save the metadata file" }),
      ".",
    );
  }

  function exportPng() {
    const context = getContext();
    if (!context) return;
    const name = pngFilename(context.response.region_id, context.request.start, context.request.end, context.view);
    saveUrl(context.toPng(), name);
    say(`Saved ${name}.`);
  }

  for (const [kind, button] of Object.entries(buttons)) {
    button.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      sync();
      for (const url of liveUrls) URL.revokeObjectURL(url);
      liveUrls = [];
      try {
        if (kind === "png") exportPng();
        else await exportCsv(/** @type {"hotspots" | "summary"} */ (kind));
      } catch (error) {
        const message = describeError(error instanceof ApiError ? error : new ApiError("server_error", String(error)));
        say(h("strong", { text: message.title }), message.detail ? ` ${message.detail}` : "");
      } finally {
        busy = false;
        sync();
      }
    });
  }
  sync();

  return {
    /** @param {boolean} value whether a calendar is shown, so there is something to export */
    setReady(value) {
      ready = value;
      sync();
      if (!value) status.replaceChildren();
    },
  };
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
