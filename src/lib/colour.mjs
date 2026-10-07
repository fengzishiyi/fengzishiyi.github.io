/**
 * colour.mjs — the contrast maths behind the design check.
 *
 * None of this renders anything. It exists so the design contract can be
 * measured on the values that actually render — read out of the stylesheets —
 * rather than on a guess about what they are.
 */

export function luminance([r, g, b]) {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a, b) {
  const l1 = luminance(a), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export const over = (top, alpha, base) => top.map((c, i) => c * alpha + base[i] * (1 - alpha));
export const toHex = (rgb) => "#" + rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");

/** Read a `--name: #rrggbb` custom property out of a stylesheet so contrast can
 *  be measured on the value that actually renders rather than a guess. */
export function hexFrom(css, name, fallback) {
  const m = new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6})`).exec(css);
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Read a `--name: rgba(r, g, b, a)` custom property. The chips are the only
 *  chromatic surfaces on the site and they are all translucent, so a check that
 *  cannot read an alpha channel cannot check them at all. */
export function rgbaFrom(css, name, fallback) {
  const m = new RegExp(`--${name}:\\s*rgba\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*([\\d.]+)\\s*\\)`).exec(css);
  if (!m) return fallback;
  return { rgb: [+m[1], +m[2], +m[3]], alpha: +m[4] };
}

/** Flatten a translucent fill onto an opaque ground: what the reader's eye gets
 *  is the composite, and the composite is what contrast must be measured on. */
export const flatten = ({ rgb, alpha }, base) => rgb.map((c, i) => c * alpha + base[i] * (1 - alpha));
