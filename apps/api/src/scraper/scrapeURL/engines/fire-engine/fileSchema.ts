import { z } from "zod";

/**
 * The `file` member of a fire-engine chrome-cdp success response (the file
 * download handler). Small files arrive inline as base64 `content`; large
 * PDFs arrive as a GCS reference instead (fire-engine uploads them to its
 * handoff bucket rather than inlining hundreds of MB of base64 into the
 * response). Exactly one of `content` / `gcs_uri` is expected.
 *
 * Shared by BOTH response parsers on purpose. fire-engine can return the
 * finished job from `POST /scrape` directly (fireEngineScrape) or from the
 * `GET /scrape/:id` poll (fireEngineCheckStatus); a handoff that only one of
 * them understood was rejected as "response not matched by any schema" on
 * the fast path, which made every quick large-PDF download look like an
 * engine failure and re-ran the download on the next engine.
 */
export const fireEngineFileSchema = z
  .object({
    name: z.string(),
    content: z.string().optional(),
    gcs_uri: z.string().optional(),
    sha256: z.string().optional(),
    size_bytes: z.number().optional(),
  })
  .refine(f => (f.content !== undefined) !== (f.gcs_uri !== undefined), {
    message: "file must carry exactly one of content or gcs_uri",
  })
  .optional()
  .or(z.null());
