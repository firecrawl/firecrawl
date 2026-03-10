import { logger as _logger } from "../../../lib/logger";
import { Request, Response } from "express";
import { supabase_service } from "../../../services/supabase";
import crypto from "crypto";
import { z } from "zod";
import { validate as isUuid } from "uuid";
import { parseApi, apiKeyToFcApiKey } from "../../../lib/parseApi";

export async function integRotateApiKeyController(req: Request, res: Response) {
  let logger = _logger.child({
    module: "v0/admin/rotate-api-key",
    method: "rotateApiKeyController",
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
      return res.status(404).json({ error: "API key not found" });
    }

    const teamId = apiKeyData[0].team_id;
    const ownerId = apiKeyData[0].owner_id;

    logger = logger.child({ teamId });

    const { data: teamData, error: teamError } = await supabase_service
      .from("teams")
      .select("*")
      .eq("id", teamId)
      .limit(1);

    if (teamError) {
      throw teamError;
    }

    if (!teamData || teamData.length === 0) {
      return res.status(404).json({ error: "API key not found" });
    }

    const team = teamData[0];

    if (team.referrer_integration !== integration.slug) {
      return res.status(404).json({ error: "API key not found" });
    }

    const { data: newApiKey, error: newApiKeyError } = await supabase_service
      .from("api_keys")
      .insert({
        name: "Default",
        team_id: teamId,
        owner_id: ownerId,
      })
      .select()
      .single();

    if (newApiKeyError) {
      logger.error("Failed to create new API key", { error: newApiKeyError });
      return res.status(500).json({ error: "Failed to create new API key" });
    }

    const { error: deleteError } = await supabase_service
      .from("api_keys")
      .delete()
      .eq("key", normalizedApiKey)
      .eq("team_id", teamId)
      .eq("owner_id", ownerId);

    if (deleteError) {
      logger.error("Failed to delete leaked API key", { error: deleteError });
      logger.warn("Old API key may still be active", { oldKey: normalizedApiKey });
    }

    logger.info("Rotated API key", { teamId });

    return res.status(200).json({
      apiKey: apiKeyToFcApiKey(newApiKey.key),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.message });
    } else {
      logger.error("Failed to rotate API key", { error });
      return res.status(500).json({ error: "Internal server error" });
    }
  }
}
