/** @typedef {[number, number, number]} Rgb sRGB channels in [0, 1] */
/** @typedef {"deuteranopia" | "protanopia" | "tritanopia"} CvdKind */

/** @returns {Rgb} */
export function parseHex(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new TypeError(`expected a #rrggbb color, got ${hex}`);
  return /** @type {Rgb} */ ([0, 2, 4].map((i) => parseInt(match[1].slice(i, i + 2), 16) / 255));
}

/** @param {Rgb} rgb */
export function toHex(rgb) {
  return `#${rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Linear interpolation in sRGB between evenly spaced stops; `t` is clamped to [0, 1].
 * @param {readonly string[]} stops
 * @param {number} t
 */
export function rampColor(stops, t) {
  const position = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(position));
  const f = position - i;
  const a = parseHex(stops[i]);
  const b = parseHex(stops[i + 1]);
  return toHex(/** @type {Rgb} */ (a.map((c, k) => c + (b[k] - c) * f)));
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** WCAG 2.x relative luminance. */
export function relativeLuminance(hex) {
  const [r, g, b] = parseHex(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, from 1 to 21. */
export function contrastRatio(a, b) {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/**
 * The one of `dark` and `light` with the higher contrast against `fill`. With black and white
 * the winner is always at least 4.58:1.
 */
export function markColor(fill, dark = "#000000", light = "#ffffff") {
  return contrastRatio(fill, dark) >= contrastRatio(fill, light) ? dark : light;
}

// Above this luminance black contrasts more than white: sqrt(1.05 * 0.05) - 0.05.
const MID_LUMINANCE = 0.179;

/**
 * The outline for a fill too close to the background to stand out on its own (WCAG 1.4.11):
 * the fill mixed toward black on a light background, or toward white on a dark one, just far
 * enough to reach `min` against the background. Null when the fill reaches it already.
 * @param {string} fill
 * @param {string} background
 * @param {number} [min]
 * @returns {string | null}
 */
export function edgeColor(fill, background, min = 3) {
  if (contrastRatio(fill, background) >= min) return null;
  const toward = relativeLuminance(background) > MID_LUMINANCE ? 0 : 1;
  const rgb = parseHex(fill);
  for (let step = 1; step <= 50; step += 1) {
    const mixed = toHex(/** @type {Rgb} */ (rgb.map((c) => c + (toward - c) * (step / 50))));
    if (contrastRatio(mixed, background) >= min) return mixed;
  }
  return toward === 0 ? "#000000" : "#ffffff";
}

/**
 * Machado, Oliveira and Fernandes (2009), severity 1.0, applied to linear RGB.
 * @type {Readonly<Record<CvdKind, number[][]>>}
 */
export const CVD_MATRICES = Object.freeze({
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
});

/** @param {string} hex @param {CvdKind} kind */
export function simulateCvd(hex, kind) {
  const linear = parseHex(hex).map(toLinear);
  const matrix = CVD_MATRICES[kind];
  return toHex(
    /** @type {Rgb} */ (matrix.map((row) => toGamma(Math.min(1, Math.max(0, row[0] * linear[0] + row[1] * linear[1] + row[2] * linear[2]))))),
  );
}

/** CIELAB with a D65 white. @returns {[number, number, number]} */
export function toLab(hex) {
  const [r, g, b] = parseHex(hex).map(toLinear);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIEDE2000 color difference; about 2 is just noticeable, above 10 reads as a different color. */
export function deltaE2000(hexA, hexB) {
  const [L1, a1, b1] = toLab(hexA);
  const [L2, a2, b2] = toLab(hexB);
  const rad = Math.PI / 180;
  const meanC = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(meanC ** 7 / (meanC ** 7 + 25 ** 7)));
  const [a1p, a2p] = [a1 * (1 + g), a2 * (1 + g)];
  const [C1, C2] = [Math.hypot(a1p, b1), Math.hypot(a2p, b2)];
  const hue = (b, a) => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const [h1, h2] = [hue(b1, a1p), hue(b2, a2p)];
  let dh = 0;
  if (C1 * C2 !== 0) dh = h2 - h1 > 180 ? h2 - h1 - 360 : h2 - h1 < -180 ? h2 - h1 + 360 : h2 - h1;
  const dL = L2 - L1;
  const dC = C2 - C1;
  const dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh / 2) * rad);
  const meanL = (L1 + L2) / 2;
  const meanCp = (C1 + C2) / 2;
  let meanH = h1 + h2;
  if (C1 * C2 !== 0) meanH = Math.abs(h1 - h2) > 180 ? (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2 : (h1 + h2) / 2;
  const t =
    1 -
    0.17 * Math.cos((meanH - 30) * rad) +
    0.24 * Math.cos(2 * meanH * rad) +
    0.32 * Math.cos((3 * meanH + 6) * rad) -
    0.2 * Math.cos((4 * meanH - 63) * rad);
  const rotation = 30 * Math.exp(-(((meanH - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(meanCp ** 7 / (meanCp ** 7 + 25 ** 7));
  const sl = 1 + (0.015 * (meanL - 50) ** 2) / Math.sqrt(20 + (meanL - 50) ** 2);
  const sc = 1 + 0.045 * meanCp;
  const sh = 1 + 0.015 * meanCp * t;
  const rt = -Math.sin(2 * rotation * rad) * rc;
  return Math.sqrt((dL / sl) ** 2 + (dC / sc) ** 2 + (dH / sh) ** 2 + rt * (dC / sc) * (dH / sh));
}
