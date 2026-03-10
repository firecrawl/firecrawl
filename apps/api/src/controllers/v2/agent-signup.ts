import crypto from "crypto";
import { Request, Response } from "express";
import qs from "qs";
import { RateLimiterRedis } from "rate-limiter-flexible";
import { Resend } from "resend";
import { z } from "zod";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import { apiKeyToFcApiKey } from "../../lib/parseApi";
import { redisRateLimitClient } from "../../services/rate-limiter";
import { supabase_rr_service, supabase_service } from "../../services/supabase";

const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "yahoo.co.uk",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "gmx.com",
  "gmx.net",
  "tutanota.com",
  "fastmail.com",
]);

// Rate limit values — used by limiters and error copy so they stay in sync
const AGENT_SIGNUP_IP_LIMIT = 5;
const AGENT_SIGNUP_DOMAIN_LIMIT = 20;
const AGENT_SIGNUP_IP_LIMIT_SIDEGUIDE = 15; // 3x default
const AGENT_SIGNUP_DOMAIN_LIMIT_SIDEGUIDE = 60; // 3x default

// Rate limiters
const ipRateLimiter = new RateLimiterRedis({
  storeClient: redisRateLimitClient,
  keyPrefix: "agent_signup_ip",
  points: AGENT_SIGNUP_IP_LIMIT,
  duration: 3600, // 1 hour
});

// Per-domain (or per-email for public providers) limit to curb abuse while allowing
// legitimate multi-agent signups. Tune points if product requirements change.
const domainRateLimiter = new RateLimiterRedis({
  storeClient: redisRateLimitClient,
  keyPrefix: "agent_signup_domain",
  points: AGENT_SIGNUP_DOMAIN_LIMIT,
  duration: 86400, // 24 hours
});

// Higher limits for *+test*@sideguide.dev only. sideguide.dev is internal-only; external users
// cannot receive mail or hold accounts there, so this path is not abusable.
const ipRateLimiterSideguide = new RateLimiterRedis({
  storeClient: redisRateLimitClient,
  keyPrefix: "agent_signup_ip_sideguide",
  points: AGENT_SIGNUP_IP_LIMIT_SIDEGUIDE,
  duration: 3600, // 1 hour
});

const domainRateLimiterSideguide = new RateLimiterRedis({
  storeClient: redisRateLimitClient,
  keyPrefix: "agent_signup_domain_sideguide",
  points: AGENT_SIGNUP_DOMAIN_LIMIT_SIDEGUIDE,
  duration: 86400, // 24 hours
});

const agentSignupSchema = z.object({
  email: z.string().email(),
  agent_name: z.string().min(1).max(100),
  accept_terms: z.literal(true),
});

/** Insert payload for agent_sponsors (nullable cols in DB are optional here). */
type AgentSponsorInsert = {
  email: string;
  status: "pending" | "blocked" | "verified";
  verification_deadline: string;
  agent_name: string;
  sandboxed_team_id: string;
  api_key_id: number;
  verification_token: string;

  requesting_ip?: string;
  tos_version?: string;
  tos_hash?: string;
};

export async function agentSignupController(req: Request, res: Response) {
  const logger = _logger.child({
    module: "v2/agent-signup",
    method: "agentSignupController",
  });

  try {
    // Parse and validate input
    const body = agentSignupSchema.parse(req.body);
    const email = body.email.toLowerCase();
    const { agent_name } = body;

    const incomingIP = req.ip || req.socket.remoteAddress || "unknown";
    const [emailPrefix, emailDomain] = email.split("@");
    // sideguide.dev is an internal domain: only Sideguide team have mailboxes there. Even if
    // someone used this pattern to get the higher limits, each signup still gets only 50 credits
    // and keys stay sandboxed (no confirm/merge); limits are 3x default, not unbounded.
    const isSideguideEmail =
      emailDomain === "sideguide.dev" && emailPrefix.includes("+test");

    // Always rate limit; use higher limits only for internal sideguide.dev +test addresses
    const ipLimiter = isSideguideEmail ? ipRateLimiterSideguide : ipRateLimiter;
    const domainLimiter = isSideguideEmail
      ? domainRateLimiterSideguide
      : domainRateLimiter;
    const ipLimitMsg = isSideguideEmail
      ? `Rate limit exceeded. Maximum ${AGENT_SIGNUP_IP_LIMIT_SIDEGUIDE} agent signup requests per hour per IP for sideguide test emails.`
      : `Rate limit exceeded. Maximum ${AGENT_SIGNUP_IP_LIMIT} agent signup requests per hour per IP.`;
    const domainLimitMsg = isSideguideEmail
      ? "Too many agent signups for this email. Please try again later."
      : "Too many agent signups for this email domain. Please try again later.";

    try {
      await ipLimiter.consume(incomingIP);
    } catch {
      return res.status(429).json({
        success: false,
        error: ipLimitMsg,
      });
    }

    const domainKey = PUBLIC_EMAIL_DOMAINS.has(emailDomain)
      ? email
      : emailDomain;
    try {
      await domainLimiter.consume(domainKey);
    } catch {
      return res.status(429).json({
        success: false,
        error: domainLimitMsg,
      });
    }

    // Check for existing blocked sponsor record (use primary for strong consistency)
    const { data: blockedSponsor } = await supabase_service
      .from("agent_sponsors")
      .select("id")
      .eq("email", email)
      .eq("status", "blocked")
      .limit(1);

    if (blockedSponsor && blockedSponsor.length > 0) {
      return res.status(403).json({
        success: false,
        error: "This email has blocked agent signups.",
      });
    }

    // Check for existing pending sponsor record (use primary for strong consistency)
    const { data: pendingSponsor } = await supabase_service
      .from("agent_sponsors")
      .select("id, verification_deadline")
      .eq("email", email)
      .eq("status", "pending")
      .limit(1);

    if (pendingSponsor && pendingSponsor.length > 0) {
      const deadline = new Date(pendingSponsor[0].verification_deadline);
      if (deadline > new Date()) {
        return res.status(409).json({
          success: false,
          error:
            "A pending agent signup confirmation has already been sent to this email.",
          login_url: "https://firecrawl.dev/signin",
        });
      } else {
        return res.status(403).json({
          success: false,
          error:
            "Previous agent signup verification has expired. Please log in to manage your account.",
          login_url: "https://firecrawl.dev/signin",
        });
      }
    }

    // Create sandboxed account via Supabase auth
    const sandboxId = crypto.randomUUID();
    const syntheticEmail = `agent-${sandboxId}@agent.sandbox.firecrawl.dev`;

    const { data: newUser, error: newUserError } =
      await supabase_service.auth.admin.createUser({
        email: syntheticEmail,
        email_confirm: true,
        user_metadata: {
          referrer_integration: "agent_signup",
          agent_name: agent_name,
        },
      });

    if (newUserError) {
      logger.error("Failed to create sandboxed user", { error: newUserError });
      return res
        .status(500)
        .json({ success: false, error: "Failed to create agent account." });
    }

    // Wait briefly for the trigger to complete, then fetch the created records
    // The handle_new_user_6 trigger creates user, team, org, api_key
    let teamId: string | null = null;
    let apiKeyRecord: { id: number; key: string } | null = null;

    // Poll for trigger completion (the trigger runs synchronously in the same transaction)
    const { data: fcUser, error: fcUserError } = await supabase_service
      .from("users")
      .select("team_id")
      .eq("id", newUser.user.id)
      .single();

    if (fcUserError || !fcUser) {
      logger.error("Failed to look up sandboxed user after creation", {
        error: fcUserError,
      });
      return res
        .status(500)
        .json({ success: false, error: "Failed to create agent account." });
    }

    teamId = fcUser.team_id;

    const { data: apiKeyData, error: apiKeyError } = await supabase_service
      .from("api_keys")
      .select("id, key")
      .eq("team_id", teamId)
      .limit(1)
      .single();

    if (apiKeyError || !apiKeyData) {
      logger.error("Failed to look up API key for sandboxed team", {
        error: apiKeyError,
      });
      return res
        .status(500)
        .json({ success: false, error: "Failed to create agent account." });
    }

    apiKeyRecord = apiKeyData;

    if (!teamId) {
      return res
        .status(500)
        .json({ success: false, error: "Failed to create agent account." });
    }

    // Mark the API key as agent_provisioned
    const { error: updateKeyError } = await supabase_service
      .from("api_keys")
      .update({ agent_provisioned: true } as any)
      .eq("id", apiKeyRecord.id);

    if (updateKeyError) {
      logger.error("Failed to mark API key as agent_provisioned", {
        error: updateKeyError,
      });
      return res
        .status(500)
        .json({ success: false, error: "Failed to create agent account." });
    }

    // Generate verification token
    const verificationToken = crypto.randomBytes(32).toString("hex");

    // Compute deadline (5 days from now)
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 5);

    // Create sponsor record
    const sponsorRow: AgentSponsorInsert = {
      email,
      status: "pending",
      verification_deadline: deadline.toISOString(),
      agent_name,
      sandboxed_team_id: teamId,
      api_key_id: apiKeyRecord.id,
      requesting_ip: incomingIP,
      tos_version: "2024-11-05", // Date of last revision in ToS at https://firecrawl.dev/terms-of-service
      tos_hash: crypto
        .createHash("sha256")
        .update("accept_terms:true")
        .digest("hex"),
      verification_token: verificationToken,
    };
    const { error: sponsorError } = await supabase_service
      .from("agent_sponsors")
      .insert(sponsorRow);

    if (sponsorError) {
      logger.error("Failed to create sponsor record", { error: sponsorError });
      return res
        .status(500)
        .json({ success: false, error: "Failed to create agent signup." });
    }

    // Send confirmation email
    const confirmUrl = `https://firecrawl.dev/agent-confirm?${qs.stringify({
      agent_signup_token: verificationToken,
      agent_signup_action: "confirm",
    })}`;
    const blockUrl = `https://firecrawl.dev/agent-confirm?${qs.stringify({
      agent_signup_token: verificationToken,
      agent_signup_action: "block",
    })}`;

    if (config.RESEND_API_KEY) {
      logger.info("Sending agent sponsor confirmation email", {
        to: email,
        agent_name,
      });
      try {
        const resend = new Resend(config.RESEND_API_KEY);
        const sendResult = await resend.emails.send({
          from: "Firecrawl <notifications@notifications.firecrawl.dev>",
          to: [email],
          reply_to: "help@firecrawl.com",
          subject: `An AI agent "${agent_name}" created an API key under your email — Firecrawl`,
          html: `
          <p>Hey there,</p>
          <p>An AI agent called <strong>${escapeHtml(agent_name)}</strong> just created a Firecrawl API key and listed your email as the account holder.</p>
          <p>The key is currently sandboxed with a <strong>50-credit limit</strong>. To link it to your account and unlock your full plan, please confirm:</p>
          <p><a href="${confirmUrl}" style="display:inline-block;padding:12px 24px;background:#f97316;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;">Confirm &amp; Link Key</a></p>
          <p>If you did not authorize this, you can block the key:</p>
          <p><a href="${blockUrl}">Block this key</a></p>
          <p>This confirmation link expires on <strong>${deadline.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</strong>.</p>
          <p>If you have questions, reach out to us at <a href="mailto:help@firecrawl.com">help@firecrawl.com</a>.</p>
          <br/>
          <p>Thanks,<br/>Firecrawl Team</p>
        `,
        });
        if (sendResult.data?.id) {
          logger.info("Agent sponsor confirmation email sent", {
            to: email,
            resendId: sendResult.data.id,
          });
        } else {
          logger.warn(
            "Agent sponsor confirmation email failed or returned no id",
            {
              to: email,
              error: sendResult.error,
            },
          );
        }
      } catch (err) {
        logger.error("Failed to send agent sponsor confirmation email", {
          to: email,
          error: err,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      logger.warn(
        "RESEND_API_KEY not set; skipping agent sponsor confirmation email",
        {
          to: email,
        },
      );
    }

    // If sponsor email matches an existing user, queue in-app notification
    const { data: existingUser } = await supabase_rr_service
      .from("users")
      .select("team_id")
      .eq("email", email)
      .limit(1);

    if (existingUser && existingUser.length > 0) {
      await supabase_service
        .from("user_notifications")
        .insert({
          team_id: existingUser[0].team_id,
          notification_type: "agentSponsorConfirm",
          sent_date: new Date().toISOString(),
          timestamp: new Date().toISOString(),
          metadata: {
            agent_name,
            confirm_url: confirmUrl,
            block_url: blockUrl,
            verification_token: verificationToken,
            deadline: deadline.toISOString(),
          },
        } as any)
        .then(({ error }) => {
          if (error) {
            logger.error("Failed to insert in-app notification", { error });
          }
        });
    }

    logger.info("Agent signup completed", {
      email,
      agent_name,
      teamId,
      apiKeyId: apiKeyRecord.id,
    });

    return res.status(201).json({
      success: true,
      api_key: apiKeyToFcApiKey(apiKeyRecord.key),
      sponsor_status: "pending",
      credit_limit: 50,
      credits_remaining: 50,
      verification_deadline_at: deadline.toISOString(),
      tos_url: "https://firecrawl.dev/terms-of-service",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error:
          "Invalid request body: " +
          (error as z.ZodError).issues
            .map((e: z.ZodIssue) => e.message)
            .join(", "),
      });
    }
    logger.error("Unexpected error in agent signup", { error });
    return res
      .status(500)
      .json({ success: false, error: "Internal server error" });
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
