import { config } from "../config";
import { installedService } from "../service/service";

/**
 * Raster image OCR rides on FirePDF and is switched on for the whole
 * deployment by `IMAGE_OCR_ENABLED`. Every entry point (URL-extension
 * routing, the browser handoff, parse uploads) consults this one check, so
 * with the switch off (or without a registered image engine) every request
 * gets the standard unsupported-file behaviour.
 */
export function isImageOcrEnabled(): boolean {
  if (!config.FIRE_PDF_BASE_URL || !config.IMAGE_OCR_ENABLED) {
    return false;
  }
  const svc = installedService();
  if (!svc) {
    return true;
  }
  return svc.engines
    .enabled()
    .some(engine => engine.features.image === true && !engine.cache);
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
 * Two conditions fold into it. The request's `parsers` must include the
 * `image` parser — it does by default, and a parse upload of an image counts
 * regardless — and the deployment switch must be on (see isImageOcrEnabled).
 */
export function shouldParseImages(parsers?: readonly unknown[]): boolean {
  if (!parsers) return true;
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
