const libraries = [
  ["MapLibre GL", () => globalThis.maplibregl?.getVersion?.()],
  ["terra-draw", () => (globalThis.terraDraw?.TerraDraw ? "loaded" : undefined)],
  ["terra-draw MapLibre adapter", () => (globalThis.terraDrawMaplibreGlAdapter ? "loaded" : undefined)],
  ["ECharts", () => globalThis.echarts?.version],
];

const status = document.getElementById("vendor-status");
const wanted = (status?.dataset.libraries ?? "").split(",");
if (status) {
  status.textContent = libraries
    .filter(([name]) => wanted.includes(name))
    .map(([name, version]) => `${name}: ${version() ?? "missing"}`)
    .join(" · ");
}
