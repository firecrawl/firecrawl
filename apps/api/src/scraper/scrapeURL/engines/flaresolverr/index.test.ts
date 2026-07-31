import { config } from "../../../../config";
import { createAntibotFallbackState } from "../../lib/antibot";
import { EngineError } from "../../error";
import type { Meta } from "../..";

// vi.hoisted so the mock factory below (which is hoisted above the imports)
// can reach the spy without a temporal-dead-zone error.
const { robustFetchMock, axiosGetMock } = vi.hoisted(() => ({
  robustFetchMock: vi.fn(),
  axiosGetMock: vi.fn(),
}));

vi.mock("../../lib/fetch", () => ({
  robustFetch: (...args: unknown[]) => robustFetchMock(...args),
}));

vi.mock("axios", () => ({
  default: {
    get: (...args: unknown[]) => axiosGetMock(...args),
  },
}));

import {
  isDomainAllowedForFlaresolverr,
  isFlaresolverrConfigured,
  scrapeURLWithFlaresolverr,
} from "./index";

// Bodies below are trimmed from responses FlareSolverr actually returned for
// these hosts, so the "solver lied about success" tests exercise real evidence.
// FlareSolverr reported `"Challenge not detected!"` with HTTP 200 for both.
const AWS_WAF_INTERSTITIAL = `<html><head><script src="https://de5282c3ca0c.ca-central-1.token.awswaf.com/de5282c3ca0c/f321f3b23f09/challenge.js"></script></head><body><div id="challenge-container"></div><script>window.awsWafCookieDomainList = []; AwsWafIntegration.saveReferrer();</script></body></html>`;

const JSTOR_ACCESS_CHECK = `<html><head><title>JSTOR: Access Check</title><style>.px-captcha-error-container{position:fixed;height:328px}</style><script src="https://www.gstatic.com/recaptcha/releases/A7KpaEASfhDcK0nXxgQEyyYv/recaptcha__en.js"></script></head><body><h2>Access Check</h2><p>Our systems have detected unusual traffic activity from your network.</p></body></html>`;

const REAL_ARTICLE = `<!DOCTYPE html><html lang="en"><head><title>A beginner's guide to belief revision</title></head><body><article>${"<p>Real article body copy that runs on for a while. </p>".repeat(300)}</article></body></html>`;

type ConfigSnapshot = Pick<
  typeof config,
  | "FLARESOLVERR_ENABLED"
  | "FLARESOLVERR_URL"
  | "FLARESOLVERR_MIN_CONFIDENCE"
  | "FLARESOLVERR_DOMAIN_ALLOWLIST"
  | "FLARESOLVERR_DOMAIN_DENYLIST"
  | "FLARESOLVERR_TIMEOUT_MS"
  | "FLARESOLVERR_MAX_RESPONSE_BYTES"
>;

let snapshot: ConfigSnapshot;

beforeEach(() => {
  snapshot = {
    FLARESOLVERR_ENABLED: config.FLARESOLVERR_ENABLED,
    FLARESOLVERR_URL: config.FLARESOLVERR_URL,
    FLARESOLVERR_MIN_CONFIDENCE: config.FLARESOLVERR_MIN_CONFIDENCE,
    FLARESOLVERR_DOMAIN_ALLOWLIST: config.FLARESOLVERR_DOMAIN_ALLOWLIST,
    FLARESOLVERR_DOMAIN_DENYLIST: config.FLARESOLVERR_DOMAIN_DENYLIST,
    FLARESOLVERR_TIMEOUT_MS: config.FLARESOLVERR_TIMEOUT_MS,
    FLARESOLVERR_MAX_RESPONSE_BYTES: config.FLARESOLVERR_MAX_RESPONSE_BYTES,
  };
  config.FLARESOLVERR_ENABLED = true;
  config.FLARESOLVERR_URL = "http://flaresolverr:8191/v1";
  config.FLARESOLVERR_MIN_CONFIDENCE = "confirmed";
  config.FLARESOLVERR_DOMAIN_ALLOWLIST = undefined;
  config.FLARESOLVERR_DOMAIN_DENYLIST = undefined;
  config.FLARESOLVERR_TIMEOUT_MS = 120000;
  config.FLARESOLVERR_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  robustFetchMock.mockReset();
  axiosGetMock.mockReset();
  axiosGetMock.mockResolvedValue({ data: { status: "ok" } });
});

afterEach(() => {
  Object.assign(config, snapshot);
});

function makeMeta(url = "https://www.researchgate.net/publication/24293777"): Meta {
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
      scrapeTimeout: () => 300000,
      asSignal: () => new AbortController().signal,
    },
    mock: null,
    antibot: createAntibotFallbackState(),
  } as unknown as Meta;
}

/** The detection a DataDome-challenged 403 would have produced. */
function confirmedBlock(statusCode = 403) {
  return {
    confidence: "confirmed" as const,
    failureClass: "antibot_challenge:datadome",
    vendor: "datadome",
    statusCode,
  };
}

function solved(html: string, status = 200) {
  return {
    status: "ok",
    message: "Challenge solved!",
    solution: { url: "https://www.researchgate.net/publication/24293777", status, response: html },
  };
}

describe("isFlaresolverrConfigured", () => {
  it("is false unless both the flag and the URL are set", () => {
    config.FLARESOLVERR_ENABLED = false;
    expect(isFlaresolverrConfigured()).toBe(false);

    config.FLARESOLVERR_ENABLED = true;
    config.FLARESOLVERR_URL = "";
    expect(isFlaresolverrConfigured()).toBe(false);

    config.FLARESOLVERR_URL = "http://flaresolverr:8191/v1";
    expect(isFlaresolverrConfigured()).toBe(true);
  });
});

describe("isDomainAllowedForFlaresolverr", () => {
  it("allows everything when no lists are configured", () => {
    expect(isDomainAllowedForFlaresolverr("www.researchgate.net")).toBe(true);
  });

  it("restricts to the allowlist, including subdomains", () => {
    config.FLARESOLVERR_DOMAIN_ALLOWLIST = ["researchgate.net", "mdpi.com"];
    expect(isDomainAllowedForFlaresolverr("www.researchgate.net")).toBe(true);
    expect(isDomainAllowedForFlaresolverr("researchgate.net")).toBe(true);
    expect(isDomainAllowedForFlaresolverr("example.com")).toBe(false);
  });

  it("lets the denylist win over the allowlist", () => {
    config.FLARESOLVERR_DOMAIN_ALLOWLIST = ["researchgate.net"];
    config.FLARESOLVERR_DOMAIN_DENYLIST = ["www.researchgate.net"];
    expect(isDomainAllowedForFlaresolverr("www.researchgate.net")).toBe(false);
  });
});

describe("scrapeURLWithFlaresolverr declines", () => {
  it("when the fallback is not configured", async () => {
    config.FLARESOLVERR_ENABLED = false;
    const meta = makeMeta();
    await expect(scrapeURLWithFlaresolverr(meta)).rejects.toThrow(EngineError);
    expect(meta.antibot.flaresolverrOutcome).toBe("skipped_not_applicable");
    expect(robustFetchMock).not.toHaveBeenCalled();
  });

  it("when no anti-bot evidence was recorded", async () => {
    const meta = makeMeta();
    await expect(scrapeURLWithFlaresolverr(meta)).rejects.toThrow(EngineError);
    expect(meta.antibot.flaresolverrOutcome).toBe("skipped_not_applicable");
    expect(robustFetchMock).not.toHaveBeenCalled();
  });

  it("only once per scrape job", async () => {
    const meta = makeMeta();
    meta.antibot.detection = confirmedBlock();
    meta.antibot.flaresolverrAttempts = 1;
    await expect(scrapeURLWithFlaresolverr(meta)).rejects.toThrow(EngineError);
    expect(meta.antibot.flaresolverrOutcome).toBe("skipped_already_attempted");
    expect(robustFetchMock).not.toHaveBeenCalled();
  });

  it("on a status a solver cannot turn around", async () => {
    const meta = makeMeta();
    meta.antibot.detection = { ...confirmedBlock(), statusCode: 404 };
    await expect(scrapeURLWithFlaresolverr(meta)).rejects.toThrow(EngineError);
    expect(meta.antibot.flaresolverrOutcome).toBe("skipped_not_applicable");
    expect(robustFetchMock).not.toHaveBeenCalled();
  });

  it("on a merely suspected block when `confirmed` is required", async () => {
    const meta = makeMeta();
    meta.antibot.detection = {
      confidence: "suspected",
      failureClass: "http_403_blocked",
      statusCode: 403,
    };
    await expect(scrapeURLWithFlaresolverr(meta)).rejects.toThrow(EngineError);
    expect(meta.antibot.flaresolverrOutcome).toBe("skipped_not_applicable");
    expect(robustFetchMock).not.toHaveBeenCalled();
  });

  it("on a literal private address, before spending a request", async () => {
    const meta = makeMeta("http://127.0.0.1:8080/admin");
    meta.antibot.detection = confirmedBlock();
    await expect(scrapeURLWithFlaresolverr(meta)).rejects.toThrow(EngineError);
    expect(meta.antibot.flaresolverrOutcome).toBe("skipped_not_applicable");
    expect(robustFetchMock).not.toHaveBeenCalled();
  });

  it("on a denylisted host", async () => {
    config.FLARESOLVERR_DOMAIN_DENYLIST = ["researchgate.net"];
    const meta = makeMeta();
    meta.antibot.detection = confirmedBlock();
    await expect(scrapeURLWithFlaresolverr(meta)).rejects.toThrow(EngineError);
    expect(meta.antibot.flaresolverrOutcome).toBe("skipped_domain_filter");
    expect(robustFetchMock).not.toHaveBeenCalled();
  });
});

describe("scrapeURLWithFlaresolverr accepts a real solve", () => {
  it("returns the solved document", async () => {
    robustFetchMock.mockResolvedValue(solved(REAL_ARTICLE));
    const meta = makeMeta();
    meta.antibot.detection = confirmedBlock();

    const result = await scrapeURLWithFlaresolverr(meta);

    expect(result.statusCode).toBe(200);
    expect(result.html).toBe(REAL_ARTICLE);
    expect(result.proxyUsed).toBe("stealth");
    expect(meta.antibot.flaresolverrOutcome).toBe("success");
    expect(meta.antibot.flaresolverrAttempts).toBe(1);
  });

  it("is reachable for an AWS WAF challenge served under HTTP 202", async () => {
    robustFetchMock.mockResolvedValue(solved(REAL_ARTICLE));
    const meta = makeMeta("https://ieeexplore.ieee.org/document/9298885");
    // ieeexplore really does answer 202 for its AWS WAF interstitial. An exact
    // `=== 200` gate silently skipped it and the waterfall ran out of engines.
    meta.antibot.detection = confirmedBlock(202);

    const result = await scrapeURLWithFlaresolverr(meta);

    expect(result.html).toBe(REAL_ARTICLE);
    expect(meta.antibot.flaresolverrOutcome).toBe("success");
  });

  it("is reachable for an interstitial served under HTTP 200", async () => {
    robustFetchMock.mockResolvedValue(solved(REAL_ARTICLE));
    const meta = makeMeta();
    // The PMC-shaped case: challenge fingerprint, ordinary 200 status. Camoufox
    // declines this (403/429 only); FlareSolverr must not.
    meta.antibot.detection = confirmedBlock(200);

    const result = await scrapeURLWithFlaresolverr(meta);

    expect(result.html).toBe(REAL_ARTICLE);
    expect(meta.antibot.flaresolverrOutcome).toBe("success");
  });
});

describe("scrapeURLWithFlaresolverr does not trust the solver's own verdict", () => {
  // FlareSolverr only fingerprints Cloudflare, so it reports success on other
  // vendors' interstitials. Passing those through would recreate the exact
  // "challenge page marked successful" bug this work exists to fix.
  it("rejects an AWS WAF interstitial reported as solved", async () => {
    robustFetchMock.mockResolvedValue({
      status: "ok",
      message: "Challenge not detected!",
      solution: { status: 200, response: AWS_WAF_INTERSTITIAL },
    });
    const meta = makeMeta("https://ieeexplore.ieee.org/document/9298885");
    meta.antibot.detection = confirmedBlock();

    await expect(scrapeURLWithFlaresolverr(meta)).rejects.toThrow(EngineError);
    expect(meta.antibot.flaresolverrOutcome).toBe("challenge_not_cleared");
    expect(meta.antibot.flaresolverrDetail).toContain("awswaf");
  });

  it("rejects a JSTOR access check reported as solved", async () => {
    robustFetchMock.mockResolvedValue({
      status: "ok",
      message: "Challenge not detected!",
      solution: { status: 200, response: JSTOR_ACCESS_CHECK },
    });
    const meta = makeMeta("https://www.jstor.org/stable/2025464");
    meta.antibot.detection = confirmedBlock();

    await expect(scrapeURLWithFlaresolverr(meta)).rejects.toThrow(EngineError);
    expect(meta.antibot.flaresolverrOutcome).toBe("challenge_not_cleared");
  });
});

describe("scrapeURLWithFlaresolverr failure handling", () => {
  it("degrades to an EngineError when the service is unreachable", async () => {
    robustFetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const meta = makeMeta();
    meta.antibot.detection = confirmedBlock();

    await expect(scrapeURLWithFlaresolverr(meta)).rejects.toThrow(EngineError);
    expect(meta.antibot.flaresolverrOutcome).toBe("service_unavailable");
  });

  it("degrades when the solver could not clear the challenge", async () => {
    // FlareSolverr answers HTTP 500 for a solve timeout, which robustFetch
    // surfaces as a rejection; a non-ok envelope is the other shape.
    robustFetchMock.mockResolvedValue({
      status: "error",
      message: "Error solving the challenge. Timeout after 120.0 seconds.",
    });
    const meta = makeMeta("https://academic.oup.com/jcr/article/15/2/139/1841428");
    meta.antibot.detection = confirmedBlock();

    await expect(scrapeURLWithFlaresolverr(meta)).rejects.toThrow(EngineError);
    expect(meta.antibot.flaresolverrOutcome).toBe("failure");
  });

  it("refuses a response larger than the configured cap", async () => {
    config.FLARESOLVERR_MAX_RESPONSE_BYTES = 1024;
    robustFetchMock.mockResolvedValue(solved(REAL_ARTICLE));
    const meta = makeMeta();
    meta.antibot.detection = confirmedBlock();

    await expect(scrapeURLWithFlaresolverr(meta)).rejects.toThrow(EngineError);
    expect(meta.antibot.flaresolverrOutcome).toBe("failure");
  });

  it("caps maxTimeout at the remaining scrape budget", async () => {
    robustFetchMock.mockResolvedValue(solved(REAL_ARTICLE));
    const meta = makeMeta();
    (meta.abort as any).scrapeTimeout = () => 5000;
    meta.antibot.detection = confirmedBlock();

    await scrapeURLWithFlaresolverr(meta);

    expect(robustFetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ cmd: "request.get", maxTimeout: 5000 }),
      }),
    );
  });
});
