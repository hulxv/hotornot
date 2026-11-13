// Warms a deployment before a demo: asks for every region preset's calendar (harmonized and
// raw) and current month with exactly the requests the page sends, so the function's calendar
// cache holds them, then asks again to show the warm times. On Vercel each function instance
// has its own cache, so this warms the instances that answer.
//
//   node scripts/prewarm.js https://hotornot.example.app [--rounds=2]
import { pathToFileURL } from "node:url";
import { calendarBody } from "../public/js/client-api.js";
import { DEFAULT_STATE, areaPolygon } from "../public/js/url-state.js";

/**
 * @typedef {import("../public/shared/contracts.js").Metadata} Metadata
 * @typedef {{ name: string, path: string, body?: unknown }} Call
 * @typedef {Call & { status: number, ms: number, cache: string | null, bytes: number }} Result
 */

/**
 * The calls the page makes for each region preset in its default view and in the raw view, plus
 * the method page's data.
 * @param {Metadata} metadata
 * @returns {Call[]}
 */
export function prewarmCalls(metadata) {
  /** @type {Call[]} */
  const calls = [{ name: "metadata", path: "/api/metadata" }];
  for (const region of metadata.regions) {
    const aoi = /** @type {import("../public/shared/contracts.js").Aoi} */ (areaPolygon({ kind: "preset" }, region));
    for (const series of /** @type {const} */ (["harmonized", "raw"])) {
      const state = { ...DEFAULT_STATE, region: region.id, view: series === "raw" ? "raw" : "harmonized", series };
      calls.push({ name: `${region.id} calendar ${series}`, path: "/api/calendar", body: calendarBody(aoi, state, metadata) });
    }
    calls.push({ name: `${region.id} current month`, path: "/api/current-month", body: { aoi } });
  }
  calls.push({ name: "method", path: "/api/method" });
  return calls;
}

/**
 * @param {string} base
 * @param {Call} call
 * @returns {Promise<Result>}
 */
export async function runCall(base, call) {
  const started = performance.now();
  const init =
    call.body === undefined
      ? undefined
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(call.body) };
  try {
    const response = await fetch(new URL(call.path, base), init);
    const bytes = (await response.arrayBuffer()).byteLength;
    return { ...call, status: response.status, ms: performance.now() - started, cache: response.headers.get("x-hotornot-cache"), bytes };
  } catch (error) {
    return { ...call, status: 0, ms: performance.now() - started, cache: String(error.cause?.code ?? error.message), bytes: 0 };
  }
}

/**
 * @param {string} base
 * @param {{ rounds?: number, log?: (line: string) => void }} [options]
 * @returns {Promise<Result[][]>} one list of results per round
 */
export async function prewarm(base, { rounds = 2, log = () => {} } = {}) {
  const metadataResponse = await fetch(new URL("/api/metadata", base));
  if (!metadataResponse.ok) throw new Error(`${base}/api/metadata answered ${metadataResponse.status}`);
  if (metadataResponse.headers.get("x-hotornot-data") === "mock") log("note: the server answers with mock data (nothing is published)");
  const calls = prewarmCalls(await metadataResponse.json());
  const all = [];
  for (let round = 1; round <= rounds; round += 1) {
    const results = [];
    for (const call of calls) {
      const result = await runCall(base, call);
      results.push(result);
      log(
        `round ${round}  ${String(result.status).padEnd(4)}${`${result.ms.toFixed(0)} ms`.padStart(9)}  ` +
          `${(result.cache ?? "").padEnd(5)}${`${(result.bytes / 1024).toFixed(1)} KB`.padStart(10)}  ${result.name}`,
      );
    }
    all.push(results);
  }
  return all;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.argv.slice(2).find((arg) => /^https?:\/\//.test(arg));
  const roundsArg = process.argv.slice(2).find((arg) => arg.startsWith("--rounds="));
  if (!base) {
    console.error("usage: node scripts/prewarm.js <base-url> [--rounds=2]");
    process.exit(2);
  }
  const rounds = await prewarm(base, { rounds: roundsArg ? Number(roundsArg.slice("--rounds=".length)) : 2, log: console.log });
  const failed = rounds.flat().filter((result) => result.status !== 200);
  const last = rounds.at(-1) ?? [];
  console.log(
    `${failed.length === 0 ? "ok" : `${failed.length} failed`}: ${last.length} calls per round, ` +
      `last round ${last.reduce((sum, result) => sum + result.ms, 0).toFixed(0)} ms in all`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}
