import crypto from "node:crypto";
import express, { Application, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { config } from "../config";
import { logger } from "../lib/logger";
import { resolveHighlightIndexObject } from "../search/highlights";

const BODY_LIMIT = "128kb";
const pageSchema = z
  .object({
    id: z.string().regex(/^(?:[0-9]|1[01])$/),
    url: z
      .string()
      .refine(value => Buffer.byteLength(value) <= 8 * 1024)
      .refine(value => {
        try {
          return ["http:", "https:"].includes(new URL(value).protocol);
        } catch {
          return false;
        }
      }),
  })
  .strict();
const requestSchema = z
  .object({ pages: z.array(pageSchema).min(1).max(12) })
  .strict()
  .superRefine(({ pages }, context) => {
    const ids = new Set<string>();
    const urls = new Set<string>();
    for (const [index, page] of pages.entries()) {
      if (ids.has(page.id)) {
        context.addIssue({
          code: "custom",
          message: "page IDs must be unique",
          path: ["pages", index, "id"],
        });
      }
      if (urls.has(page.url)) {
        context.addIssue({
          code: "custom",
          message: "page URLs must be unique",
          path: ["pages", index, "url"],
        });
      }
      ids.add(page.id);
      urls.add(page.url);
    }
  });

function bearerToken(value: string | string[] | undefined) {
  const header = Array.isArray(value) ? value[0] : value;
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

function tokenMatches(provided: string | null, expected: string) {
  if (!provided) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authenticate(req: Request, res: Response, next: NextFunction) {
  const expected = config.SEARCH_INDEX_LOOKUP_TOKEN;
  if (
    expected &&
    tokenMatches(bearerToken(req.headers.authorization), expected)
  ) {
    next();
    return;
  }
  logger.info("Indexed highlight lookup rejected", {
    canonicalLog: "internal/indexed-highlight-objects",
    outcome: "unauthorized",
    requestId: req.headers["x-request-id"],
    timeTakenMs: 0,
  });
  res.status(401).json({ error: "Unauthorized" });
}

function rejectInvalid(
  req: Request,
  res: Response,
  start: number,
  error: "Invalid request body" | "Invalid request",
) {
  logger.info("Indexed highlight lookup rejected", {
    canonicalLog: "internal/indexed-highlight-objects",
    outcome: "invalid",
    requestId: req.headers["x-request-id"],
    timeTakenMs: Date.now() - start,
  });
  res.status(400).json({ error });
}

// Malformed JSON and bodies over BODY_LIMIT are the caller's fault. Answer
// them here so they never reach the app-wide error handler or Sentry.
const jsonBody = express.json({ limit: BODY_LIMIT, type: () => true });

function parseBody(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  jsonBody(req, res, error => {
    if (error) {
      rejectInvalid(req, res, start, "Invalid request body");
      return;
    }
    next();
  });
}

async function resolve(req: Request, res: Response) {
  const start = Date.now();
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    rejectInvalid(req, res, start, "Invalid request");
    return;
  }

  const pages = await Promise.all(
    parsed.data.pages.map(async page => {
      try {
        const object = await resolveHighlightIndexObject(page.url);
        return object
          ? {
              id: page.id,
              url: page.url,
              outcome: "hit" as const,
              indexObject: object.name,
            }
          : { id: page.id, url: page.url, outcome: "miss" as const };
      } catch {
        return { id: page.id, url: page.url, outcome: "error" as const };
      }
    }),
  );
  const hits = pages.filter(page => page.outcome === "hit").length;
  const misses = pages.filter(page => page.outcome === "miss").length;
  const errors = pages.length - hits - misses;
  logger.info("Indexed highlight lookup completed", {
    canonicalLog: "internal/indexed-highlight-objects",
    outcome: "completed",
    requestId: req.headers["x-request-id"],
    attempted: pages.length,
    hits,
    misses,
    errors,
    timeTakenMs: Date.now() - start,
  });
  res.json({ pages });
}

export function registerIndexedHighlightObjectRoute(
  app: Pick<Application, "post">,
) {
  app.post(
    "/internal/indexed-highlight-objects",
    authenticate,
    parseBody,
    (req, res, next) => {
      resolve(req, res).catch(next);
    },
  );
}
