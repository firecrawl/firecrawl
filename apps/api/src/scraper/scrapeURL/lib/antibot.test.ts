import { classifyAntibotResponse, meetsConfidenceThreshold } from "./antibot";

// Bodies below are trimmed from responses actually observed against the
// self-hosted deployment, so the classifier is tested against real evidence
// rather than invented markers.
const CLOUDFLARE_CHALLENGE = `<!DOCTYPE html><html lang="en-US" dir="ltr"><head><title>Just a moment...</title><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><meta name="robots" content="noindex,nofollow"></head><body><div id="cf-wrapper"><script>window._cf_chl_opt={cvId:'3'};</script><div id="challenge-error-text">Enable JavaScript and cookies to continue</div><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script></body></html>`;

const AKAMAI_DENIED = `<html><head> <title>Access Denied</title> </head><body> <h1>Access Denied</h1> You don't have permission to access "http://www.mdpi.com/2308-3417/10/5/119" on this server.<p> Reference #18.967f3a17.1785290305.52b9950a </p><p>https://errors.edgesuite.net/18.967f3a17.1785290305.52b9950a</p> </body></html>`;

const RECAPTCHA_INTERSTITIAL = `<!DOCTYPE html><html lang="en-US"><head><script src="https://www.gstatic.com/_/mss/boq-recaptcha/_/js/k=boq-recaptcha.RecaptchaChallengePageUi.en_US.js"></script><title>Checking your browser - reCAPTCHA</title></head><body><div class="g-recaptcha"></div></body></html>`;

const LOVEHONEY_BLOCK = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Blocked request</title></head><body><nav></nav><main><section><p>Sorry, your request was blocked.</p></section></main></body></html>`;

const REAL_ARTICLE = `<!DOCTYPE html><html lang="en-US"><head><title>8 Best Anal Masturbation Positions and Tips for Self-Love</title></head><body><article><h1>8 Best Positions</h1>${"<p>Real editorial body copy that goes on for a while. </p>".repeat(400)}</article></body></html>`;

describe("classifyAntibotResponse", () => {
  describe("confirmed challenge fingerprints", () => {
    it("identifies a Cloudflare interstitial", () => {
      const result = classifyAntibotResponse({
        statusCode: 403,
        html: CLOUDFLARE_CHALLENGE,
        contentType: "text/html; charset=UTF-8",
      });
      expect(result.confidence).toBe("confirmed");
      expect(result.vendor).toBe("cloudflare");
      expect(result.failureClass).toBe("antibot_challenge:cloudflare");
    });

    it("identifies an Akamai edge denial", () => {
      const result = classifyAntibotResponse({
        statusCode: 403,
        html: AKAMAI_DENIED,
        contentType: "text/html",
      });
      expect(result.confidence).toBe("confirmed");
      expect(result.vendor).toBe("akamai");
    });

    it("identifies a reCAPTCHA interstitial served with HTTP 200", () => {
      // PMC answers 200 with this body, so status alone would call it a success.
      const result = classifyAntibotResponse({
        statusCode: 200,
        html: RECAPTCHA_INTERSTITIAL,
        contentType: "text/html; charset=utf-8",
      });
      expect(result.confidence).toBe("confirmed");
      expect(result.vendor).toBe("recaptcha");
    });
  });

  describe("suspected blocks without a fingerprint", () => {
    it("marks a bare 403 block page as suspected, not confirmed", () => {
      const result = classifyAntibotResponse({
        statusCode: 403,
        html: LOVEHONEY_BLOCK,
        contentType: "text/html",
      });
      expect(result.confidence).toBe("suspected");
      expect(result.failureClass).toBe("http_403_blocked");
      expect(result.vendor).toBeUndefined();
    });

    it("marks 429 as suspected", () => {
      const result = classifyAntibotResponse({
        statusCode: 429,
        html: "<html><body>Too many requests</body></html>",
      });
      expect(result.confidence).toBe("suspected");
      expect(result.failureClass).toBe("http_429_blocked");
    });
  });

  describe("non-anti-bot outcomes", () => {
    it("never classifies a 404 as anti-bot", () => {
      const result = classifyAntibotResponse({
        statusCode: 404,
        html: "<html><body>Not Found</body></html>",
      });
      expect(result.confidence).toBe("none");
      expect(result.failureClass).toBe("http_404");
    });

    it("never classifies a 410 as anti-bot", () => {
      expect(
        classifyAntibotResponse({ statusCode: 410, html: "<html></html>" })
          .confidence,
      ).toBe("none");
    });

    it("treats an ordinary 200 page as clean", () => {
      const result = classifyAntibotResponse({
        statusCode: 200,
        html: "<html><head><title>Docs</title></head><body><p>Hello</p></body></html>",
        contentType: "text/html",
      });
      expect(result.confidence).toBe("none");
    });

    it("does not flag a large real article that merely happens to 403", () => {
      // anesidoralove.com returns 403 with the full ~550 KB article. Calling
      // that "anti-bot" would burn a stealth attempt on a page whose content
      // already arrived.
      const result = classifyAntibotResponse({
        statusCode: 403,
        html: REAL_ARTICLE,
        contentType: "text/html",
      });
      expect(result.confidence).not.toBe("confirmed");
    });

    it("ignores markers in non-HTML payloads", () => {
      const result = classifyAntibotResponse({
        statusCode: 403,
        html: JSON.stringify({ note: "just a moment, __cf_chl" }),
        contentType: "application/json",
      });
      expect(result.confidence).toBe("suspected");
      expect(result.vendor).toBeUndefined();
    });

    it("never classifies our own SSRF block as anti-bot", () => {
      // The browser microservices report a blocked internal target as HTTP 403
      // with an explanatory pageError. Reading that as anti-bot would send the
      // stealth browser off to retry an internal address.
      for (const pageError of [
        'Blocked insecure target URL "http://169.254.169.254/": resolves to a private/internal address',
        'Blocked insecure target URL "http://192.168.0.107:3002/": port 3002 is not allowed',
        "Connection violated security rules.",
      ]) {
        const result = classifyAntibotResponse({
          statusCode: 403,
          html: "",
          pageError,
        });
        expect(result.confidence).toBe("none");
        expect(result.failureClass).toBe("blocked_internal_target");
      }
    });

    it("still classifies a genuine challenge that carries a pageError", () => {
      const result = classifyAntibotResponse({
        statusCode: 403,
        html: CLOUDFLARE_CHALLENGE,
        pageError: "Forbidden",
      });
      expect(result.confidence).toBe("confirmed");
      expect(result.vendor).toBe("cloudflare");
    });

    it("handles a missing body without throwing", () => {
      expect(classifyAntibotResponse({ statusCode: 403 }).confidence).toBe(
        "suspected",
      );
      expect(classifyAntibotResponse({ statusCode: 200 }).confidence).toBe(
        "none",
      );
    });
  });
});

// Bodies FlareSolverr returned verbatim for these hosts while reporting
// `"Challenge not detected!"` with HTTP 200. They are the reason the caller in
// scrapeURL/index.ts classifies 2xx responses instead of only [401,403,429]:
// the fingerprints below were always present, the classifier was simply never
// invoked for them.
const AWS_WAF_INTERSTITIAL = `<html><head><script src="https://de5282c3ca0c.ca-central-1.token.awswaf.com/de5282c3ca0c/challenge.js"></script></head><body><div id="challenge-container"></div><script>window.awsWafCookieDomainList = []; AwsWafIntegration.saveReferrer();</script></body></html>`;

const JSTOR_ACCESS_CHECK = `<html><head><title>JSTOR: Access Check</title><style>.px-captcha-error-container{position:fixed;height:328px}</style></head><body><h2>Access Check</h2><p>Our systems have detected unusual traffic activity from your network.</p></body></html>`;

describe("challenge pages served under a 2xx status", () => {
  it("identifies an AWS WAF interstitial returned as HTTP 200", () => {
    const result = classifyAntibotResponse({
      statusCode: 200,
      html: AWS_WAF_INTERSTITIAL,
      contentType: "text/html",
    });
    expect(result.confidence).toBe("confirmed");
    expect(result.vendor).toBe("awswaf");
  });

  it("identifies a JSTOR access check returned as HTTP 200", () => {
    const result = classifyAntibotResponse({
      statusCode: 200,
      html: JSTOR_ACCESS_CHECK,
      contentType: "text/html",
    });
    expect(result.confidence).toBe("confirmed");
  });

  it("still calls an ordinary 200 document clean", () => {
    const result = classifyAntibotResponse({
      statusCode: 200,
      html: REAL_ARTICLE,
      contentType: "text/html",
    });
    expect(result.confidence).toBe("none");
  });

  it("never returns `suspected` for a 2xx, so only body evidence can fail one", () => {
    // The caller treats `confirmed` on a 2xx as an engine failure. If a bare
    // 200 could ever come back `suspected`, that guard would misfire on real
    // pages -- this pins the invariant it relies on.
    for (const status of [200, 201, 204, 206, 304]) {
      const result = classifyAntibotResponse({
        statusCode: status,
        html: "<html><body><p>ordinary</p></body></html>",
        contentType: "text/html",
      });
      expect(result.confidence).toBe("none");
    }
  });
});

describe("meetsConfidenceThreshold", () => {
  const confirmed = classifyAntibotResponse({
    statusCode: 403,
    html: CLOUDFLARE_CHALLENGE,
  });
  const suspected = classifyAntibotResponse({
    statusCode: 403,
    html: LOVEHONEY_BLOCK,
  });
  const none = classifyAntibotResponse({ statusCode: 404, html: "<html/>" });

  it("never admits a non-anti-bot response", () => {
    expect(meetsConfidenceThreshold(none, "suspected")).toBe(false);
    expect(meetsConfidenceThreshold(none, "confirmed")).toBe(false);
  });

  it("admits suspected blocks only at the lower threshold", () => {
    expect(meetsConfidenceThreshold(suspected, "suspected")).toBe(true);
    expect(meetsConfidenceThreshold(suspected, "confirmed")).toBe(false);
  });

  it("admits confirmed challenges at either threshold", () => {
    expect(meetsConfidenceThreshold(confirmed, "suspected")).toBe(true);
    expect(meetsConfidenceThreshold(confirmed, "confirmed")).toBe(true);
  });
});
