import type { Request, Response, Router } from "express";

export const RESEARCH_SERVICE_UNAVAILABLE =
  "Research service is not configured";

export function researchServiceUnavailable(_req: Request, res: Response) {
  return res.status(501).json({
    success: false,
    error: RESEARCH_SERVICE_UNAVAILABLE,
  });
}

export function mountUnconfiguredResearchRoutes(router: Router) {
  router.use("/search/research", researchServiceUnavailable);
  router.use("/research", researchServiceUnavailable);
}
