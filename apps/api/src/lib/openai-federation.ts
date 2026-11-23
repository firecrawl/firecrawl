// Keep the config import first; see generic-ai.ts.
import { config } from "../config";
import { createOpenAI } from "@ai-sdk/openai";
import { gcpIDTokenProvider } from "openai/auth";
import { WorkloadIdentityAuth } from "openai/auth/workload-identity-auth";

// Tokens are fetched before the model request, outside its abort signal.
const TOKEN_TIMEOUT_MS = 5000;

/**
 * An OpenAI provider that authenticates with workload identity federation:
 * the pod's Google identity token is exchanged for short-lived OpenAI access
 * tokens, cached and refreshed before they expire.
 */
export function createFederatedOpenAI(
  identityProviderId: string,
  serviceAccountId: string,
  baseURL = config.OPENAI_BASE_URL,
) {
  const tokens = new WorkloadIdentityAuth(
    {
      identityProviderId,
      serviceAccountId,
      provider: gcpIDTokenProvider(undefined, { timeout: TOKEN_TIMEOUT_MS }),
    },
    (input, init) =>
      fetch(input, {
        ...init,
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      }),
  );
  return createOpenAI({
    apiKey: () => tokens.getToken(),
    baseURL,
  });
}
