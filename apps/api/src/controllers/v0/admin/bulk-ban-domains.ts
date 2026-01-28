import { Request, Response } from "express";
import { supabase_service } from "../../../services/supabase";
import { initializeBlocklist } from "../../../scraper/WebScraper/utils/blocklist";
import { logger as _logger } from "../../../lib/logger";
import { z } from "zod";

const bulkBanDomainsSchema = z.object({
  domains: z
    .array(z.string().min(1).max(253))
    .min(1, "At least one domain is required")
    .max(1000, "Maximum 1000 domains per request"),
});

export async function bulkBanDomainsController(req: Request, res: Response) {
  const logger = _logger.child({
    module: "admin",
    method: "bulkBanDomainsController",
  });

  try {
    const parseResult = bulkBanDomainsSchema.safeParse(req.body);

    if (!parseResult.success) {
      return res.status(400).json({
        error: "Invalid request body",
        details: parseResult.error.issues,
      });
    }

    const { domains } = parseResult.data;

    // Normalize domains (lowercase, trim whitespace)
    const normalizedDomains = domains.map(d => d.trim().toLowerCase());

    // Fetch current blocklist
    const { data: blocklistRecord, error: fetchError } = await supabase_service
      .from("blocklist")
      .select("*")
      .single();

    if (fetchError) {
      logger.error("Error fetching blocklist", { error: fetchError });
      return res
        .status(500)
        .json({ error: "Failed to fetch current blocklist" });
    }

    if (!blocklistRecord) {
      logger.error("No blocklist record found");
      return res.status(500).json({ error: "Blocklist not found in database" });
    }

    const currentBlocklist: string[] = blocklistRecord.data?.blocklist ?? [];

    // Add new domains, avoiding duplicates
    const existingSet = new Set(currentBlocklist.map(d => d.toLowerCase()));
    const newDomains: string[] = [];
    const alreadyBanned: string[] = [];

    for (const domain of normalizedDomains) {
      if (existingSet.has(domain)) {
        alreadyBanned.push(domain);
      } else {
        newDomains.push(domain);
        existingSet.add(domain);
      }
    }

    if (newDomains.length === 0) {
      return res.status(200).json({
        ok: true,
        message: "No new domains to ban",
        added: 0,
        alreadyBanned: alreadyBanned.length,
        alreadyBannedDomains: alreadyBanned,
      });
    }

    // Update the blocklist
    const updatedBlocklist = [...currentBlocklist, ...newDomains];
    const updatedData = {
      ...blocklistRecord.data,
      blocklist: updatedBlocklist,
    };

    const { error: updateError } = await supabase_service
      .from("blocklist")
      .update({ data: updatedData })
      .eq("id", blocklistRecord.id);

    if (updateError) {
      logger.error("Error updating blocklist", { error: updateError });
      return res.status(500).json({ error: "Failed to update blocklist" });
    }

    // Refresh in-memory blocklist
    try {
      await initializeBlocklist();
      logger.info("Blocklist refreshed in memory");
    } catch (refreshError) {
      logger.warn(
        "Failed to refresh blocklist in memory, will require server restart",
        {
          error: refreshError,
        },
      );
    }

    logger.info("Bulk ban domains completed", {
      addedCount: newDomains.length,
      alreadyBannedCount: alreadyBanned.length,
      newDomains,
    });

    return res.status(200).json({
      ok: true,
      message: `Successfully banned ${newDomains.length} domain(s)`,
      added: newDomains.length,
      addedDomains: newDomains,
      alreadyBanned: alreadyBanned.length,
      alreadyBannedDomains: alreadyBanned,
      totalBlocklistSize: updatedBlocklist.length,
    });
  } catch (error) {
    logger.error("Unexpected error in bulk ban domains", { error });
    return res.status(500).json({ error: "Internal server error" });
  }
}
