const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  billingCountry: vi.fn(async (): Promise<string | undefined> => undefined),
}));
vi.mock("./client", () => ({ exchangeRequest: mocks.request }));
vi.mock("../../lib/billing-country", () => ({
  billingCountryForTeam: mocks.billingCountry,
}));
import { acceptProviderTerms, hasLedgerAcceptance } from "./terms";

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

it.each([
  [true, false],
  [false, true],
])(
  "records explicit acceptance with universal requirement %s and Exchange override %s",
  async (required, exchangeRequired) => {
    mocks.request
      .mockResolvedValueOnce({
        status: 200,
        body: {
          providers: [
            {
              provider: "shopify",
              required,
              exchangeRequired,
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
  },
);

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

const peopleDataLabs = {
  ...input,
  clientIp: "203.0.113.7",
  billingCountry: "DE",
  body: { ...input.body, provider: "peopledatalabs" },
};

it("accepts country-scoped terms when the caller's location makes them required", async () => {
  mocks.request
    .mockResolvedValueOnce({
      status: 200,
      body: {
        providers: [
          {
            provider: "peopledatalabs",
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

  expect((await acceptProviderTerms(peopleDataLabs)).status).toBe(200);
  expect(mocks.request).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      path: "/v1/provider-terms/requirements",
      clientIp: "203.0.113.7",
      billingCountry: "DE",
    }),
  );
  expect(mocks.request).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      path: "/v1/provider-terms/events",
      clientIp: "203.0.113.7",
      billingCountry: "DE",
    }),
  );
});

it("rejects acceptance when the caller's country requires no agreement", async () => {
  mocks.request.mockResolvedValueOnce({
    status: 200,
    body: {
      providers: [
        {
          provider: "peopledatalabs",
          required: false,
          exchangeRequired: false,
          terms: null,
        },
      ],
    },
  });

  const response = await acceptProviderTerms({
    ...peopleDataLabs,
    clientIp: "198.51.100.8",
    billingCountry: "US",
  });
  expect(response.status).toBe(400);
  expect(response.body).toMatchObject({
    error: "peopledatalabs requires no agreement.",
  });
  expect(mocks.request).toHaveBeenCalledTimes(1);
  expect(mocks.request).toHaveBeenCalledWith(
    expect.objectContaining({
      path: "/v1/provider-terms/requirements",
      clientIp: "198.51.100.8",
      billingCountry: "US",
    }),
  );
});

const statusPath = "/v1/provider-terms/status?organizationId=org";

function ledgerExchange(requirements: {
  required: boolean;
  terms: typeof terms | null;
}) {
  return async ({ path }: { path: string }) => {
    if (path === "/v1/provider-terms/requirements") {
      return {
        status: 200,
        body: {
          providers: [{ provider: "peopledatalabs", ...requirements }],
        },
      };
    }
    if (path === statusPath) {
      return {
        status: 200,
        body: {
          providers: [
            {
              provider: "peopledatalabs",
              revoked: false,
              version: terms.version,
              textHash: terms.digest,
              acceptedAt: "2026-10-08T12:00:00Z",
            },
          ],
        },
      };
    }
    throw new Error(`unexpected Exchange path ${path}`);
  };
}

it("reads the ledger for the caller's country", async () => {
  mocks.request.mockImplementation(ledgerExchange({ required: true, terms }));

  await expect(
    hasLedgerAcceptance({
      teamId: "team",
      orgId: "org",
      provider: "peopledatalabs",
      timeoutMs: 1000,
      clientIp: "203.0.113.7",
      billingCountry: "DE",
    }),
  ).resolves.toBe(true);
  expect(mocks.request).toHaveBeenCalledWith(
    expect.objectContaining({
      path: "/v1/provider-terms/requirements",
      clientIp: "203.0.113.7",
      billingCountry: "DE",
    }),
  );
  expect(mocks.request).toHaveBeenCalledWith(
    expect.objectContaining({
      path: statusPath,
      clientIp: "203.0.113.7",
      billingCountry: "DE",
    }),
  );
});

it("resolves the team's billing country when the caller does not pass one", async () => {
  mocks.billingCountry.mockResolvedValueOnce("DE");
  mocks.request.mockImplementation(ledgerExchange({ required: true, terms }));

  await expect(
    hasLedgerAcceptance({
      teamId: "team",
      orgId: "org",
      provider: "peopledatalabs",
      timeoutMs: 1000,
      clientIp: "203.0.113.7",
    }),
  ).resolves.toBe(true);
  expect(mocks.billingCountry).toHaveBeenCalledWith("team");
  expect(mocks.request).toHaveBeenCalledWith(
    expect.objectContaining({
      path: "/v1/provider-terms/requirements",
      clientIp: "203.0.113.7",
      billingCountry: "DE",
    }),
  );
  expect(mocks.request).toHaveBeenCalledWith(
    expect.objectContaining({
      path: statusPath,
      clientIp: "203.0.113.7",
      billingCountry: "DE",
    }),
  );
});

it("does not treat missing country-scoped terms as accepted", async () => {
  mocks.request.mockImplementation(
    ledgerExchange({ required: false, terms: null }),
  );

  await expect(
    hasLedgerAcceptance({
      teamId: "team",
      orgId: "org",
      provider: "peopledatalabs",
      timeoutMs: 1000,
      clientIp: "198.51.100.8",
      billingCountry: "US",
    }),
  ).resolves.toBe(false);
  expect(mocks.request).toHaveBeenCalledWith(
    expect.objectContaining({
      path: statusPath,
      clientIp: "198.51.100.8",
      billingCountry: "US",
    }),
  );
});
