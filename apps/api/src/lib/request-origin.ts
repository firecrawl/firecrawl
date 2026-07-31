import type { Request } from "express";

function firstHeaderValue(
  req: Pick<Request, "headers">,
  key: string,
): string | undefined {
  const value = req.headers[key];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

export function requestOrigin(
  params: { origin?: string },
  req: Pick<Request, "headers">,
): string {
  return params.origin ?? firstHeaderValue(req, "x-origin") ?? "api";
}
