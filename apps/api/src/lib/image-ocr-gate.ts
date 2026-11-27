import { installedService } from "../service/service";

/**
 * Raster image OCR is available whenever the active service registers an
 * enabled non-cache engine with the `image` capability. Every entry point
 * (URL-extension routing, the browser handoff, parse uploads) consults this
 * check so deployments without an enabled image engine return the standard
 * unsupported-file response.
 */
export function isImageOcrEnabled(): boolean {
  const svc = installedService();
  if (!svc) {
    return false;
  }
  return svc.engines
    .all()
    .some(
      engine =>
        engine.features.image === true && !engine.cache && engine.enabled(),
    );
}

/**
 * Per-scrape gate. Async so the callers that consult it late (the browser
 * handoff sniff, the image engine, the index) share one shape even though
 * the answer is known when the scrape starts.
 */
export type ImageOcrGate = () => Promise<boolean>;

/**
 * Builds the per-scrape gate: whether this request may OCR raster images.
 *
 * Two conditions fold into it: the request's `parsers` must include the
 * `image` parser (the default, and parse uploads of an image always count),
 * and an image-capable engine must be enabled (see isImageOcrEnabled).
 */
export function shouldParseImages(parsers?: ReadonlyArray<unknown>): boolean {
  if (!parsers) {
    return true;
  }
  return parsers.some(
    parser =>
      parser === "image" ||
      (typeof parser === "object" &&
        parser !== null &&
        (parser as { type?: unknown }).type === "image"),
  );
}

export function imageOcrGate(requested: boolean): ImageOcrGate {
  const enabled = Promise.resolve(requested && isImageOcrEnabled());
  return () => enabled;
}
