import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import manifest from "../public/vendor/manifest.json" with { type: "json" };

const VENDOR = new URL("../public/vendor/", import.meta.url);

describe("public/vendor", () => {
  for (const entry of manifest.files) {
    it(`${entry.file} matches its pinned SHA-256`, async () => {
      const bytes = await readFile(new URL(entry.file, VENDOR));
      assert.equal(bytes.length, entry.bytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
    });
  }

  it("pins exact versions and sources", () => {
    for (const entry of manifest.files) {
      assert.match(entry.version, /^\d+\.\d+\.\d+$/, entry.file);
      assert.ok(entry.url.startsWith("https://cdn.jsdelivr.net/"), entry.file);
      assert.ok(entry.url.includes(`@${entry.version}`), entry.file);
    }
  });

  it("lists every vendored file and the required libraries", async () => {
    const files = (await readdir(VENDOR, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name !== "manifest.json")
      .map((entry) => relative(fileURLToPath(VENDOR), join(entry.parentPath, entry.name)))
      .sort();
    assert.deepEqual(files, manifest.files.map((entry) => entry.file).sort());
    for (const required of ["maplibre-gl.js", "maplibre-gl.css", "echarts.min.js"]) {
      assert.ok(files.includes(required), required);
    }
  });
});
