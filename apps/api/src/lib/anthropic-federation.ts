import { createAnthropic } from "@ai-sdk/anthropic";
import { oidcFederationProvider } from "@anthropic-ai/sdk/lib/credentials/oidc-federation";
import { TokenCache } from "@anthropic-ai/sdk/lib/credentials/token-cache";
import { config } from "../config";

const AUDIENCE = "https://api.anthropic.com";
// Tokens are fetched before the model request, outside its abort signal.
const TOKEN_TIMEOUT_MS = 5000;

// The pod's Google service account identity, from the GKE metadata server.
// `format=full` adds the `email` claim the federation rule matches.
async function googleIdentityToken(): Promise<string> {
  const response = await fetch(
    `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(AUDIENCE)}&format=full`,
    {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Google identity token request failed with status ${response.status}`,
    );
  }
  return response.text();
}

/**
 * An Anthropic provider that authenticates with workload identity federation:
 * the Google identity token is exchanged for short-lived Anthropic access
 * tokens, cached and refreshed before they expire.
 */
export function createFederatedAnthropic(
  federationRuleId: string,
  organizationId: string,
) {
  const tokens = new TokenCache(
    oidcFederationProvider({
      identityTokenProvider: googleIdentityToken,
      federationRuleId,
      organizationId,
      serviceAccountId: config.ANTHROPIC_SERVICE_ACCOUNT_ID,
      baseURL: AUDIENCE,
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
        }),
    }),
  );
  return createAnthropic({
    authToken: () => tokens.getToken(),
    headers: { "anthropic-beta": "oauth-2025-04-20" },
  });
}
