import { and, desc, eq, isNull } from "drizzle-orm";
import { db, dbRr } from "../../../db/connection";
import * as schema from "../../../db/schema";
import type { SlackIncomingWebhook, SlackInstallationRow } from "./types";

function toRow(
  row: typeof schema.slack_installations.$inferSelect,
): SlackInstallationRow {
  return {
    id: row.id,
    team_id: row.team_id,
    slack_team_id: row.slack_team_id,
    slack_team_name: row.slack_team_name,
    slack_enterprise_id: row.slack_enterprise_id,
    bot_user_id: row.bot_user_id,
    bot_token: row.bot_token,
    scope: row.scope,
    authed_user_id: row.authed_user_id,
    app_id: row.app_id,
    incoming_webhook:
      (row.incoming_webhook as SlackIncomingWebhook | null) ?? null,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function upsertSlackInstallation(params: {
  teamId: string;
  slackTeamId: string;
  slackTeamName?: string | null;
  slackEnterpriseId?: string | null;
  botUserId?: string | null;
  botToken: string;
  scope?: string | null;
  authedUserId?: string | null;
  appId?: string | null;
  incomingWebhook?: SlackIncomingWebhook | null;
}): Promise<SlackInstallationRow> {
  const values = {
    team_id: params.teamId,
    slack_team_id: params.slackTeamId,
    slack_team_name: params.slackTeamName ?? null,
    slack_enterprise_id: params.slackEnterpriseId ?? null,
    bot_user_id: params.botUserId ?? null,
    bot_token: params.botToken,
    scope: params.scope ?? null,
    authed_user_id: params.authedUserId ?? null,
    app_id: params.appId ?? null,
    incoming_webhook: params.incomingWebhook ?? null,
    revoked_at: null,
  };

  const [row] = await db
    .insert(schema.slack_installations)
    .values(values)
    .onConflictDoUpdate({
      target: schema.slack_installations.team_id,
      set: {
        ...values,
        updated_at: new Date().toISOString(),
      },
    })
    .returning();

  return toRow(row);
}

export async function getSlackInstallationByTeam(
  teamId: string,
): Promise<SlackInstallationRow | null> {
  const rows = await dbRr
    .select()
    .from(schema.slack_installations)
    .where(
      and(
        eq(schema.slack_installations.team_id, teamId),
        isNull(schema.slack_installations.revoked_at),
      ),
    )
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

// Inbound Slack traffic (slash commands, events) arrives keyed by the Slack
// workspace id. If two Firecrawl teams share a workspace we take the most
// recent install; this is a documented edge case.
export async function getSlackInstallationBySlackTeam(
  slackTeamId: string,
): Promise<SlackInstallationRow | null> {
  const rows = await dbRr
    .select()
    .from(schema.slack_installations)
    .where(
      and(
        eq(schema.slack_installations.slack_team_id, slackTeamId),
        isNull(schema.slack_installations.revoked_at),
      ),
    )
    .orderBy(desc(schema.slack_installations.created_at))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function deleteSlackInstallationByTeam(
  teamId: string,
): Promise<void> {
  await db
    .delete(schema.slack_installations)
    .where(eq(schema.slack_installations.team_id, teamId));
}

export async function deleteSlackInstallationsBySlackTeam(
  slackTeamId: string,
): Promise<void> {
  await db
    .delete(schema.slack_installations)
    .where(eq(schema.slack_installations.slack_team_id, slackTeamId));
}
