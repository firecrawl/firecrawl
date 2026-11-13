import type { Request } from "express";
import { config, type ResearchKeylessOperation } from "../config";

function researchKeylessOperation(
  req: Request,
): ResearchKeylessOperation | null {
  const segments = req.path.toLowerCase().split("/").filter(Boolean);
  const papersIndex = segments.indexOf("papers");
  if (papersIndex === -1) {
    return segments.at(-1) === "proteins" ? "inspect" : null;
  }

  const rest = segments.slice(papersIndex + 1);
  if (rest.length === 0) return "search";
  if (rest.length > 1 && rest.at(-1) === "similar") return "similar";
  return req.query?.query === undefined ? "inspect" : "read";
}

export function isResearchKeylessDisabled(req: Request): boolean {
  const disabledOperations = config.RESEARCH_KEYLESS_DISABLED;
  if (disabledOperations.length === 0) return false;

  const operation = researchKeylessOperation(req);
  return operation !== null && disabledOperations.includes(operation);
}
