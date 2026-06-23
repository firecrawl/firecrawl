import { Meta } from "..";
import { Document } from "../../../controllers/v2/types";
import { redactText } from "../../../lib/fire-privacy-client";

export async function performRedactPII(
  meta: Meta,
  document: Document,
): Promise<Document> {
  if (!meta.options.redactPII) return document;

  // PII redaction requires markdown to redact. If the markdown derivation step
  // ran and produced nothing, fail closed without calling fire-privacy.
  if (typeof document.markdown !== "string") {
    document.markdown = "";
    return document;
  }

  const result = await redactText({
    text: document.markdown,
    url: meta.url,
    logger: meta.logger,
    // meta.options.redactPII is normalized by the Zod transform —
    // truthy here means it's the options object; falsy was already
    // bailed out of above.
    options: meta.options.redactPII || undefined,
  });

  // Swap raw markdown for the redacted version. Caller asked for PII
  // redaction; leaving the leaky one in `document.markdown` is a footgun.
  // On `failed` / `skipped: too_large` (redactedMarkdown === null), fail closed with
  // an empty string so later transformers still receive markdown-shaped input.
  document.markdown = result.redactedMarkdown ?? "";

  return document;
}
