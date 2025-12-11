import { logger as _logger, logger } from "../../../lib/logger";
import { Request, Response } from "express";
import { supabase_service } from "../../../services/supabase";
import crypto from "crypto";
import { z } from "zod";
import { apiKeyToFcApiKey } from "../../../lib/parseApi";

async function addCoupon(teamId: string, integration: any) {
  if (!integration.coupon_credits) {
    return;
  }

  const { error } = await supabase_service.from("coupons").insert({
    team_id: teamId,
    credits: integration.coupon_credits,
    status: "active",
    from_auto_recharge: false,
    initial_credits: integration.coupon_credits,
    code: integration.coupon_code,
    is_extract: false,
    expires_at: integration.coupon_expiry_ms
      ? new Date(Date.now() + integration.coupon_expiry_ms).toISOString()
      : null,
    override_rate_limits: integration.coupon_rate_limits,
    override_concurrency: integration.coupon_concurrency,
  });

  if (error) {
    throw error;
  }
}

/**
 * Generates a synthetic email for partner integrations that don't provide real emails.
 * Format: <externalUserId>@<integration-slug>.partner.firecrawl.dev
 */
function generateSyntheticEmail(
  externalUserId: string,
  integrationSlug: string,
): string {
  // Sanitize the externalUserId to be email-safe (alphanumeric, dots, hyphens, underscores)
  const sanitizedId = externalUserId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${sanitizedId}@${integrationSlug}.partner.firecrawl.dev`;
}

export async function integCreateUserController(req: Request, res: Response) {
  let logger = _logger.child({
    module: "v0/admin/create-user",
    method: "createUserController",
  });

  try {
    const auth = req.headers.authorization;
    if (!auth) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const [type, token] = auth.split(" ");
    if (type !== "Bearer") {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // sha-256 hash the token
    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    // Look up integration by key
    const { data: integration, error: integrationError } =
      await supabase_service
        .from("user_referring_integration")
        .select("*")
        .eq("key", hashedToken)
        .single();

    if (integrationError || !integration) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    logger = logger.child({
      integration: integration.slug,
    });

    // Accept either email OR externalUserId (for partners that don't share emails)
    const bodySchema = z
      .object({
        email: z.string().email().optional(),
        externalUserId: z.string().min(1).optional(),
      })
      .refine(data => data.email || data.externalUserId, {
        message: "Either email or externalUserId must be provided",
      });

    const body = bodySchema.parse(req.body);

    // Determine the email to use
    const email = body.email
      ? body.email
      : generateSyntheticEmail(body.externalUserId!, integration.slug);

    const { data: preexistingUser, error: preexistingUserError } =
      await supabase_service
        .from("users")
        .select("*")
        .eq("email", email)
        .limit(1);
    if (preexistingUserError) {
      logger.error("Failed to look up preexisting user", {
        error: preexistingUserError,
      });
      return res
        .status(500)
        .json({ error: "Failed to look up preexisting user" });
    }

    let teamId: string;
    let apiKey: string;
    let alreadyExisted = false;

    if (preexistingUser.length > 0) {
      const { data: userTeams, error: userTeamsError } = await supabase_service
        .from("user_teams")
        .select("*")
        .eq("user_id", preexistingUser[0].id);
      if (userTeamsError) {
        logger.error("Failed to look up user teams", {
          error: userTeamsError,
        });
        return res.status(500).json({ error: "Failed to look up user teams" });
      }

      // check if a team of the same referrer already exists
      const { data: existingTeam, error: existingTeamError } =
        await supabase_service
          .from("teams")
          .select("*")
          .eq("referrer_integration", integration.slug)
          .in(
            "id",
            userTeams.map(team => team.team_id),
          )
          .limit(1);
      if (existingTeamError) {
        logger.error("Failed to look up existing team", {
          error: existingTeamError,
        });
        return res
          .status(500)
          .json({ error: "Failed to look up existing team" });
      }

      if (existingTeam.length > 0) {
        teamId = existingTeam[0].id;

        const { data: existingApiKey, error: existingApiKeyError } =
          await supabase_service
            .from("api_keys")
            .select("*")
            .eq("team_id", teamId)
            .limit(1);
        if (existingApiKeyError) {
          logger.error("Failed to look up existing api key", {
            error: existingApiKeyError,
          });
          return res
            .status(500)
            .json({ error: "Failed to look up existing api key" });
        }

        if (existingApiKey.length > 0) {
          apiKey = existingApiKey[0].key;
        } else {
          return res.status(500).json({
            error: "No api key found for existing team with the same referrer",
          });
        }

        alreadyExisted = true;

        logger.info("Found existing team from existing user", {
          teamId,
        });
      } else {
        // create a new team with this referrer
        const { data: newTeam, error: newTeamError } = await supabase_service
          .from("teams")
          .insert({
            name: "via " + (integration.display_name ?? integration.slug),
            referrer_integration: integration.slug,
          })
          .select()
          .single();
        if (newTeamError) {
          logger.error("Failed to create new team", { error: newTeamError });
          return res.status(500).json({ error: "Failed to create new team" });
        }
        teamId = newTeam.id;

        const { error: newUserTeamError } = await supabase_service
          .from("user_teams")
          .insert({
            user_id: preexistingUser[0].id,
            team_id: teamId,
          });

        if (newUserTeamError) {
          logger.error("Failed to add user to team", {
            error: newUserTeamError,
          });
          return res.status(500).json({ error: "Failed to add user to team" });
        }

        const { data: newApiKey, error: newApiKeyError } =
          await supabase_service
            .from("api_keys")
            .insert({
              name: "Default",
              team_id: teamId,
              owner_id: preexistingUser[0].id,
            })
            .select()
            .single();
        if (newApiKeyError) {
          logger.error("Failed to create new api key", {
            error: newApiKeyError,
          });
          return res
            .status(500)
            .json({ error: "Failed to create new api key" });
        }
        apiKey = newApiKey.key;

        await addCoupon(teamId, integration);

        logger.info("Created new team from existing user", {
          teamId,
        });
      }
    } else {
      const { data: newUser, error: newUserError } =
        await supabase_service.auth.admin.createUser({
          email: email,
          email_confirm: true,
          user_metadata: {
            referrer_integration: integration.slug,
            ...(body.externalUserId && {
              external_user_id: body.externalUserId,
            }),
          },
        });

      if (newUserError) {
        logger.error("Failed to create user", { error: newUserError });
        return res.status(500).json({ error: "Failed to create user" });
      }

      const { data: newUserFc, error: newUserFcError } = await supabase_service
        .from("users")
        .select("*")
        .eq("id", newUser.user.id)
        .single();
      if (newUserFcError || !newUserFc) {
        logger.error("Failed to look up new user", { error: newUserFcError });
        return res.status(500).json({ error: "Failed to look up new user" });
      }

      teamId = newUserFc.team_id;

      const { data: apiKeyFc, error: apiKeyFcError } = await supabase_service
        .from("api_keys")
        .select("*")
        .eq("team_id", teamId)
        .single();
      if (apiKeyFcError || !apiKeyFc) {
        logger.error("Failed to look up api key", { error: apiKeyFcError });
        return res.status(500).json({ error: "Failed to look up api key" });
      }

      apiKey = apiKeyFc.key;

      await addCoupon(teamId, integration);

      logger.info("Created new user from scratch", {
        teamId,
      });
    }

    return res.status(200).json({
      apiKey: apiKeyToFcApiKey(apiKey),
      alreadyExisted,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.message });
    } else {
      logger.error("Failed to create user", { error });
      return res.status(500).json({ error: "Internal server error" });
    }
  }
}
