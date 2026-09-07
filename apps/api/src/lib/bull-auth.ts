import crypto from "node:crypto";
import { NextFunction, Request, RequestHandler, Response } from "express";

export function secretsMatch(
  provided: string | null | undefined,
  expected?: string,
): boolean {
  if (!provided || !expected) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** Express path for `/admin/<key><rest>` with one `:bullAuthN` per non-empty key segment. */
export function bullAuthRoute(key: string, rest: string): string {
  const params = key
    .split("/")
    .map((s, i) => (s === "" ? "" : `:bullAuth${i}`))
    .join("/");
  return `/admin/${params}${rest}`;
}

export function createRequireBullAuth(expected: string): RequestHandler {
  const segs = expected.split("/");
  return (req: Request, res: Response, next: NextFunction) => {
    const parts: string[] = [];
    for (let i = 0; i < segs.length; i++) {
      if (segs[i] === "") {
        parts.push("");
        continue;
      }
      const p = req.params[`bullAuth${i}`];
      if (typeof p !== "string") {
        return res.status(404).json({ error: "Not found" });
      }
      parts.push(p);
    }
    if (!secretsMatch(parts.join("/"), expected)) {
      return res.status(404).json({ error: "Not found" });
    }
    return next();
  };
}
