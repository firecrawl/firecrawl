import { logger as _logger } from "../../../lib/logger";
import { Request, Response } from "express";
import { supabase_service } from "../../../services/supabase";
import crypto from "crypto";
import { z } from "zod";
import { validate as isUuid } from "uuid";
import { parseApi } from "../../../lib/parseApi";

/**
 * Extracts the external user ID from a synthetic email if it matches the pattern.
 * Returns null if the email is not a synthetic one for this integration.
 */
function extractExternalUserId(
  email: string,
  integrationSlug: string,
): string | null {
  const syntheticDomain = `@${integrationSlug}.partner.firecrawl.dev`;
  if (email.endsWith(syntheticDomain)) {
    return email.slice(0, -syntheticDomain.length);
  }
  return null;
}

export async function integValidateApiKeyController(
  req: Request,
  res: Response,
) {
  let logger = _logger.child({
    module: "v0/admin/validate-api-key",
    method: "validateApiKeyController",
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

    const bodySchema = z.object({
      apiKey: z.string(),
    });

    const body = bodySchema.parse(req.body);

    const normalizedApiKey = parseApi(body.apiKey);

    if (!isUuid(normalizedApiKey)) {
      return res.status(400).json({ error: "API key is invalid" });
    }

    const { data: apiKeyData, error: apiKeyError } = await supabase_service
      .from("api_keys")
      .select("*")
      .eq("key", normalizedApiKey)
      .limit(1);

    if (apiKeyError) {
      throw apiKeyError;
    }

    if (!apiKeyData || apiKeyData.length === 0) {
      return res.status(404).json({ error: "API key not identifiable" });
    }

    const teamId = apiKeyData[0].team_id;

    logger = logger.child({
      teamId,
    });

    const { data: teamData, error: teamError } = await supabase_service
      .from("teams")
      .select("*")
      .eq("id", teamId)
      .limit(1);
    if (teamError) {
      throw teamError;
    }

    if (!teamData || teamData.length === 0) {
      return res.status(404).json({ error: "API key not identifiable" });
    }

    const team = teamData[0];

    if (team.referrer_integration !== integration.slug) {
      return res.status(404).json({ error: "API key not identifiable" });
    }

    const { data: userTeams, error: userTeamsError } = await supabase_service
      .from("user_teams")
      .select("*")
      .eq("team_id", teamId)
      .limit(1);
    if (userTeamsError) {
      throw userTeamsError;
    }

    if (!userTeams || userTeams.length === 0) {
      throw new Error("user_teams in invalid state");
    }

    const userId = userTeams[0].user_id;

    const { data: userData, error: userError } = await supabase_service
      .from("users")
      .select("*")
      .eq("id", userId)
      .limit(1);
    if (userError) {
      throw userError;
    }

    if (!userData || userData.length === 0) {
      throw new Error("users in invalid state");
    }

    const user = userData[0];

    const externalUserId = extractExternalUserId(user.email, integration.slug);

    return res.status(200).json({
      teamName: team.name,
      email: user.email,
      ...(externalUserId && { externalUserId }),
    });
  } catch (error) {
    logger.error("Error validating API key", { error });
    return res.status(500).json({ error: "Internal server error" });
  }
}
