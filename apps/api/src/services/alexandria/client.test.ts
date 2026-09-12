const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  config: {
    FIRE_EXCHANGE_URL: "https://exchange.test",
    EXCHANGE_INTERNAL_SECRET: "secret",
  },
}));
vi.mock("../../config", () => ({ config: mocks.config }));
vi.mock("undici", () => ({ Agent: class {}, fetch: mocks.fetch }));
import { exchangeRequest } from "./client";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.FIRE_EXCHANGE_URL = "https://exchange.test";
  mocks.config.EXCHANGE_INTERNAL_SECRET = "secret";
  mocks.fetch.mockResolvedValue({
    status: 200,
    body: (async function* () {
      yield Buffer.from('{"success":true}');
    })(),
  });
});
it("forwards the authenticated team and execution budget without the internal secret", async () => {
  await exchangeRequest({
    teamId: "team",
    path: "/v1/retrieve",
    body: {},
    requestId: "request",
    maximumCredits: 5,
    timeoutMs: 1000,
  });
  expect(mocks.fetch).toHaveBeenCalledWith(
    "https://exchange.test/v1/retrieve",
    expect.objectContaining({
      redirect: "manual",
      headers: expect.objectContaining({
        "x-exchange-team-id": "team",
        "x-exchange-max-credits": "5",
        "x-request-id": "request",
      }),
    }),
  );
  expect(mocks.fetch.mock.calls[0][1].headers).not.toHaveProperty(
    "x-exchange-secret",
  );
});
it("sends the internal secret only on explicit billing calls", async () => {
  await exchangeRequest({
    teamId: "team",
    path: "/v1/usage-events/billing",
    body: [],
    internal: true,
    timeoutMs: 1000,
  });
  expect(mocks.fetch.mock.calls[0][1].headers["x-exchange-secret"]).toBe(
    "secret",
  );
});
it.each(["http://exchange.test", ""])(
  "refuses unsafe or missing internal destinations",
  async url => {
    mocks.config.FIRE_EXCHANGE_URL = url;
    await expect(
      exchangeRequest({
        teamId: "team",
        path: "/v1/usage-events/billing",
        body: [],
        internal: true,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow();
    expect(mocks.fetch).not.toHaveBeenCalled();
  },
);
it("bounds streamed response bodies even without Content-Length", async () => {
  mocks.fetch.mockResolvedValue({
    status: 200,
    body: (async function* () {
      yield Buffer.alloc(5 * 1024 * 1024);
      yield Buffer.from("x");
    })(),
  });
  await expect(
    exchangeRequest({
      teamId: "team",
      path: "/v1/retrieve",
      body: {},
      timeoutMs: 1000,
    }),
  ).rejects.toThrow("too large");
});
