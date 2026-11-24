import {
  KEYLESS_PLAN_CLASS,
  planClassOf,
  teamPlanClass,
  type TeamPlanClass,
} from "./team-plan-class";

const active = (planId: string) => ({ planId, status: "active" });
const scheduled = (planId: string) => ({ planId, status: "scheduled" });

describe("planClassOf", () => {
  it.each<[string, { planId: string; status: string }[], TeamPlanClass]>([
    ["the free plan", [active("free")], "free"],
    ["the boosted free plan", [active("free_1_5k")], "free"],
    ["the free plan with no credits", [active("free_no_credits")], "free"],
    [
      "the free plan with a pay-as-you-go add-on",
      [active("free"), active("pay_as_you_go")],
      "free",
    ],
    [
      "the free plan with a pricing-page plan only scheduled",
      [active("free"), scheduled("hobby")],
      "free",
    ],
    ["a pricing-page plan", [active("standard_monthly_130k")], "self_serve"],
    ["a legacy plan", [active("legacy_standard")], "self_serve"],
    ["an extract plan", [active("extract_pro_yearly")], "self_serve"],
    [
      "a pricing-page plan with add-ons",
      [
        active("growth"),
        active("credit_pack_1k"),
        active("concurrent_browser"),
      ],
      "self_serve",
    ],
    [
      "a pricing-page plan scheduled to drop to free",
      [active("hobby"), scheduled("free")],
      "self_serve",
    ],
    [
      "monthly Scale from the pricing page",
      [active("scale_monthly")],
      "self_serve",
    ],
    [
      "yearly Scale from the pricing page",
      [active("scale_tier_1")],
      "self_serve",
    ],
  ])("%s is %s", (_case, subscriptions, expected) => {
    expect(planClassOf(subscriptions)).toBe(expected);
  });

  it.each<[string, { planId: string; status: string }[]]>([
    ["an enterprise plan", [active("enterprise_10m")]],
    ["a Scale tier the pricing page does not sell", [active("scale_tier_9")]],
    ["a pricing-page id with a suffix", [active("scale_tier_1_custom")]],
    ["a plan id this build has never seen", [active("standard_monthly_999k")]],
    ["a known plan id in another case", [active("Hobby")]],
    [
      "a subscription with no plan id",
      [{ planId: undefined as unknown as string, status: "active" }],
    ],
    [
      "a negotiated plan that is only scheduled",
      [active("growth"), scheduled("enterprise_10m")],
    ],
    [
      "a negotiated plan in a status this build has never seen",
      [active("growth"), { planId: "enterprise_10m", status: "expired" }],
    ],
    [
      "a pricing-page plan with an add-on this build has never seen",
      [active("growth"), active("custom_add_on")],
    ],
    [
      "the free plan with an add-on this build has never seen",
      [active("free"), active("credit_pack_50k")],
    ],
  ])("%s is contract", (_case, subscriptions) => {
    expect(planClassOf(subscriptions)).toBe("contract");
  });

  it.each<[string, { planId: string; status: string }[]]>([
    ["no subscriptions", []],
    ["only an add-on", [active("credit_pack_1k")]],
    ["a pricing-page plan that is only scheduled", [scheduled("hobby")]],
    ["a free plan that is not active", [{ planId: "free", status: "expired" }]],
  ])("%s has no class", (_case, subscriptions) => {
    expect(planClassOf(subscriptions)).toBeUndefined();
  });
});

describe("teamPlanClass", () => {
  const now = Date.parse("2026-06-01T00:00:00Z");
  const chunk = (
    plan_class: TeamPlanClass | undefined,
    flags: unknown = null,
  ) => ({ plan_class, flags }) as Parameters<typeof teamPlanClass>[0];

  it.each<TeamPlanClass>(["free", "self_serve", "contract"])(
    "states %s for a team with no flags, as billing reported it",
    planClass => {
      expect(teamPlanClass(chunk(planClass), now)).toBe(planClass);
      expect(teamPlanClass(chunk(planClass, {}), now)).toBe(planClass);
    },
  );

  it("states nothing without a chunk", () => {
    expect(teamPlanClass(undefined, now)).toBeUndefined();
  });

  it("states nothing for a chunk whose plan was never read", () => {
    expect(teamPlanClass(chunk(undefined), now)).toBeUndefined();
    expect(teamPlanClass(chunk(undefined, {}), now)).toBeUndefined();
  });

  const negotiatedTerms: [string, object][] = [
    ["a signed contract", { signedContract: true }],
    ["a signed contract flag that is not a boolean", { signedContract: "yes" }],
    [
      "an enterprise pilot with no end",
      { enterprisePilot: { startDate: "2026-05-01T00:00:00Z" } },
    ],
    [
      "an enterprise pilot that ends later",
      {
        enterprisePilot: {
          startDate: "2026-05-01T00:00:00Z",
          endDate: "2026-06-01T00:00:01Z",
        },
      },
    ],
    [
      "an enterprise pilot that has not started",
      {
        enterprisePilot: {
          startDate: "2026-07-01T00:00:00Z",
          endDate: "2026-08-01T00:00:00Z",
        },
      },
    ],
    [
      "an enterprise pilot whose end cannot be read",
      {
        enterprisePilot: { startDate: "2026-05-01T00:00:00Z", endDate: "soon" },
      },
    ],
    [
      "an enterprise pilot flag that is not a date range",
      { enterprisePilot: true },
    ],
    ["search zero data retention allowed", { searchZDR: "allowed" }],
    ["search zero data retention forced", { searchZDR: "forced-zdr" }],
    ["anonymous search forced", { searchZDR: "forced-anon" }],
    ["scrape zero data retention allowed", { scrapeZDR: "allowed" }],
    ["scrape zero data retention forced", { scrapeZDR: "forced" }],
    [
      "provider tools zero data retention allowed",
      { alexandriaZDR: "allowed" },
    ],
    ["provider tools zero data retention forced", { alexandriaZDR: "forced" }],
    ["the legacy allow-ZDR flag", { allowZDR: true }],
    ["the legacy force-ZDR flag", { forceZDR: true }],
    ["US-only processing", { usOnly: true }],
    ["a restricting DPA", { dpaRestricted: true }],
    ["a training restriction", { trainingRestricted: true }],
    ["Safe Mode", { safeMode: true }],
  ];

  it.each(negotiatedTerms)(
    "states a team with %s as contract whatever it pays for",
    (_case, flags) => {
      expect(teamPlanClass(chunk("free", flags), now)).toBe("contract");
      expect(teamPlanClass(chunk("self_serve", flags), now)).toBe("contract");
      expect(teamPlanClass(chunk("contract", flags), now)).toBe("contract");
    },
  );

  it("states a team under negotiated terms as contract even when its plan was never read", () => {
    expect(teamPlanClass(chunk(undefined, { signedContract: true }), now)).toBe(
      "contract",
    );
  });

  it.each<[string, object]>([
    ["a signed contract flag set to false", { signedContract: false }],
    ["a null enterprise pilot", { enterprisePilot: null }],
    [
      "an enterprise pilot that has ended",
      {
        enterprisePilot: {
          startDate: "2026-04-01T00:00:00Z",
          endDate: "2026-05-01T00:00:00Z",
        },
      },
    ],
    [
      "an enterprise pilot that ends this instant",
      {
        enterprisePilot: {
          startDate: "2026-05-01T00:00:00Z",
          endDate: "2026-06-01T00:00:00Z",
        },
      },
    ],
    [
      "data-handling flags that are switched off",
      {
        searchZDR: "disabled",
        scrapeZDR: "disabled",
        alexandriaZDR: "disabled",
        usOnly: false,
        dpaRestricted: false,
        trainingRestricted: false,
        safeMode: false,
      },
    ],
    [
      "flags that are no negotiated term",
      { browserBeta: true, largePdfs: true },
    ],
  ])("leaves the billing class for a team with %s", (_case, flags) => {
    expect(teamPlanClass(chunk("free", flags), now)).toBe("free");
    expect(teamPlanClass(chunk("self_serve", flags), now)).toBe("self_serve");
    expect(teamPlanClass(chunk(undefined, flags), now)).toBeUndefined();
  });
});

describe("KEYLESS_PLAN_CLASS", () => {
  it("states a keyless caller as free", () => {
    expect(KEYLESS_PLAN_CLASS).toBe("free");
  });
});
