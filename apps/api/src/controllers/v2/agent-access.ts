import crypto from "crypto";
import { Request, Response } from "express";
import qs from "qs";
import { RateLimiterRedis } from "rate-limiter-flexible";
import { Resend } from "resend";
import { z } from "zod";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import { apiKeyToFcApiKey } from "../../lib/parseApi";
import {
  getAgentSponsorByRequestId,
  getAgentSponsorByToken,
  markSponsorBlocked,
  markSponsorVerified,
} from "../../services/agent-sponsor";
import {
  autumnService,
  isAutumnEnabled,
} from "../../services/autumn/autumn.service";
import { redisRateLimitClient } from "../../services/rate-limiter";
import { supabase_rr_service, supabase_service } from "../../services/supabase";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

function normalizeEmailForRateLimit(email: string, domain: string): string {
  let [local] = email.split("@");
  const plusIdx = local.indexOf("+");
  if (plusIdx !== -1) local = local.slice(0, plusIdx);
  if (GMAIL_DOMAINS.has(domain)) local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Generate a short, URL-safe random string for request IDs. */
function generateRequestId(): string {
  return crypto.randomBytes(16).toString("base64url");
}

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------

const REQUEST_IP_LIMIT = 3;
const REQUEST_DOMAIN_LIMIT = 20;

const requestIpLimiter = new RateLimiterRedis({
  storeClient: redisRateLimitClient,
  keyPrefix: "agent_access_req_ip",
  points: REQUEST_IP_LIMIT,
  duration: 86400,
});

const requestDomainLimiter = new RateLimiterRedis({
  storeClient: redisRateLimitClient,
  keyPrefix: "agent_access_req_domain",
  points: REQUEST_DOMAIN_LIMIT,
  duration: 86400,
});

const statusPollLimiter = new RateLimiterRedis({
  storeClient: redisRateLimitClient,
  keyPrefix: "agent_access_status_ip",
  points: 60,
  duration: 60,
});

const approveRejectLimiter = new RateLimiterRedis({
  storeClient: redisRateLimitClient,
  keyPrefix: "agent_access_approve_ip",
  points: 10,
  duration: 3600,
});

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const requestSchema = z.object({
  email: z
    .string()
    .email()
    .refine(
      e =>
        !e.includes("+") ||
        (e.endsWith("@sideguide.dev") && e.includes("+test")),
      { message: "Email addresses with '+' are not allowed." },
    ),
  agent_name: z.string().min(1).max(100),
  accept_terms: z.literal(true, {
    message:
      "You must accept the terms: https://www.firecrawl.dev/terms-of-service",
  }),
  use_case: z.string().max(500).optional(),
});

const tokenSchema = z.object({
  token: z.string().min(1),
});

// ---------------------------------------------------------------------------
// POST /v2/agent-access/request
//
// Agent initiates an access request. NO key or account is created here.
// The human must approve first.
// ---------------------------------------------------------------------------

export async function agentAccessRequestController(
  req: Request,
  res: Response,
) {
  const logger = _logger.child({
    module: "v2/agent-access",
    method: "request",
  });

  try {
    const body = requestSchema.parse(req.body);
    const email = body.email.toLowerCase();
    const { agent_name, use_case } = body;

    const incomingIP = req.ip || req.socket.remoteAddress || "unknown";
    const [, emailDomain] = email.split("@");

    // --- Rate limiting ---
    try {
      await requestIpLimiter.consume(incomingIP);
    } catch {
      return res.status(429).json({
        success: false,
        error: `Rate limit exceeded. Maximum ${REQUEST_IP_LIMIT} agent access requests per day per IP.`,
      });
    }

    const domainKey = PUBLIC_EMAIL_DOMAINS.has(emailDomain)
      ? normalizeEmailForRateLimit(email, emailDomain)
      : emailDomain;
    try {
      await requestDomainLimiter.consume(domainKey);
    } catch {
      return res.status(429).json({
        success: false,
        error:
          "Too many agent access requests for this email domain. Please try again later.",
      });
    }

    // --- Check for blocked email ---
    const { data: blockedSponsor } = await supabase_service
      .from("agent_sponsors")
      .select("id")
      .eq("email", email)
      .eq("status", "blocked")
      .limit(1);

    if (blockedSponsor && blockedSponsor.length > 0) {
      return res.status(403).json({
        success: false,
        error: "This email has blocked agent access requests.",
      });
    }

    // --- Check for existing pending request ---
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
            "A pending approval request has already been sent to this email.",
          login_url: "https://firecrawl.dev/signin",
        });
      }
      // Expired pending — allow a new one
    }

    // --- Create the access request record (no account, no key) ---
    const verificationToken = crypto.randomBytes(32).toString("hex");
    const requestId = generateRequestId();

    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 7);

    const { error: sponsorError } = await supabase_service
      .from("agent_sponsors")
      .insert({
        email,
        status: "pending",
        verification_deadline: deadline.toISOString(),
        agent_name,
        requesting_ip: incomingIP,
        tos_version: "2024-11-05",
        tos_hash: crypto
          .createHash("sha256")
          .update("accept_terms:true")
          .digest("hex"),
        verification_token: verificationToken,
        request_id: requestId,
        use_case: use_case || null,
      } as any);

    if (sponsorError) {
      logger.error("Failed to create access request record", {
        error: sponsorError,
      });
      return res
        .status(500)
        .json({ success: false, error: "Failed to create access request." });
    }

    // --- Send approval email ---
    const approveUrl = `https://firecrawl.dev/agent-confirm?${qs.stringify({
      agent_signup_token: verificationToken,
      agent_signup_action: "confirm",
    })}`;
    const rejectUrl = `https://firecrawl.dev/agent-confirm?${qs.stringify({
      agent_signup_token: verificationToken,
      agent_signup_action: "block",
    })}`;

    if (config.RESEND_API_KEY) {
      logger.info("Sending agent access approval email", {
        to: email,
        agent_name,
      });
      try {
        const resend = new Resend(config.RESEND_API_KEY);

        const useCaseBlock = use_case
          ? `<p style="margin: 15px 0; padding: 12px 16px; background: #f5f5f5; border-radius: 6px; font-style: italic;">"${escapeHtml(use_case)}"</p>`
          : "";

        await resend.emails.send({
          from: "Firecrawl <notifications@notifications.firecrawl.dev>",
          to: [email],
          reply_to: "help@firecrawl.com",
          subject: `Approve API access for "${agent_name}" — Firecrawl`,
          html: `
          <div style="font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 40px auto; padding: 20px;">
            <div style="margin-bottom: 30px;">
              <img src="https://www.firecrawl.dev/brand/firecrawl-wordmark-500.png" alt="Firecrawl" style="max-width: 150px; height: auto;">
            </div>
            <p style="margin: 15px 0;">Hey there,</p>
            <p style="margin: 15px 0;">An AI agent called <strong>${escapeHtml(agent_name)}</strong> is requesting Firecrawl API access on your behalf.</p>
            ${useCaseBlock}
            <p style="margin: 15px 0;">By approving, you accept the <a href="https://firecrawl.dev/terms-of-service" style="color: #FF6B35;">Terms of Service</a> and an API key will be created for the agent under your account.</p>
            <p style="margin: 30px 0;">
              <a href="${approveUrl}" style="background-color: #FA5D19; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600;">Approve Access</a>
            </p>
            <p style="margin: 15px 0;">If you didn't authorize this:</p>
            <p style="margin: 15px 0;"><a href="${rejectUrl}" style="color: #FF6B35;">Reject &amp; Block</a></p>
            <p style="margin: 15px 0;">This link expires on <strong>${deadline.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</strong>.</p>
            <p style="margin: 15px 0;">Questions? <a href="mailto:help@firecrawl.com" style="color: #FF6B35;">help@firecrawl.com</a></p>
            <p style="margin: 15px 0;">Best,<br>The Firecrawl Team</p>
          </div>
          `,
        });
      } catch (err) {
        logger.error("Failed to send agent access approval email", {
          to: email,
          error: err,
        });
      }
    }

    // --- In-app notification for existing Firecrawl users ---
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
          notification_type: "agentAccessRequest",
          sent_date: new Date().toISOString(),
          timestamp: new Date().toISOString(),
          metadata: {
            agent_name,
            use_case: use_case || null,
            confirm_url: approveUrl,
            block_url: rejectUrl,
            deadline: deadline.toISOString(),
          },
        } as any)
        .then(({ error }) => {
          if (error)
            logger.error("Failed to insert in-app notification", { error });
        });
    }

    logger.info("Agent access request created", {
      email,
      agent_name,
      requestId,
    });

    return res.status(201).json({
      success: true,
      request_id: requestId,
      status: "pending",
      status_url: `https://api.firecrawl.dev/v2/agent-access/${requestId}/status`,
      approval_expires_at: deadline.toISOString(),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error:
          "Invalid request: " + error.issues.map(e => e.message).join(", "),
      });
    }
    logger.error("Unexpected error in agent access request", { error });
    return res
      .status(500)
      .json({ success: false, error: "Internal server error" });
  }
}

// ---------------------------------------------------------------------------
// GET /v2/agent-access/:requestId/status
//
// Agent polls this. Returns the api_key ONLY after the human has approved.
// ---------------------------------------------------------------------------

export async function agentAccessStatusController(req: Request, res: Response) {
  const logger = _logger.child({
    module: "v2/agent-access",
    method: "status",
  });

  try {
    const incomingIP = req.ip || req.socket.remoteAddress || "unknown";
    try {
      await statusPollLimiter.consume(incomingIP);
    } catch {
      return res.status(429).json({
        success: false,
        error: "Too many status checks. Please slow down.",
      });
    }

    const { requestId } = req.params;
    if (!requestId || requestId.length < 10) {
      return res.status(400).json({
        success: false,
        error: "Invalid request ID.",
      });
    }

    const sponsor = await getAgentSponsorByRequestId({ requestId });
    if (!sponsor) {
      return res.status(404).json({
        success: false,
        error: "Access request not found.",
      });
    }

    const response: Record<string, any> = {
      success: true,
      status: sponsor.status === "verified" ? "approved" : sponsor.status,
      approval_expires_at: sponsor.verification_deadline,
    };

    if (sponsor.status === "verified") {
      // Approved — return the API key so the agent can start using it
      if (sponsor.api_key_id) {
        const { data: keyData } = await supabase_rr_service
          .from("api_keys")
          .select("key")
          .eq("id", sponsor.api_key_id)
          .single();

        if (keyData) {
          response.api_key = apiKeyToFcApiKey(keyData.key);
        }
      }
      response.message = "Access approved. Your API key is ready.";
    } else if (sponsor.status === "blocked") {
      response.message =
        "Access rejected. The account holder blocked this request.";
    } else {
      const deadline = new Date(sponsor.verification_deadline);
      if (deadline < new Date()) {
        response.status = "expired";
        response.message =
          "Approval request has expired. Please create a new request.";
      } else {
        response.message = "Waiting for the account holder to approve access.";
      }
    }

    return res.status(200).json(response);
  } catch (error) {
    logger.error("Unexpected error in agent access status", { error });
    return res
      .status(500)
      .json({ success: false, error: "Internal server error" });
  }
}

// ---------------------------------------------------------------------------
// POST /v2/agent-access/approve
//
// Human approves. This is where the account + API key are created.
// The human accepting this link constitutes terms acceptance.
// ---------------------------------------------------------------------------

export async function agentAccessApproveController(
  req: Request,
  res: Response,
) {
  const logger = _logger.child({
    module: "v2/agent-access",
    method: "approve",
  });

  try {
    const incomingIP = req.ip || req.socket.remoteAddress || "unknown";
    try {
      await approveRejectLimiter.consume(incomingIP);
    } catch {
      return res.status(429).json({
        success: false,
        error: "Too many attempts. Please try again later.",
      });
    }

    const { token } = tokenSchema.parse(req.body);

    const sponsor = await getAgentSponsorByToken({
      agent_signup_token: token,
    });
    if (!sponsor) {
      return res.status(404).json({
        success: false,
        error: "Invalid or expired token.",
      });
    }

    if (sponsor.status === "verified") {
      return res.status(200).json({
        success: true,
        message: "This access request has already been approved.",
      });
    }

    if (sponsor.status === "blocked") {
      return res.status(403).json({
        success: false,
        error: "This access request has been rejected.",
      });
    }

    // Check deadline
    const deadline = new Date(sponsor.verification_deadline);
    if (deadline < new Date()) {
      return res.status(403).json({
        success: false,
        error:
          "Approval deadline has passed. The agent will need to create a new request.",
      });
    }

    // --- Create the account and API key now that human has approved ---
    const { data: existingUser } = await supabase_rr_service
      .from("users")
      .select("id, team_id")
      .eq("email", sponsor.email)
      .limit(1);

    let teamId: string;
    let apiKeyId: number;

    if (existingUser && existingUser.length > 0) {
      // Existing Firecrawl user — add a new agent key to their team
      teamId = existingUser[0].team_id;

      const { data: newKey, error: newKeyError } = await supabase_service
        .from("api_keys")
        .insert({
          name: `Agent: ${sponsor.agent_name}`,
          team_id: teamId,
          owner_id: existingUser[0].id,
          agent_provisioned: true,
        } as any)
        .select("id, key")
        .single();

      if (newKeyError || !newKey) {
        logger.error("Failed to create API key for existing user", {
          error: newKeyError,
        });
        return res
          .status(500)
          .json({ success: false, error: "Failed to create API key." });
      }

      apiKeyId = newKey.id;

      logger.info("Created agent key for existing user", {
        email: sponsor.email,
        teamId,
        apiKeyId,
      });
    } else {
      // New user — create a full account via Supabase auth (triggers
      // handle_new_user which creates org → team → default api_key)
      const { data: newUser, error: newUserError } =
        await supabase_service.auth.admin.createUser({
          email: sponsor.email,
          email_confirm: true,
          user_metadata: {
            referrer_integration: "agent_access",
            agent_name: sponsor.agent_name,
          },
        });

      if (newUserError) {
        logger.error("Failed to create user account", {
          error: newUserError,
        });
        return res
          .status(500)
          .json({ success: false, error: "Failed to create account." });
      }

      // Fetch the team and key created by the trigger
      const { data: fcUser, error: fcUserError } = await supabase_service
        .from("users")
        .select("team_id")
        .eq("id", newUser.user.id)
        .single();

      if (fcUserError || !fcUser) {
        logger.error("Failed to look up user after creation", {
          error: fcUserError,
        });
        return res
          .status(500)
          .json({ success: false, error: "Failed to create account." });
      }

      teamId = fcUser.team_id;

      const { data: keyData, error: keyError } = await supabase_service
        .from("api_keys")
        .select("id, key")
        .eq("team_id", teamId)
        .limit(1)
        .single();

      if (keyError || !keyData) {
        logger.error("Failed to look up API key for new user", {
          error: keyError,
        });
        return res
          .status(500)
          .json({ success: false, error: "Failed to create account." });
      }

      apiKeyId = keyData.id;

      // Mark the key as agent-provisioned
      await supabase_service
        .from("api_keys")
        .update({
          agent_provisioned: true,
          name: `Agent: ${sponsor.agent_name}`,
        } as any)
        .eq("id", apiKeyId);

      // Provision billing if Autumn is enabled
      if (isAutumnEnabled()) {
        const { data: teamWithOrg } = await supabase_service
          .from("teams")
          .select("org_id")
          .eq("id", teamId)
          .single();

        await autumnService.ensureTeamProvisioned({
          teamId,
          orgId: teamWithOrg?.org_id ?? undefined,
        });
      }

      logger.info("Created new account via agent access approval", {
        email: sponsor.email,
        teamId,
        apiKeyId,
      });
    }

    // --- Link the sponsor record to the new key ---
    const { error: linkError } = await supabase_service
      .from("agent_sponsors")
      .update({ api_key_id: apiKeyId } as any)
      .eq("id", sponsor.id);

    if (linkError) {
      logger.error("Failed to link api_key_id to sponsor record", {
        error: linkError,
      });
    }

    // Mark verified
    await markSponsorVerified({ sponsorId: sponsor.id });

    return res.status(200).json({
      success: true,
      message: "Access approved. The agent can now retrieve its API key.",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: "Invalid request: token is required.",
      });
    }
    logger.error("Unexpected error in agent access approve", { error });
    return res
      .status(500)
      .json({ success: false, error: "Internal server error" });
  }
}

// ---------------------------------------------------------------------------
// POST /v2/agent-access/reject
//
// Human rejects. No account or key was ever created, so just mark blocked.
// ---------------------------------------------------------------------------

export async function agentAccessRejectController(req: Request, res: Response) {
  const logger = _logger.child({
    module: "v2/agent-access",
    method: "reject",
  });

  try {
    const incomingIP = req.ip || req.socket.remoteAddress || "unknown";
    try {
      await approveRejectLimiter.consume(incomingIP);
    } catch {
      return res.status(429).json({
        success: false,
        error: "Too many attempts. Please try again later.",
      });
    }

    const { token } = tokenSchema.parse(req.body);

    const sponsor = await getAgentSponsorByToken({
      agent_signup_token: token,
    });
    if (!sponsor) {
      return res.status(404).json({
        success: false,
        error: "Invalid token.",
      });
    }

    if (sponsor.status === "blocked") {
      return res.status(200).json({
        success: true,
        message: "This access request has already been rejected.",
      });
    }

    if (sponsor.status === "verified") {
      return res.status(409).json({
        success: false,
        error:
          "This access request has already been approved and cannot be rejected.",
      });
    }

    // Mark blocked — nothing else to clean up since no key was ever created
    await markSponsorBlocked({ sponsorId: sponsor.id });

    logger.info("Agent access rejected", {
      email: sponsor.email,
    });

    return res.status(200).json({
      success: true,
      message: "Access rejected and blocked.",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: "Invalid request: token is required.",
      });
    }
    logger.error("Unexpected error in agent access reject", { error });
    return res
      .status(500)
      .json({ success: false, error: "Internal server error" });
  }
}
