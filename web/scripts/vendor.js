// Downloads the pinned browser libraries into public/vendor/ and rewrites manifest.json. Run by
// hand when a version changes; the app itself never fetches from a CDN. npm files are checked
// against the SHA-256 that jsDelivr publishes for them.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const VENDOR = fileURLToPath(new URL("../public/vendor/", import.meta.url));

const FILES = [
  { name: "maplibre-gl", version: "5.24.1", license: "BSD-3-Clause", file: "maplibre-gl.js", path: "dist/maplibre-gl.js" },
  { name: "maplibre-gl", version: "5.24.1", license: "BSD-3-Clause", file: "maplibre-gl.css", path: "dist/maplibre-gl.css" },
  { name: "maplibre-gl", version: "5.24.1", license: "BSD-3-Clause", file: "licenses/maplibre-gl-LICENSE.txt", path: "LICENSE.txt" },
  { name: "echarts", version: "6.1.0", license: "Apache-2.0", file: "echarts.min.js", path: "dist/echarts.min.js" },
  { name: "echarts", version: "6.1.0", license: "Apache-2.0", file: "licenses/echarts-LICENSE.txt", path: "LICENSE" },
  { name: "echarts", version: "6.1.0", license: "Apache-2.0", file: "licenses/echarts-NOTICE.txt", path: "NOTICE" },
  { name: "terra-draw", version: "1.39.0", license: "MIT", file: "terra-draw.umd.js", path: "dist/terra-draw.umd.js" },
  {
    name: "terra-draw-maplibre-gl-adapter",
    version: "1.5.0",
    license: "MIT",
    file: "terra-draw-maplibre-gl-adapter.umd.js",
    path: "dist/terra-draw-maplibre-gl-adapter.umd.js",
  },
  // The terra-draw npm packages ship no LICENSE file; this is the one from the release tag.
  {
    name: "terra-draw",
    version: "1.39.0",
    license: "MIT",
    file: "licenses/terra-draw-LICENSE.txt",
    url: "https://cdn.jsdelivr.net/gh/JamesLMilner/terra-draw@terra-draw@1.39.0/LICENSE",
  },
];

async function fetchOk(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

const listings = new Map();
async function publishedHash(name, version, path) {
  const key = `${name}@${version}`;
  if (!listings.has(key)) {
    const response = await fetchOk(`https://data.jsdelivr.com/v1/packages/npm/${key}?structure=flat`);
    listings.set(key, (await response.json()).files);
  }
  const entry = listings.get(key).find((f) => f.name === `/${path}`);
  if (!entry) throw new Error(`${key} has no /${path}`);
  return Buffer.from(entry.hash, "base64").toString("hex");
}

const manifest = { source: "https://www.jsdelivr.com", files: [] };
for (const spec of FILES) {
  const url = spec.url ?? `https://cdn.jsdelivr.net/npm/${spec.name}@${spec.version}/${spec.path}`;
  const bytes = Buffer.from(await (await fetchOk(url)).arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (spec.path && !spec.url) {
    const expected = await publishedHash(spec.name, spec.version, spec.path);
    if (expected !== sha256) throw new Error(`${url}: sha256 ${sha256}, jsDelivr lists ${expected}`);
  }
  const target = `${VENDOR}${spec.file}`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  manifest.files.push({
    name: spec.name,
    version: spec.version,
    license: spec.license,
    file: spec.file,
    url,
    bytes: bytes.length,
    sha256,
  });
  console.log(`${spec.file}  ${bytes.length} bytes  ${sha256}`);
}
await writeFile(`${VENDOR}manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
