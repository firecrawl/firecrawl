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
