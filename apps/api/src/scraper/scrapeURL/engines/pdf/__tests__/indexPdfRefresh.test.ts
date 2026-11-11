vi.mock("../../../../../services", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../../../services")>()),
  useIndex: true,
}));

import { config } from "../../../../../config";
import { buildFallbackList, shouldUseIndex } from "../../index";
import { AgentIndexOnlyError } from "../../../error";

type MutableConfig = {
  FIRECRAWL_INDEX_WRITE_ONLY?: boolean;
  INDEX_SKIP_ON_PDF_REFRESH: boolean;
};

function metaWith(parsers: unknown) {
  return {
    internalOptions: { isParse: false },
    featureFlags: new Set(),
    options: {
      formats: ["markdown"],
      maxAge: 60_000,
      storeInCache: true,
      parsers,
    },
  } as any;
}

describe("URL index and PDF refresh", () => {
  const mutable = config as unknown as MutableConfig;
  let originalWriteOnly: boolean | undefined;
  let originalSkip: boolean;

  beforeEach(() => {
    originalWriteOnly = mutable.FIRECRAWL_INDEX_WRITE_ONLY;
    originalSkip = mutable.INDEX_SKIP_ON_PDF_REFRESH;
    mutable.FIRECRAWL_INDEX_WRITE_ONLY = false;
  });

  afterEach(() => {
    mutable.FIRECRAWL_INDEX_WRITE_ONLY = originalWriteOnly;
    mutable.INDEX_SKIP_ON_PDF_REFRESH = originalSkip;
  });

  it("keeps reading the index for a refresh while the flag is off", () => {
    mutable.INDEX_SKIP_ON_PDF_REFRESH = false;
    expect(shouldUseIndex(metaWith([{ type: "pdf", refresh: true }]))).toBe(
      true,
    );
  });

  it("skips the index for a refresh when the flag is on", () => {
    mutable.INDEX_SKIP_ON_PDF_REFRESH = true;
    expect(shouldUseIndex(metaWith([{ type: "pdf", refresh: true }]))).toBe(
      false,
    );
  });

  it.each([
    ["no parsers", undefined],
    ["pdf parser without refresh", [{ type: "pdf" }]],
    ["refresh false", [{ type: "pdf", refresh: false }]],
  ])("keeps reading the index with the flag on for %s", (_name, parsers) => {
    mutable.INDEX_SKIP_ON_PDF_REFRESH = true;
    expect(shouldUseIndex(metaWith(parsers))).toBe(true);
  });
});

describe("agentIndexOnly and PDF refresh", () => {
  const mutable = config as unknown as MutableConfig;
  let originalSkip: boolean;

  beforeEach(() => {
    originalSkip = mutable.INDEX_SKIP_ON_PDF_REFRESH;
  });

  afterEach(() => {
    mutable.INDEX_SKIP_ON_PDF_REFRESH = originalSkip;
  });

  function agentMeta(parsers: unknown) {
    return {
      id: "agent-refresh",
      url: "https://example.com/doc.pdf",
      options: { formats: ["markdown"], maxAge: 60_000, parsers },
      internalOptions: { teamId: "team-1", agentIndexOnly: true },
      featureFlags: new Set(),
      mock: null,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        child: vi.fn().mockReturnThis(),
      },
    } as any;
  }

  it("refuses an index-only refresh when the flag is on", async () => {
    mutable.INDEX_SKIP_ON_PDF_REFRESH = true;
    await expect(
      buildFallbackList(agentMeta([{ type: "pdf", refresh: true }])),
    ).rejects.toBeInstanceOf(AgentIndexOnlyError);
  });

  it("keeps index-only refresh requests on the index while the flag is off", async () => {
    mutable.INDEX_SKIP_ON_PDF_REFRESH = false;
    const list = await buildFallbackList(
      agentMeta([{ type: "pdf", refresh: true }]),
    );
    expect(list.length).toBeGreaterThan(0);
    expect(list.every(x => x.engine.startsWith("index"))).toBe(true);
  });
});
