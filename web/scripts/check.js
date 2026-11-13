// Syntax check with `node --check` for every .js file outside public/vendor/. There is no
// linter: nothing can be installed from npm.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["public/vendor", "public/data", "node_modules"].map((dir) => join(ROOT, dir)));

function* jsFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(path) && !entry.name.startsWith(".")) yield* jsFiles(path);
    } else if (entry.name.endsWith(".js")) {
      yield path;
    }
  }
}

let checked = 0;
let failed = 0;
for (const file of jsFiles(ROOT)) {
  checked += 1;
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    failed += 1;
    process.stderr.write(`${relative(ROOT, file)}\n${error.stderr}\n`);
  }
}
console.log(`node --check: ${checked - failed} of ${checked} files ok`);
process.exitCode = failed > 0 ? 1 : 0;
