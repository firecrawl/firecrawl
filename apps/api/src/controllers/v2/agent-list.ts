import { and, eq, inArray } from "drizzle-orm";
import { config } from "../../config";
import { db } from "../../db/connection";
import { agent_session_settings } from "../../db/schema";
import { clickhouseClient } from "../../lib/clickhouse-client";
import { AgentListResponse, ErrorResponse, RequestWithAuth } from "./types";
import { Response } from "express";

type RecentAgent = {
  id: string;
  options: any;
  createdAt: string;
  status:
    | "processing"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "refused"
    | "credit_limit_reached";
};

export async function agentListController(
  req: RequestWithAuth<{}, AgentListResponse>,
  res: Response<AgentListResponse>,
) {
  const limit = 20;

  // Number() (not parseInt) so malformed values like "123abc" are rejected
  // instead of silently truncated.
  const parsedBefore = req.query.before
    ? Number(req.query.before as string)
    : undefined;

  if (
    parsedBefore !== undefined &&
    (isNaN(parsedBefore) ||
      !isFinite(parsedBefore) ||
      !Number.isInteger(parsedBefore) ||
      parsedBefore < 0)
  ) {
    return res.status(400).json({
      success: false,
      error: "Invalid before timestamp.",
    });
  }

  if (!config.USE_DB_AUTHENTICATION) {
    return res.status(501).json({
      success: false,
      error:
        "This endpoint is only available if your Firecrawl deployment is backed by a database.",
    });
  }

  if (!config.EXTRACT_V3_BETA_URL) {
    throw new Error("Agent beta is not enabled.");
  }

  if (clickhouseClient === null) {
    return res.status(501).json({
      success: false,
      error: "This endpoint is only available if ClickHouse is configured.",
    });
  }

  const [recentResult, dbResult] = await Promise.allSettled([
    (async () => {
      const recentRes = await fetch(
        config.EXTRACT_V3_BETA_URL +
          "/internal/recent-agents-for-team?teamId=" +
          req.auth.team_id,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${config.AGENT_INTEROP_SECRET}`,
          },
        },
      );

      if (!recentRes.ok) {
        throw new Error(
          "Unexpected response: " +
            recentRes.statusText +
            " " +
            (await recentRes.text()),
        );
      }

      return new Map(
        (await recentRes.json()).map((x: RecentAgent) => [x.id, x]),
      );
    })(),
    (async () => {
      const requestsRes = await clickhouseClient.query({
        query:
          "SELECT id, created_at, target_hint, origin, integration FROM public_requests WHERE team_id = {teamId: UUID} AND kind = 'agent' AND created_at < {before: DateTime} ORDER BY created_at DESC LIMIT {limit: UInt32};",
        query_params: {
          teamId: req.auth.team_id,
          // Fetch one extra row so we can tell whether another page exists
          // instead of emitting a next cursor whenever the page is full.
          limit: limit + 1,
          before:
            parsedBefore !== undefined
              ? new Date(parsedBefore).toISOString()
              : new Date().toISOString(),
        },
        format: "JSONEachRow",
      });

      const bareRequests: {
        id: string;
        createdAt: Date;
        targetHint: string;
        origin: string;
        integration: string | null | undefined;
      }[] = (await requestsRes.json()).map(
        (x: {
          id: string;
          created_at: string;
          target_hint: string;
          origin: string;
          integration: string;
        }) => ({
          id: x.id,
          createdAt: new Date(x.created_at),
          targetHint: x.target_hint,
          origin: x.origin,
          integration: x.integration,
        }),
      );

      const agentsRes = await clickhouseClient.query({
        query:
          "SELECT id, options, is_successful FROM public_agents WHERE id IN {ids: Array(UUID)};",
        query_params: {
          ids: bareRequests.map(x => x.id),
        },
        format: "JSONEachRow",
      });
      const agentResults: {
        id: string;
        options: any;
        isSuccessful: boolean;
        error: string | null;
      }[] = (await agentsRes.json()).map(
        (x: {
          id: string;
          options: any;
          is_successful: boolean;
          error: string | null;
        }) => ({
          id: x.id,
          options: x.options,
          isSuccessful: x.is_successful,
          error: x.error,
        }),
      );
      const agentMap = new Map(agentResults.map(x => [x.id, x]));

      return new Map(
        bareRequests
          .map(x => ({ ...x, agent: agentMap.get(x.id) }))
          .map(x => [x.id, x]),
      );
    })(),
  ]);

  const recentAgents: Map<string, RecentAgent> =
    recentResult.status === "fulfilled" ? recentResult.value : new Map();

  // Recent agents are merged into every response, so without this filter they
  // would repeat on every paginated page. Only include the ones that fall
  // within the requested page range.
  if (parsedBefore !== undefined) {
    for (const [id, agent] of recentAgents) {
      if (new Date(agent.createdAt).valueOf() >= parsedBefore) {
        recentAgents.delete(id);
      }
    }
  }
  if (dbResult.status === "rejected") {
    throw dbResult.reason;
  }
  const dbAgents = dbResult.value;

  const allIds = [...new Set([...recentAgents.keys(), ...dbAgents.keys()])];

  const sessionSettings = await db
    .select()
    .from(agent_session_settings)
    .where(
      and(
        inArray(agent_session_settings.session_id, allIds),
        eq(agent_session_settings.team_id, req.auth.team_id),
      ),
    );

  const sessionSettingsMap = new Map(
    sessionSettings.map(x => [x.session_id, x]),
  );

  const agents: Exclude<AgentListResponse, ErrorResponse>["agents"] = [];

  for (const id of allIds) {
    const recent = recentAgents.get(id);
    const db = dbAgents.get(id);
    const settings = sessionSettingsMap.get(id);

    agents.push({
      id: db?.id ?? recent!.id,
      createdAt: db?.createdAt.toISOString() ?? recent!.createdAt,
      targetHint:
        db?.targetHint ??
        (recent?.options
          ? (recent.options.urls?.[0] ?? recent.options.prompt ?? "")
          : ""),
      origin: db?.origin ?? "api", // recent cannot know origin so we lie
      integration: db?.integration ?? undefined, // recent cannot know integration so we omit
      settings: {
        hidden: settings?.hidden ?? false,
        starred: settings?.starred ?? false,
        label: settings?.label ?? undefined,
      },
      status: db
        ? db.agent
          ? db.agent.isSuccessful
            ? "completed"
            : "failed"
          : "processing"
        : recent!.status === "processing"
          ? "processing"
          : recent!.status === "succeeded"
            ? "completed"
            : "failed",
      options: db?.agent
        ? {
            urls: db.agent.options.urls ?? undefined,
            prompt: db.agent.options.prompt ?? "",
            schema: db.agent.options.schema ?? undefined,
            model: db.agent.options.model ?? "spark-1-pro",
            effort:
              db.agent.options.effort ??
              (db.agent.options.model === "spark-2" ? "medium" : undefined),
          }
        : recent?.options
          ? {
              urls: recent.options.urls ?? undefined,
              prompt: recent.options.prompt ?? "",
              schema: recent.options.schema ?? undefined,
              model: recent.options.modelPreset ?? "spark-1-pro",
              effort:
                recent.options.effort ??
                (recent.options.modelPreset === "spark-2"
                  ? "medium"
                  : undefined),
            }
          : undefined,
    });
  }

  // The merged list is recent agents followed by ClickHouse rows; sort so the
  // page is globally ordered by creation time and the next cursor (taken from
  // the last entry) is correct.
  agents.sort(
    (a, b) => new Date(b.createdAt).valueOf() - new Date(a.createdAt).valueOf(),
  );

  // The ClickHouse query fetched limit + 1 rows and recent agents are merged
  // on top, so anything past limit means another page exists. Dropped entries
  // are older than the new cursor and resurface on the next page.
  const hasMore = agents.length > limit;
  const page = agents.slice(0, limit);

  return res.json({
    success: true,
    agents: page,
    next: hasMore
      ? `${req.protocol}://${req.host}/v2/agent?before=${new Date(page.slice(-1)[0].createdAt).valueOf()}`
      : undefined,
  });
}
