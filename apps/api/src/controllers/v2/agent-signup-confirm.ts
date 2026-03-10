import { Request, Response } from "express";
import { z } from "zod";
import { logger as _logger } from "../../lib/logger";
import {
  clearAgentSponsorCache,
  getAgentSponsorByToken,
  markSponsorBlocked,
  markSponsorVerified,
} from "../../services/agent-sponsor";
import { supabase_rr_service, supabase_service } from "../../services/supabase";
import { clearACUC } from "../auth";

const agentSignupTokenSchema = z.object({
  agent_signup_token: z.string().min(1),
});

/**
 * POST /v2/agent-signup/confirm
 * Confirms a pending agent sponsor, merging the sandboxed key into the sponsor's real account.
 */
export async function agentSignupConfirmController(
  req: Request,
  res: Response,
) {
  const logger = _logger.child({
    module: "v2/agent-signup-confirm",
    method: "agentSignupConfirmController",
  });

  try {
    const { agent_signup_token } = agentSignupTokenSchema.parse(req.body);

    const sponsor = await getAgentSponsorByToken({ agent_signup_token });
    if (!sponsor) {
      return res.status(404).json({
        success: false,
        error: "Invalid or expired verification token.",
      });
    }

    if (sponsor.status === "verified") {
      return res.status(200).json({
        success: true,
        message: "This agent key has already been confirmed.",
      });
    }

    if (sponsor.status === "blocked") {
      return res.status(403).json({
        success: false,
        error: "This agent signup has been blocked.",
      });
    }

    // Check deadline
    const deadline = new Date(sponsor.verification_deadline);
    if (deadline < new Date()) {
      return res.status(403).json({
        success: false,
        error:
          "Verification deadline has passed. Please log in to manage your account.",
        login_url: "https://firecrawl.dev/signin",
      });
    }

    // Look up existing user by sponsor email
    const { data: existingUser } = await supabase_rr_service
      .from("users")
      .select("id, team_id")
      .eq("email", sponsor.email)
      .limit(1);

    if (existingUser && existingUser.length > 0) {
      // Merge: move the agent API key from the sandboxed team to the existing user's team
      const realTeamId = existingUser[0].team_id;
      const realUserId = existingUser[0].id;

      // Move the API key to the real team
      const { error: moveKeyError } = await supabase_service
        .from("api_keys")
        .update({ team_id: realTeamId, owner_id: realUserId } as any)
        .eq("id", sponsor.api_key_id);

      if (moveKeyError) {
        logger.error("Failed to move API key to real team", {
          error: moveKeyError,
        });
        return res
          .status(500)
          .json({ success: false, error: "Failed to confirm agent key." });
      }

      // Carry over credit_usage from sandboxed team to real team
      const { error: creditMoveError } = await supabase_service
        .from("credit_usage")
        .update({ team_id: realTeamId } as any)
        .eq("team_id", sponsor.sandboxed_team_id);

      if (creditMoveError) {
        logger.warn("Failed to carry over credit usage from sandboxed team", {
          error: creditMoveError,
          sandboxedTeamId: sponsor.sandboxed_team_id,
          realTeamId,
        });
        // Non-fatal: continue with merge
      }

      // Ban the sandboxed team to deactivate it
      const { error: banError } = await supabase_service
        .from("teams")
        .update({ banned: true })
        .eq("id", sponsor.sandboxed_team_id);

      if (banError) {
        logger.warn("Failed to ban sandboxed team", { error: banError });
      }

      logger.info("Agent key merged into existing account", {
        email: sponsor.email,
        realTeamId,
        sandboxedTeamId: sponsor.sandboxed_team_id,
        apiKeyId: sponsor.api_key_id,
      });
    } else {
      // No existing user: the sandboxed account becomes the real account
      // Update the auth.users email from synthetic to the real sponsor email
      const { data: sandboxedTeamUsers } = await supabase_service
        .from("users")
        .select("id")
        .eq("team_id", sponsor.sandboxed_team_id)
        .limit(1);

      if (sandboxedTeamUsers && sandboxedTeamUsers.length > 0) {
        const userId = sandboxedTeamUsers[0].id;

        // Update auth.users email via admin API
        const { error: updateAuthError } =
          await supabase_service.auth.admin.updateUserById(userId, {
            email: sponsor.email,
          });

        if (updateAuthError) {
          logger.error("Failed to update auth user email", {
            error: updateAuthError,
          });
          return res
            .status(500)
            .json({ success: false, error: "Failed to confirm agent key." });
        }

        // Update public.users email
        const { error: updateUserError } = await supabase_service
          .from("users")
          .update({ email: sponsor.email })
          .eq("id", userId);

        if (updateUserError) {
          logger.warn("Failed to update public.users email", {
            error: updateUserError,
          });
        }
      }

      logger.info("Sandboxed account promoted to real account", {
        email: sponsor.email,
        sandboxedTeamId: sponsor.sandboxed_team_id,
        apiKeyId: sponsor.api_key_id,
      });
    }

    // Mark sponsor as verified and clear sponsor cache before clearing ACUC,
    // so that when ACUC is rebuilt it sees verified status (no sandbox cap).
    await markSponsorVerified({ sponsorId: sponsor.id });
    await clearAgentSponsorCache({ apiKeyId: sponsor.api_key_id });

    // Clear ACUC so the key picks up the new plan / verified status
    const { data: apiKeyData } = await supabase_service
      .from("api_keys")
      .select("key")
      .eq("id", sponsor.api_key_id)
      .single();

    if (apiKeyData) {
      await clearACUC(apiKeyData.key);
    }

    return res.status(200).json({
      success: true,
      message: "Agent key confirmed and linked to your account.",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: "Invalid request: agent_signup_token is required.",
      });
    }
    logger.error("Unexpected error in agent signup confirm", { error });
    return res
      .status(500)
      .json({ success: false, error: "Internal server error" });
  }
}

/**
 * POST /v2/agent-signup/block
 * Blocks an agent sponsor, disabling the sandboxed key.
 */
export async function agentSignupBlockController(req: Request, res: Response) {
  const logger = _logger.child({
    module: "v2/agent-signup-block",
    method: "agentSignupBlockController",
  });

  try {
    const { agent_signup_token } = agentSignupTokenSchema.parse(req.body);

    const sponsor = await getAgentSponsorByToken({ agent_signup_token });
    if (!sponsor) {
      return res.status(404).json({
        success: false,
        error: "Invalid verification token.",
      });
    }

    if (sponsor.status === "blocked") {
      return res.status(200).json({
        success: true,
        message: "This agent signup has already been blocked.",
      });
    }

    if (sponsor.status === "verified") {
      return res.status(409).json({
        success: false,
        error:
          "This agent key has already been confirmed and cannot be blocked.",
      });
    }

    // Disable the API key
    const { error: deleteKeyError } = await supabase_service
      .from("api_keys")
      .delete()
      .eq("id", sponsor.api_key_id);

    if (deleteKeyError) {
      logger.warn("Failed to delete agent API key", { error: deleteKeyError });
    }

    // Ban the sandboxed team
    const { error: banError } = await supabase_service
      .from("teams")
      .update({ banned: true })
      .eq("id", sponsor.sandboxed_team_id);

    if (banError) {
      logger.warn("Failed to ban sandboxed team", { error: banError });
    }

    // Mark sponsor as blocked
    await markSponsorBlocked({ sponsorId: sponsor.id });
    await clearAgentSponsorCache({ apiKeyId: sponsor.api_key_id });

    logger.info("Agent signup blocked", {
      email: sponsor.email,
      sandboxedTeamId: sponsor.sandboxed_team_id,
      apiKeyId: sponsor.api_key_id,
    });

    return res.status(200).json({
      success: true,
      message: "Agent key has been blocked and disabled.",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: "Invalid request: agent_signup_token is required.",
      });
    }
    logger.error("Unexpected error in agent signup block", { error });
    return res
      .status(500)
      .json({ success: false, error: "Internal server error" });
  }
}
