import { buildAnchorContext } from "./pipeline/anchor";
import type { CacheBackend } from "./core/cache";
import { CACHE_VERSION, CODEGEN_MODEL, MARKDOWN_BUDGET } from "./config";
import { CostTracking } from "../cost-tracking";
import { generateExtractor } from "./pipeline/generate";
import { type AskLlm, makeAskLlm } from "./llm/client";
import { parseWithSchema } from "./pipeline/postprocess";
import {
  runExtractorInSandbox,
  type SandboxRunner,
} from "./sandbox/runExtractor";
import { tooStrictFeedback, tooStrictSelectors } from "./html/selector-repair";
import { errorMessage, log, sha } from "./core/util";

interface ExtractArgs {
  url: string;
  prompt: string;
  jsonSchema: Record<string, unknown>;
  page: { html: string; markdown: string };
  cache: CacheBackend;
  sandbox: SandboxRunner;
  costTracking: CostTracking;
  maxAskLlmCalls?: number;
  forceRegenerate?: boolean;
}

export async function extractDeterministicJson(
  args: ExtractArgs,
): Promise<unknown> {
  const {
    url,
    prompt,
    forceRegenerate,
    cache,
    sandbox,
    jsonSchema,
    costTracking,
  } = args;

  const schemaJson = JSON.stringify(jsonSchema);
  const key = sha(
    [CACHE_VERSION, CODEGEN_MODEL, url, schemaJson, prompt].join("\0"),
  );
  const meta = { url, model: CODEGEN_MODEL, cacheVersion: CACHE_VERSION };

  const { html, markdown } = args.page;
  const markdownPreview = clipMiddle(markdown.trim(), MARKDOWN_BUDGET);
  const cached = forceRegenerate ? undefined : await cache.getExtractor(key);

  let anchorHtml: string | undefined;

  const generate = async (
    rejectionFeedback?: string,
    previousCode?: string,
  ): Promise<string> => {
    anchorHtml ??= await buildAnchorContext(
      {
        html,
        markdownPreview,
        schemaJson,
        prompt,
      },
      costTracking,
    );
    const code = await generateExtractor(
      {
        anchorHtml,
        markdownPreview,
        schemaJson,
        prompt,
        rejectionFeedback,
        previousCode,
      },
      costTracking,
    );
    await cache.setExtractor(key, code, meta);
    return code;
  };

  const run = async (code: string): Promise<unknown> => {
    const askLlm: AskLlm = makeAskLlm(cache, costTracking, args.maxAskLlmCalls);
    const value = await runExtractorInSandbox({
      code,
      html,
      url,
      askLlm,
      sandbox,
    });
    return parseWithSchema(value, jsonSchema);
  };

  const runWithRepair = async (code: string): Promise<unknown> => {
    const value = await run(code);
    const broken = tooStrictSelectors(code, html);
    if (broken.length === 0) return value;

    log(
      `extractor has ${broken.length} too-strict selector(s); regenerating once`,
    );
    try {
      const repaired = await generate(tooStrictFeedback(broken), code);
      if (tooStrictSelectors(repaired, html).length < broken.length) {
        return await run(repaired);
      }
    } catch (err) {
      log(
        "selector repair failed, keeping original result:",
        errorMessage(err),
      );
    }
    await cache.setExtractor(key, code, meta);
    return value;
  };

  let code: string;
  if (cached) {
    await cache.touch?.(key);
    code = cached.code;
  } else {
    code = await generate();
  }

  try {
    return await runWithRepair(code);
  } catch (err) {
    log("extractor run failed, regenerating once:", errorMessage(err));
    // Let a second failure propagate; the caller warns. An empty shape here
    // would instead read as "page had no data" and hide the real failure.
    return await run(await generate(errorMessage(err), code));
  }
}

function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = `\n\n[...${text.length - max} chars trimmed...]\n\n`;
  const head = Math.ceil((max - marker.length) * 0.7);
  return (
    text.slice(0, head) + marker + text.slice(-(max - marker.length - head))
  );
}
