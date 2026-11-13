import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixture } from "../../scripts/make-fixture.js";

let dir = null;

/**
 * Builds the W02 fixture (scripts/make-fixture.js) once per process in a fresh temporary
 * directory and returns that directory, ready for `DATA_BASE_URL`. Test files run in separate
 * processes, so each gets its own copy and none of them race on tests/fixtures/data/.
 */
export function fixtureDir() {
  if (!dir) {
    dir = mkdtempSync(join(tmpdir(), "hotornot-fixture-"));
    const built = dir;
    process.once("exit", () => rmSync(built, { recursive: true, force: true }));
    buildFixture(dir);
  }
  return dir;
}
