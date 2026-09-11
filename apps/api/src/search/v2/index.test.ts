import { vi } from "vitest";

// vi.mock is hoisted, so everything its factories reference must come from
// vi.hoisted().
const mocks = vi.hoisted(() => ({
  config: { FIRE_ENGINE_BETA_URL: "", SEARXNG_ENDPOINT: "" } as {
    FIRE_ENGINE_BETA_URL: string;
    SEARXNG_ENDPOINT: string;
  },
  fireEngine: vi.fn(),
  searxng: vi.fn(),
  ddg: vi.fn(),
}));

vi.mock("../../config", () => ({ config: mocks.config }));
vi.mock("./fireEngine-v2", () => ({
  fire_engine_search_v2: mocks.fireEngine,
}));
vi.mock("./searxng", () => ({ searxng_search: mocks.searxng }));
vi.mock("./ddgsearch", () => ({ ddgSearch: mocks.ddg }));

import { searchWithOutcome } from "./index";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

const oneResult = {
  web: [
    {
      url: "https://example.com",
      title: "Example",
      description: "",
      position: 1,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.FIRE_ENGINE_BETA_URL = "";
  mocks.config.SEARXNG_ENDPOINT = "";
});

describe("searchWithOutcome served/failed outcome", () => {
  it("reports failure when fire engine fails on every attempt", async () => {
    mocks.config.FIRE_ENGINE_BETA_URL = "http://fire-engine";
    mocks.fireEngine.mockResolvedValue(null);

    const outcome = await searchWithOutcome({ query: "anything", logger });

    expect(outcome).toEqual({ response: {}, succeeded: false });
  });

  it("reports success when fire engine serves a no-match", async () => {
    mocks.config.FIRE_ENGINE_BETA_URL = "http://fire-engine";
    mocks.fireEngine.mockResolvedValue({});

    const outcome = await searchWithOutcome({ query: "anything", logger });

    expect(outcome).toEqual({ response: {}, succeeded: true });
  });

  it("keeps a searxng no-match billable when DuckDuckGo then fails", async () => {
    mocks.config.SEARXNG_ENDPOINT = "http://searxng";
    mocks.searxng.mockResolvedValue({});
    mocks.ddg.mockRejectedValue(new Error("DDG is down"));

    const outcome = await searchWithOutcome({ query: "anything", logger });

    // searxng served the query, so the empty answer is a real no-match.
    expect(mocks.ddg).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ response: {}, succeeded: true });
  });

  it("reports failure when searxng fails and DuckDuckGo fails", async () => {
    mocks.config.SEARXNG_ENDPOINT = "http://searxng";
    mocks.searxng.mockResolvedValue(null);
    mocks.ddg.mockRejectedValue(new Error("DDG is down"));

    const outcome = await searchWithOutcome({ query: "anything", logger });

    expect(outcome).toEqual({ response: {}, succeeded: false });
  });

  it("reports failure when DuckDuckGo is the only provider and it fails", async () => {
    mocks.ddg.mockRejectedValue(new Error("DDG is down"));

    const outcome = await searchWithOutcome({ query: "anything", logger });

    expect(outcome).toEqual({ response: {}, succeeded: false });
  });

  it("still falls through to DuckDuckGo when searxng finds nothing", async () => {
    mocks.config.SEARXNG_ENDPOINT = "http://searxng";
    mocks.searxng.mockResolvedValue({});
    mocks.ddg.mockResolvedValue(oneResult);

    const outcome = await searchWithOutcome({ query: "anything", logger });

    expect(mocks.ddg).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ response: oneResult, succeeded: true });
  });

  it("reports success when every provider serves a no-match", async () => {
    mocks.config.SEARXNG_ENDPOINT = "http://searxng";
    mocks.searxng.mockResolvedValue({});
    mocks.ddg.mockResolvedValue({});

    const outcome = await searchWithOutcome({ query: "anything", logger });

    expect(outcome).toEqual({ response: {}, succeeded: true });
  });
});
