import type { NextFunction, Request, Response } from "express";
import { parse } from "tldts";
import { requestContext } from "../lib/request-context";
import { isLockdownZeroDataRetention } from "../lib/safe-mode";
import { isAlexandriaZDRForced } from "../lib/zdr-helpers";
import { service } from "../service";
import type { RequestWithAuth } from "../controllers/v1/types";

function bountyDomains(body: Record<string, unknown>): string[] {
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
    const domains = bountyDomains(req.body ?? {});
    if (domains.length === 0) {
      return next();
    }
    const blockCtx = requestContext({
      teamId: request.auth.team_id,
      zeroDataRetention:
        isAlexandriaZDRForced(request.acuc?.flags) ||
        isLockdownZeroDataRetention(request.acuc?.flags, undefined),
      // Omit team flags so team unblockedDomains cannot permit public bounties.
      flags: null,
      orgId: request.acuc?.org_id ?? null,
    });
    const blocked = domains.filter(domain =>
      service.modules.blocklist.isBlocked(`https://${domain}/`, blockCtx, {
        origin: "exchange-bounty",
      }),
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
