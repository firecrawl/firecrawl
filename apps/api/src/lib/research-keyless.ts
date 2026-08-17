import type { Request } from "express";
import { config, type ResearchPaperOperation } from "../config";

function researchPaperOperation(req: Request): ResearchPaperOperation | null {
  const segments = req.path.toLowerCase().split("/").filter(Boolean);
  const papersIndex = segments.indexOf("papers");
  if (papersIndex === -1) return null;

  const rest = segments.slice(papersIndex + 1);
  if (rest.length === 0) return "search";
  if (rest.length === 1) {
    return req.query?.query === undefined ? "inspect" : "read";
  }
  if (rest.length === 2 && rest[1] === "similar") return "similar";
  return null;
}

export function isResearchKeylessDisabled(req: Request): boolean {
  const disabledOperations = config.RESEARCH_KEYLESS_DISABLED;
  if (disabledOperations.length === 0) return false;

  const operation = researchPaperOperation(req);
  return operation !== null && disabledOperations.includes(operation);
}
