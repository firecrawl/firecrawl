import { getComputedStyleCached, recordError } from "./helpers";

export interface LogoColor {
  /** #RRGGBB */
  color: string;
  /** Share of the logo's painted area, 0–1. */
  share: number;
}

const MAX_COLORS = 4;
const MIN_SHARE = 0.03;
const SAMPLE_PX = 64;

const toHex = (r: number, g: number, b: number): string =>
  "#" +
  [r, g, b]
    .map(v => Math.round(v).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

// Paint the browser computes in a newer color syntax (lab(), oklch(),
// color(display-p3 ...): Tailwind v4 and many design systems) is converted to
// sRGB by drawing it on a 1x1 canvas and reading the pixel back.
let paintCtx: CanvasRenderingContext2D | null | undefined;
const canvasColorCache = new Map<string, [number, number, number] | null>();
const viaCanvas = (paint: string): [number, number, number] | null => {
  if (canvasColorCache.has(paint)) return canvasColorCache.get(paint)!;
  let rgb: [number, number, number] | null = null;
  try {
    if (typeof CSS !== "undefined" && CSS.supports?.("color", paint)) {
      if (paintCtx === undefined) {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        paintCtx = canvas.getContext("2d", { willReadFrequently: true });
      }
      if (paintCtx) {
        paintCtx.clearRect(0, 0, 1, 1);
        paintCtx.fillStyle = paint;
        paintCtx.fillRect(0, 0, 1, 1);
        const d = paintCtx.getImageData(0, 0, 1, 1).data;
        rgb = d[3] >= 128 ? [d[0], d[1], d[2]] : null;
      }
    }
  } catch {
    rgb = null;
  }
  canvasColorCache.set(paint, rgb);
  return rgb;
};

/** A solid paint as the browser computes it, as RGB, or null if not one. */
const parsePaint = (paint: string): [number, number, number] | null => {
  const m = paint.match(/^rgba?\(([^)]+)\)$/);
  if (!m) {
    return /^(lab|lch|oklab|oklch|color|hsla?|hwb)\(/.test(paint)
      ? viaCanvas(paint)
      : null;
  }
  const parts = m[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(parseFloat);
  if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
  if (parts.length >= 4 && parts[3] < 0.5) return null;
  return [parts[0], parts[1], parts[2]];
};

const rgbOf = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

// Shades closer than this count as one color: anti-aliased edges and
// gradients split a logo's color into many near-identical ones.
const SAME_COLOR = 40;

const ranked = (weights: Map<string, number>): LogoColor[] => {
  const total = [...weights.values()].reduce((s, w) => s + w, 0);
  if (total <= 0) return [];
  const merged: Array<{ color: string; rgb: number[]; weight: number }> = [];
  [...weights.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([color, weight]) => {
      const rgb = rgbOf(color);
      const same = merged.find(
        m =>
          Math.hypot(m.rgb[0] - rgb[0], m.rgb[1] - rgb[1], m.rgb[2] - rgb[2]) <
          SAME_COLOR,
      );
      if (same) same.weight += weight;
      else merged.push({ color, rgb, weight });
    });
  return merged
    .map(({ color, weight }) => ({
      color,
      share: Math.round((weight / total) * 100) / 100,
    }))
    .filter(c => c.share >= MIN_SHARE)
    .sort((a, b) => b.share - a.share)
    .slice(0, MAX_COLORS);
};

// Definitions, clip paths and masks shape the logo but aren't painted. Tag
// names compared in lowercase: selectors match camel-case SVG names unevenly.
const UNPAINTED = new Set([
  "defs",
  "clippath",
  "mask",
  "symbol",
  "pattern",
  "marker",
]);

const isUnpainted = (shape: Element, svg: Element): boolean => {
  for (let n = shape.parentElement; n && n !== svg; n = n.parentElement) {
    if (UNPAINTED.has(n.localName.toLowerCase())) return true;
  }
  return false;
};

/**
 * The stop colors of a gradient paint (`url(#id)`), following one `href` to
 * a gradient that holds the stops; null when the paint isn't a gradient.
 */
const gradientStops = (paint: string, svg: Element): string[] | null => {
  const id = paint.match(/^url\(["']?#([^"')]+)["']?\)/)?.[1];
  if (!id) return null;
  // The SVG's own root: a logo inside a shadow root defines its gradients
  // there, out of the document's sight.
  const root = svg.getRootNode() as Document | ShadowRoot;
  const byId = (ref: string) =>
    root.getElementById?.(ref) ?? svg.ownerDocument.getElementById(ref);
  let gradient: Element | null = byId(id);
  for (let hop = 0; gradient && hop < 2; hop++) {
    if (!/gradient$/i.test(gradient.localName)) return null;
    const stops = [...gradient.querySelectorAll("stop")];
    if (stops.length > 0) {
      return stops
        .filter(
          stop => parseFloat(getComputedStyleCached(stop).stopOpacity) >= 0.5,
        )
        .map(stop => getComputedStyleCached(stop).stopColor);
    }
    const ref = (
      gradient.getAttribute("href") ??
      gradient.getAttribute("xlink:href") ??
      ""
    ).replace(/^#/, "");
    gradient = ref ? byId(ref) : null;
  }
  return null;
};

/** Fill and stroke colors of an inline SVG's shapes, weighted by their area. */
const svgColors = (svg: SVGSVGElement): LogoColor[] => {
  const weights = new Map<string, number>();
  const shapes = svg.querySelectorAll(
    "path, rect, circle, ellipse, polygon, polyline, line, text, use",
  );
  shapes.forEach(shape => {
    if (isUnpainted(shape, svg)) return;
    const cs = getComputedStyleCached(shape);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    if (parseFloat(cs.opacity) < 0.5) return;
    let area = 1;
    try {
      const box = (shape as SVGGraphicsElement).getBBox();
      area = Math.max(1, box.width * box.height);
    } catch {
      // Not rendered: count it once.
    }
    const add = (paint: string, weight: number) => {
      const stops = gradientStops(paint, svg);
      if (stops) {
        stops.forEach(stop => add(stop, weight / stops.length));
        return;
      }
      const rgb = parsePaint(paint);
      if (!rgb) return;
      const hex = toHex(...rgb);
      weights.set(hex, (weights.get(hex) ?? 0) + weight);
    };
    if (parseFloat(cs.fillOpacity) >= 0.5) add(cs.fill, area);
    if (parseFloat(cs.strokeWidth) > 0 && parseFloat(cs.strokeOpacity) >= 0.5)
      add(cs.stroke, area * 0.1);
  });
  return ranked(weights);
};

/**
 * Colors of a loaded image, from a small copy on a canvas. Images from
 * another origin without CORS can't be read and return nothing.
 */
const imageColors = (
  img: HTMLImageElement,
  readLater?: () => void,
): LogoColor[] => {
  if (!img.complete) return [];
  // An SVG file without a size of its own still draws at any size.
  const natW =
    img.naturalWidth || (/\.svg(\?|#|$)/i.test(img.src) ? SAMPLE_PX : 0);
  const natH = img.naturalHeight || (natW ? natW : 0);
  if (!natW || !natH) return [];
  const scale = Math.min(1, SAMPLE_PX / Math.max(natW, natH));
  const w = Math.max(1, Math.round(natW * scale));
  const h = Math.max(1, Math.round(natH * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  let data: Uint8ClampedArray;
  try {
    ctx.drawImage(img, 0, 0, w, h);
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    readLater?.(); // another origin, read without CORS
    return [];
  }
  // Group pixels into 4-bit-per-channel buckets; report each bucket's average.
  const buckets = new Map<
    number,
    { n: number; r: number; g: number; b: number }
  >();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const key =
      ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n++;
    bucket.r += data[i];
    bucket.g += data[i + 1];
    bucket.b += data[i + 2];
    buckets.set(key, bucket);
  }
  const weights = new Map<string, number>();
  buckets.forEach(b => {
    const hex = toHex(b.r / b.n, b.g / b.n, b.b / b.n);
    weights.set(hex, (weights.get(hex) ?? 0) + b.n);
  });
  return ranked(weights);
};

// Logo images from another origin can't be read as loaded, but most CDNs
// allow a CORS read: they're loaded again with crossOrigin after the scan and
// their colors filled in then (see readCrossOriginLogoColors).
const crossOrigin: Array<{ url: string; set: (colors: LogoColor[]) => void }> =
  [];

/**
 * The colors a logo is drawn in, most used first, when they can be read.
 * `set` receives colors read later from a cross-origin image.
 */
export const getLogoColors = (
  el: Element,
  set?: (colors: LogoColor[]) => void,
): LogoColor[] => {
  try {
    if (el instanceof SVGSVGElement) return svgColors(el);
    if (el instanceof HTMLImageElement) {
      return imageColors(el, () => {
        const url = el.currentSrc || el.src;
        if (set && url) crossOrigin.push({ url, set });
      });
    }
    // A logo drawn as a CSS background: read the image when the browser
    // already has it (an image it still has to load reads as nothing).
    const url = getComputedStyleCached(el).backgroundImage.match(
      /url\(["']?([^"')]+)["']?\)/,
    )?.[1];
    if (url) {
      const img = new Image();
      img.src = url;
      const readLater = () => {
        if (set) crossOrigin.push({ url: img.src, set });
      };
      // The browser may not have the background image ready yet: read it
      // after the scan, like a cross-origin one.
      if (!img.complete) {
        readLater();
        return [];
      }
      return imageColors(img, readLater);
    }
  } catch (e) {
    recordError("getLogoColors", e);
  }
  return [];
};

/**
 * Loads the cross-origin logo images found during the scan again with CORS
 * and fills in their colors, waiting at most `timeoutMs`. Null when there are
 * none, so the scan stays synchronous on most pages.
 */
export const readCrossOriginLogoColors = (
  timeoutMs: number,
): Promise<void> | null => {
  if (crossOrigin.length === 0) return null;
  const pending = crossOrigin.splice(0);
  const loads = pending.map(
    ({ url, set }) =>
      new Promise<void>(resolve => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          try {
            const colors = imageColors(img);
            if (colors.length > 0) set(colors);
          } catch (e) {
            recordError("readCrossOriginLogoColors", e);
          }
          resolve();
        };
        img.onerror = () => resolve();
        img.src = url;
      }),
  );
  return Promise.race([
    Promise.all(loads).then(() => undefined),
    new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
  ]);
};
