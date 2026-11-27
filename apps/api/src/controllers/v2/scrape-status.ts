import type { Response } from "express";
import type { CrawlStatusParams, Document, RequestWithAuth } from "./types";
import { service } from "../../service";

interface ScrapeStatusRequest {
  params: { jobId?: string };
  auth: { team_id: string };
  ctx?: { zeroDataRetention?: boolean };
}

type ScrapeStatusBody =
  | { success: false; error: string }
  | { success: true; data: Document };

interface ScrapeStatusResponseWriter {
  status(code: number): {
    json(body: ScrapeStatusBody): void;
  };
}

export async function scrapeStatusController(
  req: ScrapeStatusRequest,
  res: ScrapeStatusResponseWriter,
): Promise<void>;
export async function scrapeStatusController(
  req: RequestWithAuth<CrawlStatusParams>,
  res: Response<ScrapeStatusBody>,
): Promise<void>;
export async function scrapeStatusController(
  req: ScrapeStatusRequest,
  res: ScrapeStatusResponseWriter,
): Promise<void> {
  const uuidReg =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!req.params.jobId || !uuidReg.test(req.params.jobId)) {
    res.status(400).json({
      success: false,
      error: "Invalid crawl ID",
    });
    return;
  }

  if (req.ctx?.zeroDataRetention === true) {
    res.status(400).json({
      success: false,
      error:
        "Your team has zero data retention enabled. This is not supported on scrape status. Please contact support@firecrawl.com to unblock this feature.",
    });
    return;
  }

  const owner = await service.modules.jobStore.owner(
    req.params.jobId,
    "scrape",
  );

  if (
    !owner ||
    (owner.expiresAtMs !== undefined && owner.expiresAtMs <= Date.now())
  ) {
    res.status(404).json({
      success: false,
      error: "Job not found.",
    });
    return;
  }

  const owned = owner.matchesTeam
    ? owner.matchesTeam(req.auth.team_id)
    : owner.teamId === req.auth.team_id;
  if (!owned) {
    res.status(403).json({
      success: false,
      error: "You are not allowed to access this resource.",
    });
    return;
  }

  const stored = await service.modules.jobStore.read(
    req.params.jobId,
    "scrape",
  );
  const data = stored?.document;

  if (!data) {
    res.status(404).json({
      success: false,
      error: "Job not found.",
    });
    return;
  }

  res.status(200).json({
    success: true,
    data,
  });
}
