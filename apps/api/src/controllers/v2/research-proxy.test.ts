import {
  featureIdForBillingEndpoint,
  SEARCH_CREDITS_FEATURE_ID,
  CREDITS_FEATURE_ID,
} from "../../services/autumn/autumn.service";
import {
  RESEARCH_BILLING_ENDPOINT,
  computeResearchCredits,
} from "./research-proxy";
import type { RequestWithAuth } from "../v1/types";

// The research proxy only reads `costModel` off the endpoint config when
// computing credits, so a partial cast keeps these fixtures focused.
const flatEndpoint = { costModel: "flat" } as any;
const perResultEndpoint = { costModel: "perResult" } as any;

function reqWithFlags(flags?: Record<string, unknown>) {
  return { acuc: flags ? { flags } : undefined } as unknown as RequestWithAuth<
    any,
    any,
    any
  >;
}

describe("research proxy billing", () => {
  it("bills every /search/research endpoint against the search-credits pool", () => {
    // All research endpoints share this billing endpoint, and it must resolve
    // to SEARCH_CREDITS so search credits pay for the special search endpoints.
    expect(featureIdForBillingEndpoint(RESEARCH_BILLING_ENDPOINT)).toBe(
      SEARCH_CREDITS_FEATURE_ID,
    );
    expect(featureIdForBillingEndpoint(RESEARCH_BILLING_ENDPOINT)).not.toBe(
      CREDITS_FEATURE_ID,
    );
  });

  it("charges a flat scrape-like credit for read/inspect endpoints", () => {
    // The flat cost model is independent of any returned results.
    expect(computeResearchCredits(flatEndpoint, {}, reqWithFlags())).toBe(1);
    expect(
      computeResearchCredits(
        flatEndpoint,
        { results: [1, 2, 3, 4, 5] },
        reqWithFlags(),
      ),
    ).toBe(1);
  });

  it("scales per-result endpoints by returned result count", () => {
    const body = { results: new Array(11).fill({}) };
    // ceil(11 / 10) * 2 = 4
    expect(computeResearchCredits(perResultEndpoint, body, reqWithFlags())).toBe(
      4,
    );
    // No results → no charge.
    expect(
      computeResearchCredits(perResultEndpoint, { results: [] }, reqWithFlags()),
    ).toBe(0);
  });

  it("applies the ZDR search-credit rate for forced-zdr teams", () => {
    const body = { results: new Array(11).fill({}) };
    // ceil(11 / 10) * 10 = 20
    expect(
      computeResearchCredits(
        perResultEndpoint,
        body,
        reqWithFlags({ searchZDR: "forced-zdr" }),
      ),
    ).toBe(20);
  });
});
