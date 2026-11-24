import type { RequestHandler, Router } from "express";
import { listMcpActionLogsController } from "../controllers/v2/mcp-action-logs";
import { wrap } from "./shared";

export function registerMcpActionLogReadRoute(
  router: Pick<Router, "get">,
  authenticateViewer: RequestHandler,
) {
  router.get(
    "/mcp/action-logs",
    authenticateViewer,
    wrap(listMcpActionLogsController),
  );
}
