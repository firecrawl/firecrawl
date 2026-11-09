import { ErrorCodes, TransportableError } from "../error";
import type { ThreatDecision } from "./types";

// Error surfaced when threat protection blocks a URL. Wired into the shared
// TransportableError machinery (src/lib/error.ts + src/lib/error-serde.ts) so
// blocked scrapes surface as a clean, documented API error — both on sync
// responses (`code: "unsafe_domain_blocked"`, name kept for API stability
// even though checks are URL-level) and on crawl/batch job document errors.
// The full ThreatDecision rides along in serialize() so the billing layer can
// read it even across the job queue.

export class UnsafeDomainBlockedError extends TransportableError {
  /** Canonicalized host of the blocked URL (from the decision). */
  public readonly domain: string;

  constructor(
    /** The blocked URL (or bare domain, e.g. for a blocked crawl seed). */
    public readonly url: string,
    public readonly decision: ThreatDecision,
  ) {
    super(
      "unsafe_domain_blocked",
      `This URL (${url}) is blocked by your organization's threat protection policy (rule: ${decision.rule}). ` +
        `If you believe this is a mistake, contact your organization administrator to adjust the policy (e.g. whitelist the domain).`,
    );
    this.name = "UnsafeDomainBlockedError";
    this.domain = decision.domain;
  }

  serialize() {
    return {
      ...super.serialize(),
      url: this.url,
      domain: this.domain,
      decision: this.decision,
    };
  }

  static deserialize(
    _code: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new UnsafeDomainBlockedError(data.url ?? data.domain, {
      ...data.decision,
      // Jobs serialized by a pre-URL-level deploy carry decisions without
      // `url`/`domain`; backfill both so billing dedup and error surfaces
      // keep working mid-rollout.
      url: data.decision.url ?? data.url ?? data.domain,
      domain: data.decision.domain ?? data.domain,
    });
    x.stack = data.stack;
    return x;
  }
}
