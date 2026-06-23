import { config } from "../../../config";
import { Meta } from "..";
import { Document } from "../../../controllers/v1/types";
import { storage } from "../../../lib/gcs-jobs";
import crypto from "crypto";

export async function uploadScreenshot(
  meta: Meta,
  document: Document,
): Promise<Document> {
  if (
    config.USE_DB_AUTHENTICATION &&
    config.GCS_MEDIA_BUCKET_NAME &&
    document.screenshot !== undefined &&
    document.screenshot.startsWith("data:")
  ) {
    meta.logger.debug("Uploading screenshot to GCS...");

    const fileName = `screenshot-${crypto.randomUUID()}.png`;
    const contentType = document.screenshot.split(":")[1].split(";")[0];

    await storage
      .bucket(config.GCS_MEDIA_BUCKET_NAME)
      .file(fileName)
      .save(Buffer.from(document.screenshot.split(",")[1], "base64"), {
        resumable: false,
        contentType,
        metadata: {
          cacheControl: "public, max-age=3600",
        },
      });

    document.screenshot = `https://storage.googleapis.com/${config.GCS_MEDIA_BUCKET_NAME}/${encodeURIComponent(fileName)}`;
  }

  return document;
}
