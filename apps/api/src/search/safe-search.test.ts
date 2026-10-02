const mocks = vi.hoisted(() => ({
  systemOne: vi.fn(),
  config: { TYPESAFE_API_KEY: "test-key" as string | undefined },
}));

vi.mock("@typesafe-ai/sdk", async importOriginal => ({
  ...(await importOriginal<typeof import("@typesafe-ai/sdk")>()),
  TypeSafeClient: class {
    systemOne = mocks.systemOne;
  },
}));
vi.mock("../config", () => ({ config: mocks.config }));

import { removeExplicitResults } from "./safe-search";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

const web = (name: string) => ({
  url: `https://${name}.example/`,
  title: name,
  description: `${name} snippet`,
});

function judgeByUrl(explicitHosts: string[]) {
  mocks.systemOne.mockImplementation(async ({ state }) => {
    const url: string = state.result.url ?? "";
    const explicit = explicitHosts.some(host => url.includes(`//${host}.`));
    return {
      answers: { explicit: { type: "noul", noul: explicit ? 0.9 : 0.1 } },
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.TYPESAFE_API_KEY = "test-key";
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("drops results Jev judges explicit and backfills from the surplus", async () => {
  judgeByUrl(["nsfw1", "nsfw2"]);
  const response = {
    web: [
      web("safe1"),
      web("nsfw1"),
      web("safe2"),
      web("nsfw2"),
      web("safe3"),
      web("safe4"),
    ],
  };

  await removeExplicitResults(response, 3, logger);

  expect(response.web.map(result => result.title)).toEqual([
    "safe1",
    "safe2",
    "safe3",
  ]);
  // Three judged first, then two to replace nsfw1 and nsfw2; safe4 is never needed.
  expect(mocks.systemOne).toHaveBeenCalledTimes(5);
  expect(mocks.systemOne).toHaveBeenCalledWith(
    expect.objectContaining({
      state: {
        result: {
          title: "safe1",
          snippet: "safe1 snippet",
          url: "https://safe1.example/",
        },
      },
    }),
    {
      signal: expect.any(AbortSignal),
      timeout: 2000,
      retry: { maxRetries: 1 },
    },
  );
});

it("caps how many results are judged at once", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  mocks.systemOne.mockImplementation(async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 1));
    inFlight--;
    return { answers: { explicit: { type: "noul", noul: 0.1 } } };
  });
  const response = {
    web: Array.from({ length: 50 }, (_, index) => web(`safe${index}`)),
  };

  await removeExplicitResults(response, 50, logger);

  expect(response.web).toHaveLength(50);
  expect(mocks.systemOne).toHaveBeenCalledTimes(50);
  expect(maxInFlight).toBe(20);
});

it("filters news and images alongside web", async () => {
  judgeByUrl(["nsfw"]);
  const response = {
    news: [
      { title: "News", url: "https://news.example/a", snippet: "ok" },
      { title: "Bad", url: "https://nsfw.example/b", snippet: "bad" },
    ],
    images: [
      {
        title: "Bad",
        url: "https://nsfw.example/c",
        imageUrl: "https://cdn.example/c.jpg",
      },
      {
        title: "Photo",
        url: "https://photos.example/d",
        imageUrl: "https://cdn.example/d.jpg",
      },
    ],
  };

  await removeExplicitResults(response, 5, logger);

  expect(response.news.map(result => result.title)).toEqual(["News"]);
  expect(response.images.map(result => result.title)).toEqual(["Photo"]);
  expect(response).not.toHaveProperty("web");
});

it("keeps results Jev fails to judge", async () => {
  mocks.systemOne.mockRejectedValue(new Error("upstream down"));
  const response = { web: [web("a"), web("b")] };

  await removeExplicitResults(response, 5, logger);

  expect(response.web.map(result => result.title)).toEqual(["a", "b"]);
  expect(logger.warn).toHaveBeenCalledWith(
    "Safe search filter kept results Jev could not judge",
    expect.objectContaining({ failed: 2 }),
  );
});

it("keeps results still pending when the filter's time budget runs out", async () => {
  const budget = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(budget.signal);
  mocks.systemOne.mockImplementation(({ state }, { signal }) =>
    state.result.url.includes("//nsfw.")
      ? Promise.resolve({
          answers: { explicit: { type: "noul", noul: 0.9 } },
        })
      : new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
  );
  const response = { web: [web("slow1"), web("nsfw"), web("slow2")] };

  const run = removeExplicitResults(response, 5, logger);
  await vi.waitFor(() => expect(mocks.systemOne).toHaveBeenCalledTimes(3));
  budget.abort();
  await run;
  expect(timeout).toHaveBeenCalledWith(5000);

  expect(response.web.map(result => result.title)).toEqual(["slow1", "slow2"]);
  expect(logger.warn).toHaveBeenCalledWith(
    "Safe search filter kept results Jev could not judge",
    expect.objectContaining({ failed: 2 }),
  );
});

it("sends Jev only the start of ultralong fields", async () => {
  judgeByUrl([]);
  const response = {
    web: [{ ...web("long"), description: "x".repeat(20_000) }],
  };

  await removeExplicitResults(response, 5, logger);

  const [{ state }] = mocks.systemOne.mock.calls[0];
  expect(state.result.snippet).toHaveLength(500);
  expect(state.result.title).toBe("long");
  expect(response.web[0].description).toHaveLength(20_000);
});

it("skips responses with nothing to judge", async () => {
  await removeExplicitResults({}, 5, logger);
  await removeExplicitResults({ web: [] }, 5, logger);

  expect(mocks.systemOne).not.toHaveBeenCalled();
  expect(logger.info).not.toHaveBeenCalled();
});

it("does nothing without a TypeSafe API key", async () => {
  mocks.config.TYPESAFE_API_KEY = undefined;
  const response = { web: [web("a")] };

  await removeExplicitResults(response, 5, logger);

  expect(mocks.systemOne).not.toHaveBeenCalled();
  expect(response.web).toHaveLength(1);
});
