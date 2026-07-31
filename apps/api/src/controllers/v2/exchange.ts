import type { Response } from "express";
import { config } from "../../config";
import type { RequestWithAuth } from "./types";

/** Authenticated, deliberately zero-credit Exchange discovery proxy. */
export async function exchangeDiscoveryController(
  req: RequestWithAuth,
  res: Response,
) {
  if (!config.EXCHANGE_API_URL) {
    return res
      .status(503)
      .json({ success: false, error: "Exchange is not configured." });
  }

  const wildcard = (req.params as { path?: string | string[] }).path;
  const segments = Array.isArray(wildcard)
    ? wildcard
    : typeof wildcard === "string"
      ? wildcard.split("/")
      : [];
  if (
    segments.some(segment => !segment || segment === "." || segment === "..")
  ) {
    return res
      .status(400)
      .json({ success: false, error: "Invalid Exchange path." });
  }

  const target = new URL(
    segments.length ? `/v1/router/${segments.join("/")}` : "/v1/router",
    config.EXCHANGE_API_URL,
  );
  target.search = new URL(req.originalUrl, "http://localhost").search;

  // `req.accepts` treats */* as a match for its first candidate. Discovery's
  // stable default is JSON, so only select Markdown for an explicit request.
  const rawAccept = req.get("accept") ?? "";
  const accept =
    rawAccept !== "" &&
    rawAccept !== "*/*" &&
    req.accepts(["text/markdown", "application/json"]) === "text/markdown"
      ? "text/markdown"
      : "application/json";

  try {
    const upstream = await fetch(target, {
      headers: {
        Accept: accept,
        ...(config.EXCHANGE_API_TOKEN
          ? { Authorization: `Bearer ${config.EXCHANGE_API_TOKEN}` }
          : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await upstream.text();
    if (!body) {
      return res.status(upstream.status).json({
        success: false,
        error: "Exchange discovery request failed.",
      });
    }
    const contentType = upstream.headers.get("content-type");
    if (contentType) res.type(contentType);
    return res.status(upstream.status).send(body);
  } catch {
    return res.status(502).json({
      success: false,
      error: "Exchange discovery service is unavailable.",
    });
  }
}
