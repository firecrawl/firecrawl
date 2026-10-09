import { z } from "zod";
import { config } from "../../config";
import type { TeamFlags } from "../../controllers/v2/types";
import { ThirdPartyDataTermsRequiredError } from "../../lib/exchange";
import { exchangeRequest } from "./client";
import { refusal, type ExchangeResponse, type ProviderCall } from "./contracts";
import {
  acceptedAfter,
  acceptedProviders,
  matchesAcceptance,
  type LedgerAcceptance,
} from "./terms";
import { getACUCTeam } from "../../controllers/auth";

const requirementsSchema = z.object({
  providers: z.array(
    z.object({
      provider: z.string(),
      required: z.boolean(),
      exchangeRequired: z.boolean().optional(),
      terms: z
        .object({
          key: z.string(),
          version: z.string(),
          digest: z.string().optional(),
        })
        .passthrough()
        .nullable(),
      // Capabilities whose licence allows the payload only on a paid request
      // (Exchange Capability.paidPlanOnly). Optional so an Exchange deployed
      // before it published the field still authorizes.
      paidPlanOnlyCapabilities: z.array(z.string()).optional(),
    }),
  ),
});

export async function authorizeProviders(
  teamId: string,
  calls: ProviderCall[],
  flags: TeamFlags | null | undefined,
  orgId: string | null = null,
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

  let ledger: Map<string, LedgerAcceptance> | undefined;
  for (const item of parsed.data.providers) {
    const required = item.exchangeRequired ?? item.required;
    const access = flags?.organizationDataSourceAccess?.[item.provider];
    if (access && access.status !== "enabled") {
      const revokedByOwner =
        access.status === "disabled" &&
        access.disabledReason === "revoked_by_organization_admin";
      if (
        revokedByOwner &&
        (item.required || required) &&
        item.terms &&
        orgId !== null
      ) {
        ledger ??= await acceptedProviders(teamId, orgId);
        const accepted = ledger.get(item.provider);
        if (
          matchesAcceptance(accepted, item.terms) &&
          acceptedAfter(accepted, access.disabledAt)
        )
          continue;
        return {
          status: 403,
          body: new ThirdPartyDataTermsRequiredError(item.terms).response(),
        };
      }
      return refusal(
        403,
        `Access to ${item.provider} is disabled for this organization.`,
      );
    }
    if (!required || !item.terms) continue;
    if (
      access?.termsKey === item.terms.key &&
      access?.termsVersion === item.terms.version
    )
      continue;
    if (orgId !== null) {
      ledger ??= await acceptedProviders(teamId, orgId);
      const accepted = ledger.get(item.provider);
      if (matchesAcceptance(accepted, item.terms)) continue;
    }
    return {
      status: 403,
      body: new ThirdPartyDataTermsRequiredError(item.terms).response(),
    };
  }

  const paidPlanOnly = new Set(
    parsed.data.providers.flatMap(item =>
      (item.paidPlanOnlyCapabilities ?? []).map(
        capability => `${item.provider}/${capability}`,
      ),
    ),
  );
  const gated = calls.filter(call =>
    paidPlanOnly.has(`${call.provider}/${call.capability}`),
  );
  // Licensed payloads that may only answer a paid request: refuse teams that
  // aren't on a paid plan. Credit-check bypass teams pass.
  if (gated.length > 0 && flags?.bypassCreditChecks !== true) {
    if (!(await getACUCTeam(teamId))?.is_paid_plan) {
      const addresses = [
        ...new Set(gated.map(call => `${call.provider}/${call.capability}`)),
      ].join(", ");
      return refusal(
        403,
        `${addresses} ${gated.length === 1 ? "is" : "are"} available on paid plans only. Upgrade at ${config.FIRECRAWL_DASHBOARD_URL ?? "https://www.firecrawl.dev"} to use ${gated.length === 1 ? "it" : "them"}. No provider was executed.`,
        { code: "paid_plan_required" },
      );
    }
  }
  return undefined;
}
