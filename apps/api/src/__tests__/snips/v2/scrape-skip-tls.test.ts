import {
  ALLOW_TEST_SUITE_WEBSITE,
  HAS_PROXY,
  TEST_PRODUCTION,
  TEST_SELF_HOST,
  TEST_SUITE_WEBSITE,
  testIf,
} from "../lib";
import { Identity, idmux, scrapeTimeout, scrape, scrapeRaw } from "./lib";
import { execFile } from "child_process";
import { createServer, type Server } from "https";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const TLS_FIXTURE_BODY = "skip tls verification fixture";
const ALLOW_LOCAL_TLS_TEST = TEST_SELF_HOST && !HAS_PROXY;

describe("V2 Scrape skipTlsVerification Default", () => {
  let identity: Identity;
  let tlsServer: Server | undefined;
  let tlsServerUrl: string;
  let tlsTempDir: string | undefined;

  beforeAll(async () => {
    identity = await idmux({
      name: "v2-scrape-skip-tls",
      concurrency: 100,
      credits: 1000000,
    });

    if (!ALLOW_LOCAL_TLS_TEST) {
      return;
    }

    tlsTempDir = await mkdtemp(path.join(tmpdir(), "firecrawl-skip-tls-"));
    const keyPath = path.join(tlsTempDir, "key.pem");
    const certPath = path.join(tlsTempDir, "cert.pem");

    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-days",
      "1",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ]);

    const [key, cert] = await Promise.all([
      readFile(keyPath),
      readFile(certPath),
    ]);

    tlsServer = createServer({ key, cert }, (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<html><body>${TLS_FIXTURE_BODY}</body></html>`);
    });

    await new Promise<void>((resolve, reject) => {
      tlsServer!.once("error", reject);
      tlsServer!.listen(0, "127.0.0.1", () => {
        tlsServer!.off("error", reject);
        const address = tlsServer!.address();
        if (address && typeof address === "object") {
          tlsServerUrl = `https://127.0.0.1:${address.port}/`;
          resolve();
        } else {
          reject(new Error("HTTPS TLS fixture failed to start"));
        }
      });
    });
  }, 20000);

  afterAll(async () => {
    if (tlsServer) {
      await new Promise<void>(resolve => {
        tlsServer!.close(() => resolve());
      });
    }

    if (tlsTempDir) {
      await rm(tlsTempDir, { recursive: true, force: true });
    }
  });

  testIf(ALLOW_LOCAL_TLS_TEST)(
    "should default skipTlsVerification to true in v2 API",
    async () => {
      const data = await scrape(
        {
          url: tlsServerUrl,
          maxAge: 0,
        },
        identity,
      );

      expect(data).toBeDefined();
      expect(data.markdown).toContain(TLS_FIXTURE_BODY);
    },
    scrapeTimeout,
  );

  testIf(ALLOW_LOCAL_TLS_TEST)(
    "should allow explicit skipTlsVerification: false override",
    async () => {
      const response = await scrapeRaw(
        {
          url: tlsServerUrl,
          skipTlsVerification: false,
          maxAge: 0,
        },
        identity,
      );

      if (response.status !== 500) {
        console.warn("Non-500 response:", JSON.stringify(response.body));
      }

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
    },
    scrapeTimeout,
  );

  testIf(ALLOW_TEST_SUITE_WEBSITE)(
    "should work with valid HTTPS sites regardless of skipTlsVerification setting",
    async () => {
      const data = await scrape(
        {
          url: TEST_SUITE_WEBSITE, // NOTE: test website in self-host mode may not use TLS, need to check this out
          maxAge: 0,
        },
        identity,
      );

      expect(data).toBeDefined();
      expect(data.markdown).toContain("Firecrawl");
    },
    scrapeTimeout,
  );

  testIf(TEST_PRODUCTION)(
    "should support object screenshot format",
    async () => {
      const data = await scrape(
        {
          url: TEST_SUITE_WEBSITE,
          formats: [{ type: "screenshot", fullPage: false }],
          maxAge: 0,
        },
        identity,
      );

      expect(data).toBeDefined();
      expect(data.screenshot).toBeDefined();
      expect(typeof data.screenshot).toBe("string");
    },
    scrapeTimeout,
  );

  testIf(TEST_PRODUCTION)(
    "should support object screenshot format with fullPage",
    async () => {
      const data = await scrape(
        {
          url: TEST_SUITE_WEBSITE,
          formats: [{ type: "screenshot", fullPage: true }],
          maxAge: 0,
        },
        identity,
      );

      expect(data).toBeDefined();
      expect(data.screenshot).toBeDefined();
      expect(typeof data.screenshot).toBe("string");
    },
    scrapeTimeout,
  );
});
