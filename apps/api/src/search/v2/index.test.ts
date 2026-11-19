const mocks = vi.hoisted(() => ({ attemptRequest: vi.fn() }));

vi.mock("../../lib/retry-utils", () => ({
  attemptRequest: mocks.attemptRequest,
  executeWithRetry: async (attempt: () => Promise<unknown>) => attempt(),
}));
vi.mock("../../scraper/scrapeURL/engines/fire-engine/available", () => ({
  useFireEngine: true,
}));

import { config } from "../../config";
import { search } from "./index";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

const originalFireEngineUrl = config.FIRE_ENGINE_BETA_URL;

beforeEach(() => {
  vi.clearAllMocks();
  config.FIRE_ENGINE_BETA_URL = "http://fire-engine.test";
  mocks.attemptRequest.mockResolvedValue({ web: [] });
});

afterEach(() => {
  config.FIRE_ENGINE_BETA_URL = originalFireEngineUrl;
});

const sentBody = () => JSON.parse(mocks.attemptRequest.mock.calls[0][1]);

describe("the team plan class on the fire engine search call", () => {
  it.each(["free", "self_serve", "contract"] as const)(
    "sends %s when the caller states it",
    async teamPlanClass => {
      await search({ query: "retries", logger, teamPlanClass });

      expect(mocks.attemptRequest).toHaveBeenCalledTimes(1);
      expect(mocks.attemptRequest.mock.calls[0][0]).toBe(
        "http://fire-engine.test/v2/search",
      );
      expect(sentBody()).toMatchObject({ query: "retries", teamPlanClass });
    },
  );

  it("sends no plan class when the caller states none", async () => {
    await search({ query: "retries", logger });

    expect(mocks.attemptRequest).toHaveBeenCalledTimes(1);
    expect(sentBody()).not.toHaveProperty("teamPlanClass");
  });
});
