import type { Request } from "express";
import { logger } from "./logger";

/**
 * Longest External-Request-Id we will carry (bytes). Generous — an operation
 * id is an id, not a document — and the ceiling exists so a caller bug cannot
 * push arbitrary payloads into the requests table.
 */
export const EXTERNAL_REQUEST_ID_MAX_BYTES = 2048;

/**
 * The opaque per-operation id a caller attached to this request, if it sent
 * one and it is usable.
 *
 * Some integrations stamp the requests they proxy with an
 * `External-Request-Id` header so usage can be attributed back to their own
 * operations. It is stored on the `requests` row at receipt (`logRequest`)
 * and read back later by internal billing, keyed by the request id billing
 * events already carry — it is deliberately NOT threaded through job data.
 *
 * Never a 400: a customer's request must not fail over telemetry. An id that
 * is too long is dropped, loudly, and the request proceeds — the consequence
 * is a missing attribution label, which is a reporting gap, not an outage.
 *
 * The value is opaque. No parsing, no interpretation, forwarded verbatim.
 */
export function externalRequestId(
  req: Pick<Request, "headers">,
): string | null {
  const raw = req.headers["external-request-id"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== "string") return null;

  const value = first.trim();
  if (value.length === 0) return null;

  if (Buffer.byteLength(value) > EXTERNAL_REQUEST_ID_MAX_BYTES) {
    logger.warn(
      "External-Request-Id is too long; dropping it and serving the request anyway",
      {
        module: "external-request-id",
        bytes: Buffer.byteLength(value),
        max: EXTERNAL_REQUEST_ID_MAX_BYTES,
      },
    );
    return null;
  }

  return value;
}
