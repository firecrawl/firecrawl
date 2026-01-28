import { Response } from "express";
import { z } from "zod";
import { config } from "../../config";
import { fetchFdwJobs, type FdwJobMode } from "../../lib/fdw/jobs";
import { isClickhouseConfigured } from "../../services/clickhouse";
import { ErrorResponse, RequestWithAuth } from "./types";

const MAX_WINDOW_DAYS = 90;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const fdwJobsQuerySchema = z.object({
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  mode: z
    .enum([
      "scrape",
      "crawl",
      "batch_scrape",
      "map",
      "search",
      "extract",
      "agent",
      "deep_research",
    ])
    .optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

const parseDateParam = (
  raw: string | undefined,
  kind: "start" | "end",
): Date | null => {
  if (!raw) {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  if (DATE_ONLY_REGEX.test(trimmed)) {
    const suffix = kind === "start" ? "T00:00:00Z" : "T23:59:59Z";
    const date = new Date(`${trimmed}${suffix}`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
};

export async function fdwJobsController(
  req: RequestWithAuth,
  res: Response<{ success: true; data: unknown[] } | ErrorResponse>,
) {
  if (!config.FIRECRAWL_FDW_ENABLED) {
    return res.status(404).json({
      success: false,
      error: "Not found",
    });
  }

  if (!isClickhouseConfigured()) {
    return res.status(503).json({
      success: false,
      error: "ClickHouse is not configured",
    });
  }

  const apiKeyId = req.acuc?.api_key_id;
  if (!apiKeyId) {
    return res.status(400).json({
      success: false,
      error: "API key scope not available",
    });
  }

  const parsed = fdwJobsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: "Invalid query parameters",
    });
  }

  const { start_date, end_date, mode, search, limit, offset } = parsed.data;

  if (!start_date || !end_date) {
    return res.status(400).json({
      success: false,
      error: "start_date and end_date are required",
    });
  }

  const startDate = parseDateParam(start_date, "start");
  const endDate = parseDateParam(end_date, "end");

  if (!startDate || !endDate) {
    return res.status(400).json({
      success: false,
      error: "Invalid start_date or end_date",
    });
  }

  const windowMs = endDate.getTime() - startDate.getTime();
  if (windowMs < 0) {
    return res.status(400).json({
      success: false,
      error: "end_date must be after start_date",
    });
  }

  const maxWindowMs = MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (windowMs > maxWindowMs) {
    return res.status(400).json({
      success: false,
      error: `Date range cannot exceed ${MAX_WINDOW_DAYS} days`,
    });
  }

  const limitValue = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const offsetValue = Math.max(offset ?? 0, 0);

  const data = await fetchFdwJobs({
    apiKeyId,
    startDate,
    endDate,
    mode: mode as FdwJobMode | undefined,
    search,
    limit: limitValue,
    offset: offsetValue,
  });

  return res.json({
    success: true,
    data,
  });
}
