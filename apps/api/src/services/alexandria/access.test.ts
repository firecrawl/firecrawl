const mocks = vi.hoisted(() => ({ request: vi.fn(), multiplier: vi.fn() }));
vi.mock("../../config", () => ({
  config: { USE_DB_AUTHENTICATION: true, FIRECRAWL_DASHBOARD_URL: "https://d" },
}));
vi.mock("./client", () => ({ exchangeRequest: mocks.request }));
vi.mock("../autumn/autumn.service", () => ({
  autumnService: { getRateLimitMultiplier: mocks.multiplier },
}));
import { authorizeProviders } from "./access";

const calls = [
  { provider: "fred", capability: "series/observations", options: {} },
];
const requirement = (required: boolean) => ({
  status: 200,
  body: {
    providers: [
      {
        provider: "fred",
        required,
        terms: { key: "fred", version: "2026-01" },
      },
    ],
  },
});

beforeEach(() => vi.clearAllMocks());

it("refuses a provider the Exchange does not know before any quote or execution", async () => {
  mocks.request.mockResolvedValue({ status: 404, body: { code: "not_found" } });
  const denied = await authorizeProviders("team", calls, {});
  expect(denied?.status).toBe(404);
  expect(denied?.body).toEqual(
    expect.objectContaining({ code: "unknown_provider" }),
  );
});

it("requires the organization to hold the current agreement when terms are required", async () => {
  mocks.request.mockResolvedValue(requirement(true));
  const stale = {
    organizationDataSourceAccess: {
      fred: { status: "enabled", termsKey: "fred", termsVersion: "2025-01" },
    },
  };
  expect((await authorizeProviders("team", calls, stale))?.status).toBe(403);
  const current = {
    organizationDataSourceAccess: {
      fred: { status: "enabled", termsKey: "fred", termsVersion: "2026-01" },
    },
  };
  expect(await authorizeProviders("team", calls, current)).toBeUndefined();
});

it("refuses a disabled provider and fails closed when agreements are unavailable", async () => {
  mocks.request.mockResolvedValue(requirement(false));
  const disabled = {
    organizationDataSourceAccess: { fred: { status: "disabled" } },
  };
  expect((await authorizeProviders("team", calls, disabled))?.status).toBe(403);
  mocks.request.mockResolvedValue({ status: 503, body: "down" });
  expect((await authorizeProviders("team", calls, {}))?.status).toBe(503);
});

it("allows a current agreement accepted after owner revocation, then blocks a later revocation", async () => {
  const terms = { ...requirement(true) };
  Object.assign(terms.body.providers[0].terms, { digest: "a".repeat(64) });
  const access = {
    status: "disabled",
    disabledReason: "revoked_by_organization_admin",
    disabledAt: "2026-09-20T12:00:00Z",
    termsKey: "fred",
    termsVersion: "2026-01",
  };
  const flags = { organizationDataSourceAccess: { fred: access } };
  let acceptance = {
    provider: "fred",
    revoked: false,
    version: "2026-01",
    textHash: "a".repeat(64),
    acceptedAt: "2026-09-20T11:00:00Z",
  };
  mocks.request.mockImplementation(async ({ path }) =>
    path.includes("requirements")
      ? terms
      : { status: 200, body: { providers: [acceptance] } },
  );
  expect(
    (await authorizeProviders("team", calls, flags, "org"))?.body,
  ).toMatchObject({ code: "THIRD_PARTY_DATA_TERMS_REQUIRED" });
  acceptance = {
    ...acceptance,
    revoked: false,
    acceptedAt: "2026-09-20T12:01:00Z",
  };
  expect(await authorizeProviders("team", calls, flags, "org")).toBeUndefined();
  access.disabledAt = "2026-09-20T12:02:00Z";
  expect((await authorizeProviders("team", calls, flags, "org"))?.status).toBe(
    403,
  );
});

it.each([
  [
    "disabled",
    "revoked_by_staff",
    "2026-09-20T12:00:00Z",
    "2026-09-20T12:01:00Z",
    "2026-01",
    "a".repeat(64),
    false,
  ],
  [
    "suspended",
    "revoked_by_organization_admin",
    "2026-09-20T12:00:00Z",
    "2026-09-20T12:01:00Z",
    "2026-01",
    "a".repeat(64),
    false,
  ],
  [
    "disabled",
    "disabled_by_organization_admin",
    "2026-09-20T12:00:00Z",
    "2026-09-20T12:01:00Z",
    "2026-01",
    "a".repeat(64),
    false,
  ],
  [
    "disabled",
    "revoked_by_organization_admin",
    "",
    "2026-09-20T12:01:00Z",
    "2026-01",
    "a".repeat(64),
    false,
  ],
  [
    "disabled",
    "revoked_by_organization_admin",
    "2026-09-20T12:00:00Z",
    "",
    "2026-01",
    "a".repeat(64),
    false,
  ],
  [
    "disabled",
    "revoked_by_organization_admin",
    "2026-09-20T12:00:00Z",
    "2026-09-20T12:00:00Z",
    "2026-01",
    "a".repeat(64),
    false,
  ],
  [
    "disabled",
    "revoked_by_organization_admin",
    "2026-09-20T12:00:00Z",
    "2026-09-20T12:01:00Z",
    "old",
    "a".repeat(64),
    false,
  ],
  [
    "disabled",
    "revoked_by_organization_admin",
    "2026-09-20T12:00:00Z",
    "2026-09-20T12:01:00Z",
    "2026-01",
    "b".repeat(64),
    false,
  ],
  [
    "disabled",
    "revoked_by_organization_admin",
    "2026-09-20T12:00:00Z",
    "2026-09-20T12:01:00Z",
    "2026-01",
    "a".repeat(64),
    true,
  ],
])(
  "does not reopen access for %s / %s / %s / %s / %s / %s / revoked=%s",
  async (
    status,
    disabledReason,
    disabledAt,
    acceptedAt,
    version,
    textHash,
    revoked,
  ) => {
    const terms = requirement(true);
    Object.assign(terms.body.providers[0].terms, { digest: "a".repeat(64) });
    mocks.request.mockImplementation(async ({ path }) =>
      path.includes("requirements")
        ? terms
        : {
            status: 200,
            body: {
              providers: [
                { provider: "fred", revoked, version, textHash, acceptedAt },
              ],
            },
          },
    );
    const denied = await authorizeProviders(
      "team",
      calls,
      {
        organizationDataSourceAccess: {
          fred: { status, disabledReason, disabledAt },
        },
      },
      "org",
    );
    expect(denied?.status).toBe(403);
    if (
      status === "disabled" &&
      disabledReason === "revoked_by_organization_admin"
    )
      expect(denied?.body).toMatchObject({
        code: "THIRD_PARTY_DATA_TERMS_REQUIRED",
      });
    else {
      expect(denied?.body).toMatchObject({
        success: false,
        error: "Access to fred is disabled for this organization.",
      });
      expect(denied?.body).not.toHaveProperty(
        "code",
        "THIRD_PARTY_DATA_TERMS_REQUIRED",
      );
    }
  },
);

it.each([
  "0",
  "2026-02-30T12:00:00Z",
  "2026-09-20",
  "2026-09-20T12:00:00",
  1789905600000,
  null,
])(
  "fails closed for invalid revocation or acceptance timestamp %s",
  async bad => {
    const terms = requirement(true);
    Object.assign(terms.body.providers[0].terms, { digest: "a".repeat(64) });
    for (const side of ["revocation", "acceptance"]) {
      mocks.request.mockImplementation(async ({ path }) =>
        path.includes("requirements")
          ? terms
          : {
              status: 200,
              body: {
                providers: [
                  {
                    provider: "fred",
                    revoked: false,
                    version: "2026-01",
                    textHash: "a".repeat(64),
                    acceptedAt:
                      side === "acceptance" ? bad : "2026-09-20T12:01:00Z",
                  },
                ],
              },
            },
      );
      const result = await authorizeProviders(
        "team",
        calls,
        {
          organizationDataSourceAccess: {
            fred: {
              status: "disabled",
              disabledReason: "revoked_by_organization_admin",
              disabledAt: (side === "revocation"
                ? bad
                : "2026-09-20T12:00:00Z") as string,
            },
          },
        },
        "org",
      );
      expect(result?.body, side).toMatchObject({
        code: "THIRD_PARTY_DATA_TERMS_REQUIRED",
      });
    }
  },
);

it("does not discard other acceptances when a timestamp has an unexpected shape", async () => {
  const terms = requirement(true);
  Object.assign(terms.body.providers[0].terms, { digest: "a".repeat(64) });
  mocks.request.mockImplementation(async ({ path }) =>
    path.includes("requirements")
      ? terms
      : {
          status: 200,
          body: {
            providers: [
              {
                provider: "other",
                revoked: false,
                version: "v1",
                textHash: "b".repeat(64),
                acceptedAt: { invalid: true },
              },
              {
                provider: "fred",
                revoked: false,
                version: "2026-01",
                textHash: "a".repeat(64),
                acceptedAt: "2026-09-20T12:01:00Z",
              },
            ],
          },
        },
  );
  expect(await authorizeProviders("team", calls, {}, "org")).toBeUndefined();
});

describe("paid-plan-only capabilities", () => {
  const enabled = {
    organizationDataSourceAccess: {
      benzinga: {
        status: "enabled",
        termsKey: "benzinga",
        termsVersion: "C-1",
      },
    },
  };
  const wiim = [
    { provider: "benzinga", capability: "news/wiims", options: {} },
  ];
  const pressReleases = [
    { provider: "benzinga", capability: "news/press-releases", options: {} },
  ];
  const requirements = (paidPlanOnlyCapabilities?: string[]) => ({
    status: 200,
    body: {
      providers: [
        {
          provider: "benzinga",
          required: true,
          terms: { key: "benzinga", version: "C-1" },
          ...(paidPlanOnlyCapabilities ? { paidPlanOnlyCapabilities } : {}),
        },
      ],
    },
  });

  it("refuses a free-plan team calling a paid-plan-only capability, before any quote", async () => {
    mocks.request.mockResolvedValue(
      requirements(["news/wiims", "news/search"]),
    );
    mocks.multiplier.mockResolvedValue(1);
    const denied = await authorizeProviders("team", wiim, enabled, "org");
    expect(denied?.status).toBe(403);
    expect(denied?.body).toEqual(
      expect.objectContaining({ code: "paid_plan_required" }),
    );
    expect(String((denied?.body as { error: string }).error)).toContain(
      "benzinga/news/wiims",
    );
    expect(mocks.multiplier).toHaveBeenCalledWith("team", "org");
  });

  it("admits a paid-plan team, and does not consult the plan for an ungated capability", async () => {
    mocks.request.mockResolvedValue(requirements(["news/wiims"]));
    mocks.multiplier.mockResolvedValue(10);
    expect(
      await authorizeProviders("team", wiim, enabled, "org"),
    ).toBeUndefined();
    mocks.multiplier.mockClear();
    mocks.multiplier.mockResolvedValue(1);
    expect(
      await authorizeProviders("team", pressReleases, enabled, "org"),
    ).toBeUndefined();
    expect(mocks.multiplier).not.toHaveBeenCalled();
  });

  it("lets a team that bypasses credit checks through, and treats a missing field as ungated", async () => {
    mocks.request.mockResolvedValue(requirements(["news/wiims"]));
    mocks.multiplier.mockResolvedValue(1);
    expect(
      await authorizeProviders(
        "team",
        wiim,
        { ...enabled, bypassCreditChecks: true },
        "org",
      ),
    ).toBeUndefined();
    // An Exchange deployed before it published the field: nothing to gate on.
    mocks.request.mockResolvedValue(requirements());
    expect(
      await authorizeProviders("team", wiim, enabled, "org"),
    ).toBeUndefined();
  });

  it("still requires the agreement first: an unaccepted paid team is refused on terms, not plan", async () => {
    mocks.request.mockResolvedValue(requirements(["news/wiims"]));
    mocks.multiplier.mockResolvedValue(10);
    const denied = await authorizeProviders("team", wiim, {}, null);
    expect(denied?.status).toBe(403);
    expect(denied?.body).not.toEqual(
      expect.objectContaining({ code: "paid_plan_required" }),
    );
  });
});
