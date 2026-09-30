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

  await removeExplicitResults(response, "creator platforms", 3, logger);

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
        search_query: "creator platforms",
        result: {
          title: "safe1",
          snippet: "safe1 snippet",
          url: "https://safe1.example/",
        },
      },
    }),
  );
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

  await removeExplicitResults(response, "query", 5, logger);

  expect(response.news.map(result => result.title)).toEqual(["News"]);
  expect(response.images.map(result => result.title)).toEqual(["Photo"]);
  expect(response).not.toHaveProperty("web");
});

it("keeps results Jev fails to judge", async () => {
  mocks.systemOne.mockRejectedValue(new Error("upstream down"));
  const response = { web: [web("a"), web("b")] };

  await removeExplicitResults(response, "query", 5, logger);

  expect(response.web.map(result => result.title)).toEqual(["a", "b"]);
  expect(logger.warn).toHaveBeenCalledWith(
    "Safe search filter kept results Jev could not judge",
    expect.objectContaining({ failed: 2 }),
  );
});

it("does nothing without a TypeSafe API key", async () => {
  mocks.config.TYPESAFE_API_KEY = undefined;
  const response = { web: [web("a")] };

  await removeExplicitResults(response, "query", 5, logger);

  expect(mocks.systemOne).not.toHaveBeenCalled();
  expect(response.web).toHaveLength(1);
});
