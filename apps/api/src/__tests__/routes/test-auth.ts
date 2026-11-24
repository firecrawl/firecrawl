import { getACUC } from "../../controllers/auth";
import { isTrustedAgentInteropRequest } from "../../lib/agent-interop";
import { parseApi } from "../../lib/parseApi";
import type { AuthModule, AuthRoute } from "../../service";
import { RateLimiterMode } from "../../types";

type RouteWithOptions = AuthRoute & {
  allowAgentManagedKey?: boolean;
};

/**
 * Test-only AuthModule backed by `getACUC` for route tests that exercise real
 * Express routers and `authMiddleware` against mocked DB/Autumn I/O.
 */
export function acucTestAuth(): AuthModule {
  return {
    async authenticate(req, route) {
      const token = req.headers.authorization?.split(" ")[1];
      if (!token) {
        return {
          ok: false,
          refusal: {
            status: 401,
            body: { success: false, error: "Unauthorized" },
          },
        };
      }

      const normalizedApi = parseApi(token);
      let chunk = await getACUC(
        normalizedApi,
        false,
        true,
        RateLimiterMode.Scrape,
      );

      if (
        chunk === null &&
        (route as RouteWithOptions).allowAgentManagedKey === true &&
        isTrustedAgentInteropRequest(req)
      ) {
        chunk = await getACUC(
          normalizedApi,
          false,
          false,
          RateLimiterMode.Scrape,
          "hosted_mcp_oauth",
        );
      }

      if (chunk === null) {
        return {
          ok: false,
          refusal: {
            status: 401,
            body: { success: false, error: "Unauthorized: Invalid token" },
          },
        };
      }

      return {
        ok: true,
        caller: {
          teamId: chunk.team_id,
          orgId: chunk.org_id ?? null,
          chunk,
        } as never,
      };
    },
  };
}
