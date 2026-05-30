import type { Request } from "express";

const SESSION_ID_HEADER = "x-firecrawl-session-id";

export function getSessionId(req: Request): string | null {
  const raw = req.headers[SESSION_ID_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 128);
}
