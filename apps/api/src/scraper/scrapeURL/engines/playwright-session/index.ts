import { z } from "zod";
import { config } from "../../../../config";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { robustFetch } from "../../lib/fetch";
import { TransportableError } from "../../../../lib/error";

const snapshotResponseSchema = z.object({
  content: z.string(),
  pageStatusCode: z.number(),
  url: z.string().optional(),
});

function buildSnapshotUrl(sessionId: string): string {
  const raw = config.PLAYWRIGHT_MICROSERVICE_URL!;
  const parsed = new URL(raw);
  return `${parsed.protocol}//${parsed.host}/sessions/${encodeURIComponent(sessionId)}/snapshot`;
}

export async function scrapeURLWithPlaywrightSession(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const sessionId = meta.internalOptions.sessionId;
  if (!sessionId) {
    throw new Error(
      "playwright-session engine invoked without internalOptions.sessionId",
    );
  }

  let response: z.infer<typeof snapshotResponseSchema>;
  try {
    response = await robustFetch({
      url: buildSnapshotUrl(sessionId),
      method: "POST",
      body: {},
      logger: meta.logger.child({
        method: "scrapeURLWithPlaywrightSession/robustFetch",
      }),
      schema: snapshotResponseSchema,
      mock: meta.mock,
      abort: meta.abort.asSignal(),
    });
  } catch (err) {
    const status = (err as any)?.cause?.response?.status;
    if (status === 404) {
      throw new TransportableError(
        "LOCAL_BROWSER_SESSION_NOT_FOUND",
        "Local browser session not found or has expired.",
        { cause: err },
      );
    }
    throw err;
  }

  return {
    url: response.url ?? meta.url,
    html: response.content,
    statusCode: response.pageStatusCode,
    proxyUsed: "basic",
  };
}

export function playwrightSessionMaxReasonableTime(_meta: Meta): number {
  return 30000;
}
