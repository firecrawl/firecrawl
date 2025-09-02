import type { Request, Response } from "express";
import { getPrecrawlQueue } from "../../../services/queue-service";

export async function triggerPrecrawl(_: Request, res: Response) {
  await getPrecrawlQueue().add(new Date().toISOString(), {});
  res.json({ ok: true });
}
