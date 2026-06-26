import type { Meta } from "../../..";
import { fetch as undiciFetch } from "undici";
import { AbortManagerThrownError } from "../../../lib/abortManager";
import {
  POLL_FLOOR_MS,
  resultResponseSchema,
  type ResultResponse,
} from "./schema";
import { failAsync } from "./utils";

type ResultDeps = {
  baseUrl: string;
  scrapeId: string;
  meta: Meta;
  fetchImpl: typeof undiciFetch;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export async function fetchResult(deps: ResultDeps): Promise<ResultResponse> {
  const { baseUrl, scrapeId, meta, fetchImpl, sleep } = deps;
  let retried409 = 0;

  while (true) {
    let resp;
    try {
      resp = await fetchImpl(`${baseUrl}/jobs/${scrapeId}/result`, {
        method: "GET",
        signal: meta.abort.asSignal(),
      });
    } catch (error) {
      if (error instanceof AbortManagerThrownError) throw error;
      failAsync(meta, "network_error", { error: String(error) });
    }

    const status = resp.status;
    const body = await resp.json().catch(() => ({}));

    if (status === 503) {
      failAsync(meta, "result_503", { body });
    }

    if (status === 409) {
      retried409++;
      if (retried409 > 1) {
        failAsync(meta, "http_5xx", {
          status: 409,
          body,
          note: "result endpoint kept returning 409",
        });
      }
      meta.logger.info("FirePDF async result returned 409, re-polling once", {
        scrapeId,
      });
      await sleep(POLL_FLOOR_MS, meta.abort.asSignal());
      continue;
    }

    if (status !== 200) {
      failAsync(meta, "http_5xx", { status, body });
    }

    const parsed = resultResponseSchema.safeParse(body);
    if (!parsed.success) {
      failAsync(meta, "http_5xx", {
        error: String(parsed.error),
        body,
      });
    }
    return parsed.data;
  }
}
