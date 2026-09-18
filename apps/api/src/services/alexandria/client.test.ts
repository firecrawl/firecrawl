const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../config", () => ({
  config: { FIRE_EXCHANGE_URL: "https://exchange.test" },
}));
vi.mock("undici", () => ({ Agent: class {}, fetch: mocks.fetch }));
import { exchangeRequest } from "./client";
it("sends optional result authorization as a header, never in the body", async () => {
  mocks.fetch.mockImplementation(async () => ({
    status: 200,
    body: (async function* () {
      yield Buffer.from("{}");
    })(),
  }));
  await exchangeRequest({
    teamId: "team",
    path: "/v1/retrieve",
    timeoutMs: 1000,
    body: { requests: [] },
    resultAuthorization: "Bearer caller-secret",
  });
  const options = mocks.fetch.mock.calls[0][1];
  expect(options.headers.authorization).toBe("Bearer caller-secret");
  expect(options.redirect).toBe("manual");
  expect(options.body).not.toContain("caller-secret");
  await exchangeRequest({
    teamId: "team",
    path: "/v1/retrieve",
    timeoutMs: 1000,
  });
  expect(mocks.fetch.mock.calls[1][1].headers.authorization).toBeUndefined();
});
