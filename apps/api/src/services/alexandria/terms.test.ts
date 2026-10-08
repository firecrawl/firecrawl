const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./client", () => ({ exchangeRequest: mocks.request }));
import { acceptProviderTerms } from "./terms";

const terms = { key: "shopify", version: "2026-01", digest: "a".repeat(64) };
const input = {
  teamId: "team",
  orgId: "org",
  apiKeyId: "key",
  body: {
    provider: "shopify",
    version: terms.version,
    digest: terms.digest,
    confirmed: true as const,
  },
};

beforeEach(() => vi.resetAllMocks());

it("records explicit acceptance when Exchange terms are optional but universal scrape requires them", async () => {
  mocks.request
    .mockResolvedValueOnce({
      status: 200,
      body: {
        providers: [
          {
            provider: "shopify",
            required: true,
            exchangeRequired: false,
            terms,
          },
        ],
      },
    })
    .mockResolvedValueOnce({
      status: 201,
      body: { id: "event", occurred_at: "2026-10-08T12:00:00Z" },
    });
  expect((await acceptProviderTerms(input)).status).toBe(200);
  expect(mocks.request).toHaveBeenLastCalledWith(
    expect.objectContaining({
      path: "/v1/provider-terms/events",
      body: expect.objectContaining({
        event_type: "accepted",
        version: terms.version,
        text_hash: terms.digest,
      }),
    }),
  );
});

it("still rejects stale explicit acceptance when Exchange terms are optional", async () => {
  mocks.request.mockResolvedValueOnce({
    status: 200,
    body: {
      providers: [
        { provider: "shopify", required: true, exchangeRequired: false, terms },
      ],
    },
  });
  expect(
    (
      await acceptProviderTerms({
        ...input,
        body: { ...input.body, version: "old" },
      })
    ).status,
  ).toBe(409);
  expect(mocks.request).toHaveBeenCalledTimes(1);
});
