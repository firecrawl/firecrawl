// This file is an exception to the "no supabase in scrapeURL" rule,
// and it makes me sad. - mogery

import { supabase_service } from "../../../services/supabase";
import { config } from "../../../config";
import { Meta } from "..";
import { Document } from "../../../controllers/v1/types";

export function uploadScreenshot(meta: Meta, document: Document): Document {
  if (
    config.USE_DB_AUTHENTICATION &&
    document.screenshot !== undefined &&
    document.screenshot.startsWith("data:")
  ) {
    meta.logger.debug("Uploading screenshot to Supabase...");

    const fileName = `screenshot-${crypto.randomUUID()}.png`;

    supabase_service.storage
      .from("media")
      .upload(
        fileName,
        Buffer.from(document.screenshot.split(",")[1], "base64"),
        {
          cacheControl: "3600",
          upsert: false,
          contentType: document.screenshot.split(":")[1].split(";")[0],
        },
      );

    document.screenshot = `https://service.firecrawl.dev/storage/v1/object/public/media/${encodeURIComponent(fileName)}`;
  }

  return document;
}
