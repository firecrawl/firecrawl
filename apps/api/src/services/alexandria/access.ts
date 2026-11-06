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
import { logger } from "../../lib/logger";

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

type ProviderRequirement = z.infer<
  typeof requirementsSchema
>["providers"][number];

// Last good requirement per provider, served only when Exchange cannot answer. The answer is
// catalogue data, the same for every team, so a recent copy is safe to reuse briefly.
const REQUIREMENTS_FALLBACK_MS = 60 * 60 * 1000;
const lastRequirements = new Map<
  string,
  { at: number; item: ProviderRequirement }
>();

function fallbackRequirements(
  providers: string[],
): ProviderRequirement[] | undefined {
  const now = Date.now();
  const items = providers.map(provider => lastRequirements.get(provider));
  return items.every(
    entry => entry && now - entry.at <= REQUIREMENTS_FALLBACK_MS,
  )
    ? items.map(entry => entry!.item)
    : undefined;
}

export async function authorizeProviders(
  teamId: string,
  calls: ProviderCall[],
  flags: TeamFlags | null | undefined,
  orgId: string | null = null,
  clientIp?: string,
  billingCountry?: string,
): Promise<ExchangeResponse | undefined> {
  const providers = [...new Set(calls.map(call => call.provider))];
  let failure: unknown;
  const deadline = Date.now() + 10000;
  const lookup = () =>
    exchangeRequest({
      teamId,
      path: "/v1/provider-terms/requirements",
      body: { providers },
      timeoutMs: deadline - Date.now(),
      clientIp,
      billingCountry,
    }).catch(error => {
      failure = error;
      return undefined;
    });
  let response = await lookup();
  // A dropped connection or a 5xx usually means an Exchange pod was replaced mid-request; the
  // lookup is read-only, so one retry within the same 10s budget reaches a live pod.
  if (
    (response === undefined || response.status >= 500) &&
    deadline - Date.now() >= 1000
  ) {
    failure = undefined;
    response = await lookup();
  }
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
  let requirements: ProviderRequirement[];
  if (
    !parsed?.success ||
    answered.size !== providers.length ||
    providers.some(provider => !answered.has(provider))
  ) {
    const fallback = fallbackRequirements(providers);
    logger.warn("Exchange provider requirements unavailable", {
      providers,
      servedFromFallback: fallback !== undefined,
      ...(response === undefined
        ? {
            error:
              failure instanceof Error
                ? `${failure.name}: ${failure.message}`
                : String(failure),
          }
        : response.status !== 200
          ? { status: response.status }
          : parsed?.success === false
            ? {
                issues: parsed.error.issues.map(
                  issue => `${issue.path.join(".")}: ${issue.code}`,
                ),
              }
            : {
                missingProviders: providers.filter(
                  provider => !answered.has(provider),
                ),
                unexpectedProviders: [...answered].filter(
                  provider => !providers.includes(provider),
                ),
              }),
    });
    if (!fallback)
      return refusal(
        503,
        "Provider agreements are unavailable. No provider was executed.",
      );
    requirements = fallback;
  } else {
    requirements = parsed.data.providers;
    const at = Date.now();
    for (const item of requirements)
      lastRequirements.set(item.provider, { at, item });
  }
  if (config.USE_DB_AUTHENTICATION !== true) return undefined;

  let ledger: Map<string, LedgerAcceptance> | undefined;
  for (const item of requirements) {
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
        ledger ??= await acceptedProviders(teamId, orgId, undefined, {
          clientIp,
          billingCountry,
        });
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
      ledger ??= await acceptedProviders(teamId, orgId, undefined, {
        clientIp,
        billingCountry,
      });
      const accepted = ledger.get(item.provider);
      if (matchesAcceptance(accepted, item.terms)) continue;
    }
    return {
      status: 403,
      body: new ThirdPartyDataTermsRequiredError(item.terms).response(),
    };
  }

  const paidPlanOnly = new Set(
    requirements.flatMap(item =>
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
