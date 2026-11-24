import { z } from "zod";
import { defineEnv } from "../../service/env";

export const notificationsEnv = defineEnv(
  "notifications",
  z.object({
    FIRECRAWL_DASHBOARD_URL: z.url().default("https://www.firecrawl.dev"),
    RESEND_API_KEY: z.string().optional(),
    SLACK_WEBHOOK_URL: z.string().optional(),
    SLACK_ADMIN_WEBHOOK_URL: z.string().optional(),
    // Slack integration ("Add to Slack" for monitor notifications + /monitor
    // slash command). Credentials come from the Firecrawl Slack app.
    SLACK_CLIENT_ID: z.string().optional(),
    SLACK_CLIENT_SECRET: z.string().optional(),
    SLACK_SIGNING_SECRET: z.string().optional(),
    // Bot scopes requested during install. Override only if the Slack app manifest
    // changes; keep in sync with slack-app-manifest.json.
    SLACK_OAUTH_SCOPES: z
      .string()
      .default(
        "chat:write,chat:write.public,commands,channels:read,groups:read,team:read,incoming-webhook",
      ),
    // Absolute URL Slack redirects back to after authorize. Must exactly match a
    // Redirect URL configured on the Slack app (e.g.
    // https://api.firecrawl.dev/v2/slack/oauth/callback).
    SLACK_OAUTH_REDIRECT_URL: z.string().optional(),
    // 32-byte key (hex or base64) used to AES-256-GCM encrypt stored bot tokens.
    // Required when ENV=production. Elsewhere, if unset, tokens are stored with a
    // `plain:` prefix.
    SLACK_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  }),
);
