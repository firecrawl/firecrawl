import type { AskLlm } from "../llm/client";
import { EXTRACTOR_HARNESS } from "./harness";

export type SandboxRunner = (job: {
  code: string;
  input: unknown;
  onHost: (channel: string, payload: unknown) => Promise<unknown>;
}) => Promise<unknown>;

export async function runExtractorInSandbox(args: {
  code: string;
  html: string;
  url: string;
  askLlm: AskLlm;
  sandbox: SandboxRunner;
}): Promise<unknown> {
  return args.sandbox({
    code: EXTRACTOR_HARNESS,
    input: { code: args.code, html: args.html, url: args.url },
    onHost: async (channel, payload) => {
      if (channel !== "askLlm")
        throw new Error(`unknown sandbox channel: ${channel}`);
      const { prompt, schema } = (payload ?? {}) as {
        prompt?: string;
        schema?: unknown;
      };
      return args.askLlm(String(prompt ?? ""), schema ?? undefined);
    },
  });
}
