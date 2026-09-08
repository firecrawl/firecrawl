import type { NextFunction, Request, Response } from "express";
import { parse } from "tldts";
import { isUrlBlocked } from "../scraper/WebScraper/utils/blocklist";
import type { RequestWithAuth } from "../controllers/v1/types";

export function bountyDomains(body: Record<string, unknown>): string[] {
  const fields = [
    body.title,
    body.description,
    ...(Array.isArray(body.requirements) ? body.requirements : []),
  ];
  const domains = new Set<string>();
  for (const field of fields) {
    if (typeof field !== "string") continue;
    const candidates = [
      ...field.matchAll(/https?:\/\/[^\s<>"']+/giu),
      ...field.matchAll(
        /(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}][\p{L}\p{N}-]*/gu,
      ),
    ];
    for (const candidate of candidates) {
      try {
        const url = new URL(
          /^https?:\/\//i.test(candidate[0])
            ? candidate[0]
            : `https://${candidate[0]}`,
        );
        const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
        if (parse(hostname).domain) domains.add(hostname);
      } catch {}
    }
  }
  return [...domains];
}

export function bountyBlocklistMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const request = req as RequestWithAuth<any, any, any>;
    const blocked = bountyDomains(req.body ?? {}).filter(domain =>
      isUrlBlocked(
        `https://${domain}/`,
        {},
        {
          team_id: request.auth.team_id,
          org_id: request.acuc?.org_id ?? null,
          origin: "exchange-bounty",
        },
      ),
    );
    if (blocked.length) {
      return res.status(403).json({
        success: false,
        error: {
          code: "bounty_domain_blocked",
          message: `Bounties cannot be published for blocked domains: ${blocked.join(", ")}.`,
        },
      });
    }
    next();
  } catch (error) {
    next(error);
  }
}
