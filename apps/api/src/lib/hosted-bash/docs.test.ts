const ROOT = "https://docs.firecrawl.dev/llms.txt";
const SUB = "https://docs.firecrawl.dev/_llms/en/v2.txt";
const ROOT_INDEX = `- [Sub](${SUB}): more.
- [Intro](https://docs.firecrawl.dev/introduction.md): Start here.
`;
const SUB_INDEX = `- [CLI](https://docs.firecrawl.dev/sdks/cli.md): The CLI.
`;

describe("hosted bash docs mount", () => {
  let failing: Set<string>;
  let fetched: string[];

  // A fresh module per test: the page list is cached at module level.
  async function load() {
    vi.resetModules();
    return (await import("./docs.js")).docsFiles;
  }

  beforeEach(() => {
    failing = new Set();
    fetched = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(input => {
      const url = String(input);
      fetched.push(url);
      if (failing.has(url)) return Promise.reject(new Error("docs down"));
      return Promise.resolve(
        new Response(url === ROOT ? ROOT_INDEX : SUB_INDEX),
      );
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("lists pages from the root index and its English sub-indexes", async () => {
    const docsFiles = await load();
    expect(Object.keys(await docsFiles()).sort()).toEqual([
      "/docs/introduction.md",
      "/docs/llms.txt",
      "/docs/sdks/cli.md",
    ]);
  });

  it("keeps the pages it found when one sub-index fails", async () => {
    failing.add(SUB);
    const docsFiles = await load();
    expect(Object.keys(await docsFiles()).sort()).toEqual([
      "/docs/introduction.md",
      "/docs/llms.txt",
    ]);
  });

  it("starts with an empty /docs when the docs site is down, and retries later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    failing.add(ROOT);
    const docsFiles = await load();
    expect(Object.keys(await docsFiles())).toEqual(["/docs/llms.txt"]);

    // Within the retry window a command does not touch the docs site at all.
    fetched.length = 0;
    await docsFiles();
    expect(fetched).toEqual([]);

    failing.clear();
    vi.setSystemTime(Date.now() + 61_000);
    await docsFiles();
    await vi.waitFor(async () =>
      expect(Object.keys(await docsFiles())).toHaveLength(3),
    );
  });

  it("serves the last list while a later refresh fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const docsFiles = await load();
    expect(Object.keys(await docsFiles())).toHaveLength(3);

    failing.add(ROOT).add(SUB);
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    expect(Object.keys(await docsFiles())).toHaveLength(3);
    await new Promise(resolve => setImmediate(resolve));
    expect(Object.keys(await docsFiles())).toHaveLength(3);
  });
});
