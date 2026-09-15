import { z } from "zod";
import { config } from "../../config";
import type { TeamFlags } from "../../controllers/v2/types";
import { getThirdPartyDataTermsRequiredResponse } from "../../lib/exchange";
import { exchangeRequest } from "./client";
import { refusal, type ExchangeResponse, type ProviderCall } from "./contracts";

const requirementsSchema = z.object({
  providers: z.array(
    z.object({
      provider: z.string(),
      required: z.boolean(),
      terms: z
        .object({ key: z.string(), version: z.string() })
        .passthrough()
        .nullable(),
    }),
  ),
});

export async function authorizeProviders(
  teamId: string,
  calls: ProviderCall[],
  flags: TeamFlags | null | undefined,
): Promise<ExchangeResponse | undefined> {
  const providers = [...new Set(calls.map(call => call.provider))];
  const response = await exchangeRequest({
    teamId,
    path: "/v1/provider-terms/requirements",
    body: { providers },
    timeoutMs: 10000,
  }).catch(() => undefined);
  if (response?.status === 404)
    return refusal(404, "Unknown provider. No provider was executed.", {
      code: "unknown_provider",
    });
  const parsed =
    response?.status === 200
      ? requirementsSchema.safeParse(response.body)
      : undefined;
  const answered = new Set(
    parsed?.success ? parsed.data.providers.map(item => item.provider) : [],
  );
  if (
    !parsed?.success ||
    answered.size !== providers.length ||
    providers.some(provider => !answered.has(provider))
  )
    return refusal(
      503,
      "Provider agreements are unavailable. No provider was executed.",
    );
  if (config.USE_DB_AUTHENTICATION !== true) return undefined;

  for (const item of parsed.data.providers) {
    const access = flags?.organizationDataSourceAccess?.[item.provider];
    if (access && access.status !== "enabled")
      return refusal(
        403,
        `Access to ${item.provider} is disabled for this organization.`,
      );
    if (
      item.required &&
      item.terms &&
      (access?.termsKey !== item.terms.key ||
        access?.termsVersion !== item.terms.version)
    )
      return {
        status: 403,
        body: getThirdPartyDataTermsRequiredResponse(item.terms),
      };
  }
  return undefined;
}
