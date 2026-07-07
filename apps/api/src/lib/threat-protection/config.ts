import { z } from "zod";
import {
  THREAT_PROTECTION_POLICY_DEFAULTS,
  type ThreatProtectionPolicy,
} from "./types";

// =========================================
// Field schemas
// =========================================

// One DNS label: alphanumeric, optionally with inner hyphens, max 63 chars.
const DOMAIN_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// Plain domain ("example.com", "sub.example.co.uk") or a single leading
// wildcard label ("*.example.com"). No protocol, path, port, or inner "*".
const DOMAIN_GLOB_REGEX = new RegExp(
  `^(\\*\\.)?(?:${DOMAIN_LABEL}\\.)+${DOMAIN_LABEL}$`,
);

const domainGlobSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(value => value.length <= 253 && DOMAIN_GLOB_REGEX.test(value), {
    error: iss =>
      `Invalid domain entry ${JSON.stringify(iss.input)}: must be a plain domain like "example.com" or a wildcard glob like "*.example.com" (no protocol, path, or port)`,
  });

const tldSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(value => /^[a-z0-9]{1,63}$/.test(value), {
    error: iss =>
      `Invalid TLD ${JSON.stringify(iss.input)}: must be a lowercase alphanumeric TLD without the leading dot, e.g. "zip"`,
  });

// =========================================
// Policy + org config schemas
// =========================================

/**
 * Field-for-field zod schema for {@link ThreatProtectionPolicy}. Every field
 * except `mode` defaults to {@link THREAT_PROTECTION_POLICY_DEFAULTS}.
 */
export const threatProtectionPolicySchema = z.strictObject({
  mode: z.enum(["off", "normal"]),
  riskScoreThreshold: z
    .number()
    .int()
    .min(0)
    .max(100)
    .prefault(THREAT_PROTECTION_POLICY_DEFAULTS.riskScoreThreshold),
  blacklist: z
    .array(domainGlobSchema)
    .max(1000)
    .prefault(THREAT_PROTECTION_POLICY_DEFAULTS.blacklist),
  whitelist: z
    .array(domainGlobSchema)
    .max(1000)
    .prefault(THREAT_PROTECTION_POLICY_DEFAULTS.whitelist),
  blockedTlds: z
    .array(tldSchema)
    .max(1000)
    .prefault(THREAT_PROTECTION_POLICY_DEFAULTS.blockedTlds),
  failurePolicy: z
    .enum(["open", "closed"])
    .prefault(THREAT_PROTECTION_POLICY_DEFAULTS.failurePolicy),
});

// Compile-time assertion that the schema output matches the shared contract
// in ./types.ts — fails to typecheck if the two drift apart.
const _policyContractCheck = (
  x: z.infer<typeof threatProtectionPolicySchema>,
): ThreatProtectionPolicy => x;
void _policyContractCheck;

/**
 * Per-request `threatProtection` option: a field-level override of the org
 * config. Mirrors {@link threatProtectionPolicySchema} but every field is
 * optional and NO defaults are injected — only fields the caller explicitly
 * provides replace the org policy's values (see `resolveEffectivePolicy`).
 */
export const threatProtectionOverrideSchema = z.strictObject({
  mode: z.enum(["off", "normal"]).optional(),
  riskScoreThreshold: z.number().int().min(0).max(100).optional(),
  blacklist: z.array(domainGlobSchema).max(1000).optional(),
  whitelist: z.array(domainGlobSchema).max(1000).optional(),
  blockedTlds: z.array(tldSchema).max(1000).optional(),
  failurePolicy: z.enum(["open", "closed"]).optional(),
});

type ThreatProtectionOverride = z.infer<typeof threatProtectionOverrideSchema>;

// Compile-time assertion that the override shape stays assignable to
// Partial<ThreatProtectionPolicy> (what `resolveEffectivePolicy` consumes).
const _overrideContractCheck = (
  x: ThreatProtectionOverride,
): Partial<ThreatProtectionPolicy> => x;
void _overrideContractCheck;

/**
 * Full org-level configuration document, as accepted by
 * `PUT /v2/team/threat-protection`.
 */
export const threatProtectionConfigSchema = threatProtectionPolicySchema.extend(
  {
    allowRequestOverrides: z.boolean().prefault(true),
  },
);

export type ThreatProtectionConfigInput = z.infer<
  typeof threatProtectionConfigSchema
>;
