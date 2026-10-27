const PRICING_URL = "https://firecrawl.dev/pricing";
const HOBBY_CHECKOUT_URL = "https://www.firecrawl.dev/billing/checkout/hobby";

/**
 * Where an out-of-credits error sends the team: the Hobby checkout for a team
 * the ACUC says is on a free plan, else the pricing page. The web page checks
 * sign-in and eligibility itself, so the link carries only the team id.
 */
export function upgradeLink(
  teamId: string,
  acuc: { is_paid_plan?: boolean } | null | undefined,
): string {
  if (acuc?.is_paid_plan !== false) return PRICING_URL;
  return `${HOBBY_CHECKOUT_URL}?${new URLSearchParams({ team: teamId })}`;
}
