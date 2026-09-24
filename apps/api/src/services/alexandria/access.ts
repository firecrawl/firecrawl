import { z } from "zod";
import { config } from "../../config";
import type { TeamFlags } from "../../controllers/v2/types";
import { getThirdPartyDataTermsRequiredResponse } from "../../lib/exchange";
import { exchangeRequest } from "./client";
import { refusal, type ExchangeResponse, type ProviderCall } from "./contracts";
import { acceptedProviders, type LedgerAcceptance } from "./terms";
import { autumnService } from "../autumn/autumn.service";
import { HOBBY_RATE_LIMIT_MULTIPLIER } from "../rate-limiter";

const requirementsSchema = z.object({
  providers: z.array(
    z.object({
      provider: z.string(),
      required: z.boolean(),
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

const timestampSchema = z.iso.datetime({ offset: true });

function timestamp(value: unknown): number {
  const parsed = timestampSchema.safeParse(value);
  return parsed.success ? Date.parse(parsed.data) : NaN;
}

function matchesAcceptance(
  accepted: LedgerAcceptance | undefined,
  terms: { version: string; digest?: string },
): boolean {
  return (
    terms.digest !== undefined &&
    accepted?.version === terms.version &&
    accepted.textHash === terms.digest
  );
}

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
    const access = flags?.organizationDataSourceAccess?.[item.provider];
    if (access && access.status !== "enabled") {
      const revokedByOwner =
        access.status === "disabled" &&
        access.disabledReason === "revoked_by_organization_admin";
      if (revokedByOwner && item.required && item.terms && orgId !== null) {
        ledger ??= await acceptedProviders(teamId, orgId);
        const accepted = ledger.get(item.provider);
        const acceptedAt = timestamp(accepted?.acceptedAt);
        const disabledAt = timestamp(access.disabledAt);
        if (
          matchesAcceptance(accepted, item.terms) &&
          Number.isFinite(acceptedAt) &&
          Number.isFinite(disabledAt) &&
          acceptedAt > disabledAt
        )
          continue;
        return {
          status: 403,
          body: getThirdPartyDataTermsRequiredResponse(item.terms),
        };
      }
      return refusal(
        403,
        `Access to ${item.provider} is disabled for this organization.`,
      );
    }
    if (!item.required || !item.terms) continue;
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
      body: getThirdPartyDataTermsRequiredResponse(item.terms),
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
  // A licence that permits the payload only in response to a paid request
  // (Benzinga Schedule C.4: full text, WIIM, analyst ratings). Credits alone
  // do not prove payment, because a free team spends signup credits; the plan
  // does. Autumn's rate-limit multiplier is 1 on the free plan and at least the
  // hobby floor on every paid one. It comes from the entity read the rate
  // limiter caches per team, so a warm cache costs nothing and a cold one
  // costs the fetch the limiter would have made anyway. This gate fails
  // closed: a team whose plan cannot be known (no org to bill, a preview team,
  // an Autumn error) is refused, where the rate limiter would fail open, since
  // delivering licensed content to a possibly free team is the mistake the
  // licence forbids. Internal teams that bypass credit checks are not
  // customers and pass.
  if (gated.length > 0 && flags?.bypassCreditChecks !== true) {
    const multiplier = await autumnService.getKnownRateLimitMultiplier(
      teamId,
      orgId,
    );
    if (multiplier === null)
      return refusal(
        503,
        "Your plan could not be verified for a paid-plan-only capability. No provider was executed.",
        { code: "plan_verification_unavailable" },
      );
    if (multiplier < HOBBY_RATE_LIMIT_MULTIPLIER) {
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
