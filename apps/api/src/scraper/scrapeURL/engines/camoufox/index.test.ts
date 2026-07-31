import { config } from "../../../../config";
import { createAntibotFallbackState } from "../../lib/antibot";
import { EngineError } from "../../error";
import type { Meta } from "../..";

// vi.hoisted so the mock factory below (which is hoisted above the imports)
// can reach the spy without a temporal-dead-zone error.
const { robustFetchMock } = vi.hoisted(() => ({ robustFetchMock: vi.fn() }));

vi.mock("../../lib/fetch", () => ({
  robustFetch: (...args: unknown[]) => robustFetchMock(...args),
}));
vi.mock("@mendable/firecrawl-rs", () => ({
  getInnerJson: async (x: string) => x,
}));

import {
  isCamoufoxConfigured,
  isDomainAllowedForCamoufox,
  scrapeURLWithCamoufox,
} from "./index";

type ConfigSnapshot = Pick<
  typeof config,
  | "CAMOUFOX_FALLBACK_ENABLED"
  | "CAMOUFOX_SERVICE_URL"
  | "CAMOUFOX_MIN_CONFIDENCE"
  | "CAMOUFOX_DOMAIN_ALLOWLIST"
  | "CAMOUFOX_DOMAIN_DENYLIST"
  | "CAMOUFOX_TIMEOUT_MS"
>;

let snapshot: ConfigSnapshot;

beforeEach(() => {
  snapshot = {
    CAMOUFOX_FALLBACK_ENABLED: config.CAMOUFOX_FALLBACK_ENABLED,
    CAMOUFOX_SERVICE_URL: config.CAMOUFOX_SERVICE_URL,
    CAMOUFOX_MIN_CONFIDENCE: config.CAMOUFOX_MIN_CONFIDENCE,
    CAMOUFOX_DOMAIN_ALLOWLIST: config.CAMOUFOX_DOMAIN_ALLOWLIST,
    CAMOUFOX_DOMAIN_DENYLIST: config.CAMOUFOX_DOMAIN_DENYLIST,
    CAMOUFOX_TIMEOUT_MS: config.CAMOUFOX_TIMEOUT_MS,
  };
  config.CAMOUFOX_FALLBACK_ENABLED = true;
  config.CAMOUFOX_SERVICE_URL = "http://camoufox-service:3000/scrape";
  config.CAMOUFOX_MIN_CONFIDENCE = "suspected";
  config.CAMOUFOX_DOMAIN_ALLOWLIST = undefined;
  config.CAMOUFOX_DOMAIN_DENYLIST = undefined;
  config.CAMOUFOX_TIMEOUT_MS = 60000;
  robustFetchMock.mockReset();
});

afterEach(() => {
  Object.assign(config, snapshot);
});

function makeMeta(url = "https://academic.oup.com/jcr/article/1"): Meta {
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  };
  return {
    url,
    logger,
    options: { waitFor: 0, headers: undefined, skipTlsVerification: false },
    abort: {
      scrapeTimeout: () => 150000,
      asSignal: () => new AbortController().signal,
    },
    mock: null,
    antibot: createAntibotFallbackState(),
  } as unknown as Meta;
}

/** The detection a Cloudflare-challenged 403 would have produced. */
function confirmedBlock() {
  return {
    confidence: "confirmed" as const,
    failureClass: "antibot_challenge:cloudflare",
    vendor: "cloudflare",
    statusCode: 403,
  };
}

describe("isCamoufoxConfigured", () => {
  it("is false unless both the flag and the URL are set", () => {
    config.CAMOUFOX_FALLBACK_ENABLED = false;
    expect(isCamoufoxConfigured()).toBe(false);

    config.CAMOUFOX_FALLBACK_ENABLED = true;
    config.CAMOUFOX_SERVICE_URL = "";
    expect(isCamoufoxConfigured()).toBe(false);

    config.CAMOUFOX_SERVICE_URL = "http://camoufox-service:3000/scrape";
    expect(isCamoufoxConfigured()).toBe(true);
  });
});

describe("isDomainAllowedForCamoufox", () => {
  it("allows everything when no lists are configured", () => {
    expect(isDomainAllowedForCamoufox("academic.oup.com")).toBe(true);
  });

  it("restricts to the allowlist, including subdomains", () => {
    config.CAMOUFOX_DOMAIN_ALLOWLIST = ["oup.com", "mdpi.com"];
    expect(isDomainAllowedForCamoufox("academic.oup.com")).toBe(true);
    expect(isDomainAllowedForCamoufox("oup.com")).toBe(true);
    expect(isDomainAllowedForCamoufox("www.mdpi.com")).toBe(true);
    expect(isDomainAllowedForCamoufox("example.com")).toBe(false);
    // Suffix matching must not match a lookalike registrable domain.
    expect(isDomainAllowedForCamoufox("notoup.com")).toBe(false);
  });

  it("lets the denylist win over the allowlist", () => {
    config.CAMOUFOX_DOMAIN_ALLOWLIST = ["oup.com"];
    config.CAMOUFOX_DOMAIN_DENYLIST = ["academic.oup.com"];
    expect(isDomainAllowedForCamoufox("academic.oup.com")).toBe(false);
    expect(isDomainAllowedForCamoufox("other.oup.com")).toBe(true);
  });
});

describe("scrapeURLWithCamoufox gating", () => {
  it("runs once after a confirmed anti-bot block", async () => {
    robustFetchMock.mockResolvedValue({
      content: "<html><body>real article</body></html>",
      pageStatusCode: 200,
    });

    const meta = makeMeta();
    meta.antibot.detection = confirmedBlock();

    const result = await scrapeURLWithCamoufox(meta);

    expect(robustFetchMock).toHaveBeenCalledTimes(1);
    expect(result.statusCode).toBe(200);
    expect(result.proxyUsed).toBe("stealth");
    expect(meta.antibot.camoufoxAttempts).toBe(1);
    expect(meta.antibot.camoufoxOutcome).toBe("success");
  });

  it("declines a second time within the same job", async () => {
    robustFetchMock.mockResolvedValue({
      content: "<html></html>",
      pageStatusCode: 200,
    });

    const meta = makeMeta();
    meta.antibot.detection = confirmedBlock();

    await scrapeURLWithCamoufox(meta);
    await expect(scrapeURLWithCamoufox(meta)).rejects.toThrow(EngineError);

    // The second call must not reach the service.
    expect(robustFetchMock).toHaveBeenCalledTimes(1);
    expect(meta.antibot.camoufoxAttempts).toBe(1);
    expect(meta.antibot.camoufoxOutcome).toBe("skipped_already_attempted");
  });

  it("declines when nothing recorded an anti-bot block", async () => {
    const meta = makeMeta();
    await expect(scrapeURLWithCamoufox(meta)).rejects.toThrow(EngineError);
    expect(robustFetchMock).not.toHaveBeenCalled();
    expect(meta.antibot.camoufoxOutcome).toBe("skipped_not_applicable");
  });

  it.each([
    ["404 not found", 404],
    ["410 gone", 410],
    ["401 unauthorized", 401],
    ["500 server error", 500],
    ["200 ordinary parse failure", 200],
  ])("declines for %s", async (_label, statusCode) => {
    const meta = makeMeta();
    meta.antibot.detection = {
      confidence: statusCode === 200 ? "none" : "suspected",
      failureClass: `http_${statusCode}`,
      statusCode,
    };

    await expect(scrapeURLWithCamoufox(meta)).rejects.toThrow(EngineError);
    expect(robustFetchMock).not.toHaveBeenCalled();
    expect(meta.antibot.camoufoxAttempts).toBe(0);
  });

  it("declines a suspected block when the minimum confidence is 'confirmed'", async () => {
    config.CAMOUFOX_MIN_CONFIDENCE = "confirmed";
    const meta = makeMeta();
    meta.antibot.detection = {
      confidence: "suspected",
      failureClass: "http_403_blocked",
      statusCode: 403,
    };

    await expect(scrapeURLWithCamoufox(meta)).rejects.toThrow(EngineError);
    expect(robustFetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["RFC1918 host", "http://192.168.0.107:3002/"],
    ["loopback", "http://127.0.0.1:3002/v2/scrape"],
    ["IPv6 loopback", "http://[::1]/"],
  ])(
    "never retries a literal private address (%s) even if it 403s",
    async (_label, url) => {
      // Our own SSRF controls surface a blocked target as HTTP 403, which by
      // status alone looks exactly like an anti-bot block.
      const meta = makeMeta(url);
      meta.antibot.detection = {
        confidence: "suspected",
        failureClass: "http_403_blocked",
        statusCode: 403,
      };

      await expect(scrapeURLWithCamoufox(meta)).rejects.toThrow(EngineError);
      expect(robustFetchMock).not.toHaveBeenCalled();
      expect(meta.antibot.camoufoxAttempts).toBe(0);
    },
  );

  it("declines a denylisted host", async () => {
    config.CAMOUFOX_DOMAIN_DENYLIST = ["oup.com"];
    const meta = makeMeta();
    meta.antibot.detection = confirmedBlock();

    await expect(scrapeURLWithCamoufox(meta)).rejects.toThrow(EngineError);
    expect(robustFetchMock).not.toHaveBeenCalled();
    expect(meta.antibot.camoufoxOutcome).toBe("skipped_domain_filter");
  });

  it("declines when the fallback is disabled", async () => {
    config.CAMOUFOX_FALLBACK_ENABLED = false;
    const meta = makeMeta();
    meta.antibot.detection = confirmedBlock();

    await expect(scrapeURLWithCamoufox(meta)).rejects.toThrow(EngineError);
    expect(robustFetchMock).not.toHaveBeenCalled();
  });

  it("waterfalls rather than failing the scrape when the service is unreachable", async () => {
    robustFetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const meta = makeMeta();
    meta.antibot.detection = confirmedBlock();

    // EngineError is what makes the loop try the next engine instead of
    // aborting the job.
    await expect(scrapeURLWithCamoufox(meta)).rejects.toThrow(EngineError);
    expect(meta.antibot.camoufoxOutcome).toBe("service_unavailable");
    expect(meta.antibot.camoufoxAttempts).toBe(1);
  });

  it("records a non-2xx stealth result as a failure but still returns it", async () => {
    robustFetchMock.mockResolvedValue({
      content: "<html>still blocked</html>",
      pageStatusCode: 403,
      pageError: "Forbidden",
    });
    const meta = makeMeta();
    meta.antibot.detection = confirmedBlock();

    const result = await scrapeURLWithCamoufox(meta);
    expect(result.statusCode).toBe(403);
    expect(meta.antibot.camoufoxOutcome).toBe("failure");
  });

  it("caps the service timeout at the remaining scrape budget", async () => {
    config.CAMOUFOX_TIMEOUT_MS = 60000;
    robustFetchMock.mockResolvedValue({
      content: "<html></html>",
      pageStatusCode: 200,
    });

    const meta = makeMeta();
    meta.abort.scrapeTimeout = () => 10000;
    meta.antibot.detection = confirmedBlock();

    await scrapeURLWithCamoufox(meta);
    expect(robustFetchMock.mock.calls[0][0].body.timeout).toBe(10000);
  });
});
