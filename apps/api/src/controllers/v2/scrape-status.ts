import { service } from "../../service";

export async function scrapeStatusController(req: any, res: any) {
  const uuidReg =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!req.params.jobId || !uuidReg.test(req.params.jobId)) {
    return res.status(400).json({
      success: false,
      error: "Invalid crawl ID",
    });
  }

  if (req.ctx?.zeroDataRetention === true) {
    return res.status(400).json({
      success: false,
      error:
        "Your team has zero data retention enabled. This is not supported on scrape status. Please contact support@firecrawl.com to unblock this feature.",
    });
  }

  const owner = await service.modules.jobStore.owner(
    req.params.jobId,
    "scrape",
  );

  if (
    !owner ||
    (owner.expiresAtMs !== undefined && owner.expiresAtMs <= Date.now())
  ) {
    return res.status(404).json({
      success: false,
      error: "Job not found.",
    });
  }

  const owned = owner.matchesTeam
    ? owner.matchesTeam(req.auth.team_id)
    : owner.teamId === req.auth.team_id;
  if (!owned) {
    return res.status(403).json({
      success: false,
      error: "You are not allowed to access this resource.",
    });
  }

  const stored = await service.modules.jobStore.read(
    req.params.jobId,
    "scrape",
  );
  const data = stored?.document;

  if (!data) {
    return res.status(404).json({
      success: false,
      error: "Job not found.",
    });
  }

  return res.status(200).json({
    success: true,
    data,
  });
}
