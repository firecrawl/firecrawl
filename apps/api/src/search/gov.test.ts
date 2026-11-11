// Hoisted so a module re-imported after vi.resetModules shares them.
const shared = vi.hoisted(() => ({
  fetch: vi.fn(),
  config: {
    SEARCH_PLATFORM_URL: "https://platform.test/",
    GOV_ROUTING_ENABLED: true,
    GOV_ROUTING_DECISION_TIMEOUT_MS: 100,
  },
  rootLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("undici", () => ({
  Agent: class {},
  fetch: shared.fetch,
}));

vi.mock("../config", () => ({ config: shared.config }));

vi.mock("../lib/logger", () => ({ logger: shared.rootLogger }));

import {
  searchGovCategory,
  type searchGovIfRouted as routedSearch,
} from "./gov";

const fetchMock = shared.fetch;
const config = shared.config;

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

function upstreamOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as any;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("searchGovCategory", () => {
  it("sends the query, the result count and the team", async () => {
    fetchMock.mockResolvedValue(
      upstreamOk({ success: true, data: { web: [] } }),
    );

    await searchGovCategory(
      {
        query: "food labeling rules",
        limit: 7,
        teamId: "t1",
        timeout: 500,
        zeroDataRetention: false,
      },
      logger,
    );

    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(url).toBe("https://platform.test/api/v1/gov-search");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      query: "food labeling rules",
      top_k: 7,
    });
    expect(init.headers["firecrawl-team-id"]).toBe("t1");
    expect(init.headers["firecrawl-zero-data-retention"]).toBe("false");
  });

  it("tells the upstream that a zero data retention search must not be kept", async () => {
    fetchMock.mockResolvedValue(
      upstreamOk({ success: true, data: { web: [] } }),
    );

    await searchGovCategory(
      {
        query: "private query",
        limit: 3,
        teamId: "t1",
        timeout: 500,
        zeroDataRetention: true,
      },
      logger,
    );

    const [, init] = fetchMock.mock.calls[0] as any[];
    expect(init.headers["firecrawl-zero-data-retention"]).toBe("true");
  });

  it("maps results to the exact web schema and tags the category", async () => {
    fetchMock.mockResolvedValue(
      upstreamOk({
        success: true,
        data: {
          web: [
            {
              url: "https://www.ecfr.gov/current/title-21/part-101",
              title: "21 CFR Part 101",
              description: "Food labeling",
              position: 42,
              score: 0.9,
            },
            { url: "", title: "dropped", description: "", position: 43 },
            {
              url: "https://www.ecfr.gov/current/title-21/part-102",
              title: "  ",
              position: 44,
            },
          ],
        },
      }),
    );

    const results = await searchGovCategory(
      {
        query: "food labeling",
        limit: 5,
        teamId: "t1",
        timeout: 500,
        zeroDataRetention: false,
      },
      logger,
    );

    expect(results).toStrictEqual([
      {
        url: "https://www.ecfr.gov/current/title-21/part-101",
        title: "21 CFR Part 101",
        description: "Food labeling",
        position: 1,
        category: "gov",
      },
      {
        url: "https://www.ecfr.gov/current/title-21/part-102",
        title: "https://www.ecfr.gov/current/title-21/part-102",
        description: "",
        position: 3,
        category: "gov",
      },
    ]);
  });

  it("returns no results and drains the body when the upstream fails", async () => {
    const cancel = vi.fn(async () => {});
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      body: { cancel },
    } as any);

    await expect(
      searchGovCategory(
        {
          query: "zoning",
          limit: 5,
          teamId: "t1",
          timeout: 500,
          zeroDataRetention: false,
        },
        logger,
      ),
    ).resolves.toEqual([]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("returns no results when the upstream throws", async () => {
    fetchMock.mockRejectedValue(new Error("connection reset"));

    await expect(
      searchGovCategory(
        {
          query: "zoning",
          limit: 5,
          teamId: "t1",
          timeout: 500,
          zeroDataRetention: false,
        },
        logger,
      ),
    ).resolves.toEqual([]);
  });
});

describe("searchGovIfRouted", () => {
  const search = {
    query: "fmla leave eligibility",
    limit: 1,
    teamId: "t1",
    timeout: 500,
    zeroDataRetention: false,
  };
  const vertical = (fields: Record<string, unknown>) =>
    upstreamOk({
      results: [
        {
          vertical: fields,
        },
      ],
    });
  const routedToGov = () =>
    vertical({ search_category_routed: ["GOVERNMENT"] });
  const govHit = upstreamOk({
    success: true,
    data: {
      web: [
        {
          url: "https://www.dol.gov/agencies/whd/fmla",
          title: "FMLA",
          description: "Family and Medical Leave Act",
        },
      ],
    },
  });
  const unavailable = () =>
    ({ ok: false, status: 503, body: { cancel: async () => {} } }) as any;
  const routingLines = () =>
    shared.rootLogger.info.mock.calls
      .filter(([message]) => message === "Search gov routing")
      .map(([, fields]) => fields);
  const outcomes = () => routingLines().map(line => line.outcome);

  // Routing pauses after repeated failures, and that state lives in the module,
  // so every test routes through a fresh copy of it.
  let searchGovIfRouted: typeof routedSearch;
  beforeEach(async () => {
    vi.resetModules();
    ({ searchGovIfRouted } = await import("./gov.js"));
  });

  afterEach(() => {
    config.GOV_ROUTING_ENABLED = true;
    vi.useRealTimers();
    fetchMock.mockReset();
  });

  it("serves the search platform's web search when it routes the query to GOVERNMENT", async () => {
    fetchMock
      .mockResolvedValueOnce(routedToGov())
      .mockResolvedValueOnce(govHit);

    const results = await searchGovIfRouted(search, "s1", logger);

    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(url).toBe("https://platform.test/api/v1/query-features");
    expect(JSON.parse(init.body)).toEqual({
      queries: ["fmla leave eligibility"],
      features: ["vertical"],
    });
    expect(init.headers["firecrawl-zero-data-retention"]).toBe("false");
    const [webUrl, webInit] = fetchMock.mock.calls[1] as any[];
    expect(webUrl).toBe("https://platform.test/api/v1/web-search");
    expect(JSON.parse(webInit.body)).toEqual({
      query: "fmla leave eligibility",
      top_k: 2,
    });
    expect(results).toEqual([
      {
        url: "https://www.dol.gov/agencies/whd/fmla",
        title: "FMLA",
        description: "Family and Medical Leave Act",
        position: 1,
      },
    ]);
  });

  it("logs one shape-only routing line per search, joinable to the search by its id", async () => {
    fetchMock
      .mockResolvedValueOnce(routedToGov())
      .mockResolvedValueOnce(govHit);

    await searchGovIfRouted(search, "s1", logger);

    expect(routingLines()).toEqual([
      {
        event: "search_gov_routing",
        searchId: "s1",
        teamId: "t1",
        outcome: "routed_served",
        limit: 1,
        decisionMs: expect.any(Number),
        webSearchMs: expect.any(Number),
        results: 1,
      },
    ]);
    expect(JSON.stringify(routingLines())).not.toContain("fmla");
  });

  it("keeps a query the search platform does not route on the web", async () => {
    fetchMock.mockResolvedValueOnce(vertical({ search_category_routed: [] }));

    await expect(searchGovIfRouted(search, "s1", logger)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcomes()).toEqual(["not_routed"]);
  });

  it.each([
    ["answers 503", unavailable()],
    ["answers without search_category_routed", vertical({})],
    [
      "answers search_category_routed as a string",
      vertical({ search_category_routed: "GOVERNMENT" }),
    ],
    [
      "answers search_category_routed with a non-string entry",
      vertical({ search_category_routed: ["GOVERNMENT", 1] }),
    ],
    ["answers without results", upstreamOk({})],
  ])(
    "keeps the query on the web when the routing decision %s",
    async (_case, response) => {
      fetchMock.mockResolvedValueOnce(response as any);

      await expect(searchGovIfRouted(search, "s1", logger)).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(outcomes()).toEqual(["decision_failed"]);
    },
  );

  it("keeps the query on the web when the routing decision throws", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout"));

    await expect(searchGovIfRouted(search, "s1", logger)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcomes()).toEqual(["decision_failed"]);
  });

  it("asks nothing and logs nothing when routing is off", async () => {
    config.GOV_ROUTING_ENABLED = false;

    await expect(searchGovIfRouted(search, "s1", logger)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(routingLines()).toEqual([]);
  });

  it.each([
    [
      "answers 404",
      { ok: false, status: 404, body: { cancel: async () => {} } },
    ],
    [
      "answers a body that is not JSON",
      {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      },
    ],
    ["answers without data.web", upstreamOk({ success: true })],
  ])(
    "falls back to the regular web search when the search platform's web search %s",
    async (_case, response) => {
      fetchMock
        .mockResolvedValueOnce(routedToGov())
        .mockResolvedValueOnce(response as any);

      await expect(searchGovIfRouted(search, "s1", logger)).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(outcomes()).toEqual(["routed_failed"]);
    },
  );

  it("falls back to the regular web search when a routed query finds nothing", async () => {
    fetchMock
      .mockResolvedValueOnce(routedToGov())
      .mockResolvedValueOnce(upstreamOk({ success: true, data: { web: [] } }));

    await expect(searchGovIfRouted(search, "s1", logger)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcomes()).toEqual(["routed_empty"]);
  });

  /**
   * The regular web search serves a page shorter than asked as it is, so a routed answer
   * must too instead of running a second search.
   */
  it("serves a routed answer that holds fewer results than asked", async () => {
    fetchMock
      .mockResolvedValueOnce(routedToGov())
      .mockResolvedValueOnce(govHit);

    const results = await searchGovIfRouted(
      { ...search, limit: 2 },
      "s1",
      logger,
    );

    expect(results?.map(result => result.url)).toEqual([
      "https://www.dol.gov/agencies/whd/fmla",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(routingLines()[0]).toMatchObject({
      outcome: "routed_served",
      results: 1,
      limit: 2,
    });
  });

  /**
   * Safe search and threat protection run on routed results later and can
   * remove some, so a routed search keeps up to twice the page, as the regular
   * web search does, and the page is cut to size after filtering.
   */
  it("keeps up to twice the page from a routed answer", async () => {
    const hit = (n: number) => ({
      url: `https://www.dol.gov/${n}`,
      title: `Page ${n}`,
      description: "",
    });
    fetchMock
      .mockResolvedValueOnce(routedToGov())
      .mockResolvedValueOnce(
        upstreamOk({ success: true, data: { web: [hit(1), hit(2), hit(3)] } }),
      );

    const results = await searchGovIfRouted(search, "s1", logger);

    expect(results?.map(result => result.url)).toEqual([
      "https://www.dol.gov/1",
      "https://www.dol.gov/2",
    ]);
  });

  /**
   * While the search platform is down, every routed search would wait out its
   * timeout before the regular web search. After five failed decisions in a
   * row the process stops asking for a minute, so searches go straight to the
   * regular web search, and asks again once the minute is up.
   */
  it("pauses routing for a minute after five failed decisions in a row", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));

    for (let attempt = 0; attempt < 6; attempt++) {
      await expect(searchGovIfRouted(search, "s1", logger)).resolves.toBeNull();
    }

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(outcomes()).toEqual([...Array(5).fill("decision_failed"), "paused"]);
    expect(shared.rootLogger.warn).toHaveBeenCalledWith(
      "Gov routing paused after repeated search platform failures",
      expect.objectContaining({ call: "decision" }),
    );

    vi.setSystemTime(Date.now() + 60_001);
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(vertical({ search_category_routed: [] }));
    await searchGovIfRouted(search, "s1", logger);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcomes().at(-1)).toBe("not_routed");
  });

  /**
   * A decision that answers must not clear the web search's failures:
   * otherwise a web search that is down would never reach five failures in a
   * row while decisions keep answering, and routed searches would keep
   * waiting on it.
   */
  it.each([
    ["answer 503", unavailable],
    ["answer 200 without data.web", () => upstreamOk({ success: true })],
  ])(
    "pauses on five web searches in a row that %s, whatever the decisions between them",
    async (_case, broken) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        fetchMock
          .mockResolvedValueOnce(vertical({ search_category_routed: [] }))
          .mockResolvedValueOnce(routedToGov())
          .mockResolvedValueOnce(broken());
        await searchGovIfRouted(search, "s1", logger);
        await searchGovIfRouted(search, "s1", logger);
      }
      const asked = fetchMock.mock.calls.length;

      await expect(searchGovIfRouted(search, "s1", logger)).resolves.toBeNull();

      expect(fetchMock).toHaveBeenCalledTimes(asked);
      expect(outcomes().at(-1)).toBe("paused");
      expect(shared.rootLogger.warn).toHaveBeenCalledWith(
        "Gov routing paused after repeated search platform failures",
        expect.objectContaining({ call: "webSearch" }),
      );
    },
  );

  it("starts the failure count over after the platform answers", async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      fetchMock.mockRejectedValueOnce(new Error("timeout"));
      await searchGovIfRouted(search, "s1", logger);
    }
    fetchMock.mockResolvedValueOnce(vertical({ search_category_routed: [] }));
    await searchGovIfRouted(search, "s1", logger);
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    await searchGovIfRouted(search, "s1", logger);

    expect(outcomes()).not.toContain("paused");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  /**
   * The pause is shared by every team on the process, so a caller must not be
   * able to trip it: a refused query says nothing about the platform's health.
   */
  it("does not pause on queries the search platform refuses", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        body: { cancel: async () => {} },
      } as any);
      await searchGovIfRouted(search, "s1", logger);
    }
    fetchMock.mockResolvedValueOnce(vertical({ search_category_routed: [] }));

    await searchGovIfRouted(search, "s1", logger);

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(outcomes()).toEqual([
      ...Array(5).fill("decision_failed"),
      "not_routed",
    ]);
  });

  /**
   * A routed search may take at most half the time left in the request, so the
   * regular web search keeps time to run when the route fails. A timeout set by
   * that deadline comes from the caller's own short `timeout`, so it must not
   * count toward the pause; a timeout at the routed search's own limit does.
   */
  it.each([
    ["the request's own deadline", 500, "not_routed"],
    ["the routed search's own limit", 60_000, "paused"],
  ])(
    "on five routed searches in a row timed out by %s (timeout %i), the next search is %s",
    async (_case, timeout, next) => {
      const timedOut = () =>
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        );
      for (let attempt = 0; attempt < 5; attempt++) {
        fetchMock
          .mockResolvedValueOnce(routedToGov())
          .mockRejectedValueOnce(timedOut());
        await searchGovIfRouted({ ...search, timeout }, "s1", logger);
      }
      fetchMock.mockResolvedValueOnce(vertical({ search_category_routed: [] }));

      await searchGovIfRouted({ ...search, timeout }, "s1", logger);

      expect(outcomes()).toEqual([...Array(5).fill("routed_failed"), next]);
    },
  );

  it("starts no routed search for a decision that was in flight when routing paused", async () => {
    let answerDecision!: (response: unknown) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          answerDecision = resolve;
        }),
    );
    const inFlight = searchGovIfRouted(search, "s0", logger);
    for (let attempt = 0; attempt < 5; attempt++) {
      fetchMock.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
      await searchGovIfRouted(search, "s1", logger);
    }

    answerDecision(routedToGov());

    await expect(inFlight).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(outcomes()).toEqual([...Array(5).fill("decision_failed"), "paused"]);
  });
});
