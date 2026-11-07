export type SlackIncomingWebhook = {
  url: string;
  channel?: string;
  channel_id?: string;
  configuration_url?: string;
};

export type SlackInstallationRow = {
  id: string;
  team_id: string;
  slack_team_id: string;
  slack_team_name: string | null;
  slack_enterprise_id: string | null;
  bot_user_id: string | null;
  bot_token: string;
  scope: string | null;
  authed_user_id: string | null;
  app_id: string | null;
  incoming_webhook: SlackIncomingWebhook | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

// Result of exchanging an OAuth code via oauth.v2.access.
export type SlackOAuthResult = {
  ok: boolean;
  error?: string;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: { id: string; name?: string };
  enterprise?: { id: string; name?: string } | null;
  authed_user?: { id: string };
  incoming_webhook?: SlackIncomingWebhook;
};

export type SlackChannel = {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
};

export type SlackConnectionStatus =
  | { connected: false }
  | {
      connected: true;
      slackTeamId: string;
      slackTeamName: string | null;
      botUserId: string | null;
      scope: string | null;
      authedUserId: string | null;
      installedAt: string;
      // Channel chosen during install (incoming-webhook), used as the default
      // target when enabling Slack on a monitor.
      defaultChannelId: string | null;
      defaultChannelName: string | null;
    };
