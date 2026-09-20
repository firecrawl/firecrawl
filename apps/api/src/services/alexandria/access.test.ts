const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../config", () => ({
  config: { USE_DB_AUTHENTICATION: true, FIRECRAWL_DASHBOARD_URL: "https://d" },
}));
vi.mock("./client", () => ({ exchangeRequest: mocks.request }));
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
    revoked: true,
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
    expect(
      (
        await authorizeProviders(
          "team",
          calls,
          {
            organizationDataSourceAccess: {
              fred: { status, disabledReason, disabledAt },
            },
          },
          "org",
        )
      )?.status,
    ).toBe(403);
  },
);
