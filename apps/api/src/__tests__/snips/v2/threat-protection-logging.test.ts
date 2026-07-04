import { createHmac } from "crypto";
import http from "http";
import request from "supertest";
import {
  describeIf,
  idmux,
  Identity,
  TEST_API_URL,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
  scrapeTimeout,
} from "../lib";
import { scrapeRaw, scrape } from "./lib";

// =========================================
// Threat protection security logging + SIEM export (ENG-4986/4987)
//
// Coverage strategy:
//  * Flag gating (403s) and the log export API surface run everywhere
//    TEST_PRODUCTION is set.
//  * ClickHouse row-level assertions run only when the analytics ClickHouse
//    is provisioned for the harness (the logs endpoint responds without the
//    "not configured" warning); otherwise the row content is covered by unit
//    tests (logging.test.ts, tracking.test.ts, logs.test.ts) and this suite
//    only asserts the API surface.
//  * SIEM push tests need a local HTTP receiver, which the API/worker may
//    only call when started with ALLOW_LOCAL_WEBHOOKS=true, and an org
//    config (threat_protection_config DDL). Run locally with:
//
//      ALLOW_LOCAL_WEBHOOKS=true \
//      pnpm harness jest src/__tests__/snips/v2/threat-protection-logging.test.ts
//
//    They self-skip (with a warning) when either prerequisite is missing.
// =========================================

const BLACKLISTED_DOMAIN = "threat-log-blacklisted.example.com";
const SIEM_RECEIVER_PORT = 4519;
const SIEM_SECRET = "snips-siem-secret";

const HAS_LOCAL_WEBHOOKS = process.env.ALLOW_LOCAL_WEBHOOKS === "true";

interface ReceivedSiemRequest {
  body: string;
  payload: any;
  signature: string | undefined;
}

let siemReceiver: http.Server | null = null;
const siemRequests: ReceivedSiemRequest[] = [];

function startSiemReceiver(): Promise<void> {
  siemReceiver = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      try {
        siemRequests.push({
          body,
          payload: JSON.parse(body),
          signature: req.headers["x-firecrawl-signature"] as string | undefined,
        });
      } catch (_) {}
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve, reject) => {
    siemReceiver!.once("error", reject);
    siemReceiver!.listen(SIEM_RECEIVER_PORT, () => resolve());
  });
}

function expectValidSignature(received: ReceivedSiemRequest) {
  const expected = `sha256=${createHmac("sha256", SIEM_SECRET)
    .update(received.body)
    .digest("hex")}`;
  expect(received.signature).toBe(expected);
}

async function waitFor<T>(
  predicate: () => T | undefined,
  timeoutMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return undefined;
}

async function getLogs(identity: Identity, query: Record<string, string>) {
  return await request(TEST_API_URL)
    .get("/v2/team/threat-protection/logs")
    .query(query)
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .send();
}

async function putConfig(body: unknown, identity: Identity) {
  return await request(TEST_API_URL)
    .put("/v2/team/threat-protection")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json")
    .send(body as object);
}

async function postTestSiem(identity: Identity) {
  return await request(TEST_API_URL)
    .post("/v2/team/threat-protection/test-siem")
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .send();
}

describeIf(TEST_PRODUCTION)("Threat protection security logging", () => {
  describe("without the team flag", () => {
    let identity: Identity;

    beforeAll(async () => {
      identity = await idmux({
        name: "threat-protection-logging/no-flag",
      });
    });

    it(
      "log export is rejected with 403",
      async () => {
        const res = await getLogs(identity, {});
        expect(res.statusCode).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain("enterprise feature");
      },
      scrapeTimeout,
    );

    it(
      "test-siem is rejected with 403",
      async () => {
        const res = await postTestSiem(identity);
        expect(res.statusCode).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain("enterprise feature");
      },
      scrapeTimeout,
    );
  });

  describe("log export API", () => {
    let identity: Identity;

    beforeAll(async () => {
      identity = await idmux({
        name: "threat-protection-logging/logs",
        flags: { threatProtection: "allowed" },
        credits: 1_000_000,
      });
    });

    it(
      "returns a well-formed page",
      async () => {
        const res = await getLogs(identity, { limit: "5" });
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.data.logs)).toBe(true);
        expect(res.body.data).toHaveProperty("nextCursor");
      },
      scrapeTimeout,
    );

    it(
      "rejects invalid filter values with 400",
      async () => {
        const res = await getLogs(identity, { decision: "maybe" });
        expect(res.statusCode).toBe(400);
      },
      scrapeTimeout,
    );

    it(
      "rejects a malformed cursor with 400",
      async () => {
        const res = await getLogs(identity, { cursor: "not-a-cursor" });
        expect(res.statusCode).toBe(400);
      },
      scrapeTimeout,
    );

    it(
      "rejects from > to with 400",
      async () => {
        const res = await getLogs(identity, {
          from: "2026-07-04T00:00:00.000Z",
          to: "2026-07-01T00:00:00.000Z",
        });
        expect(res.statusCode).toBe(400);
      },
      scrapeTimeout,
    );

    it(
      "a blocked scrape shows up in the security log (when ClickHouse is provisioned)",
      async () => {
        const probe = await getLogs(identity, { limit: "1" });
        expect(probe.statusCode).toBe(200);
        if (probe.body.warning) {
          console.warn(
            "analytics ClickHouse not configured for the harness; row-level " +
              "log assertions are covered by unit tests (logging.test.ts, " +
              "logs.test.ts) instead",
          );
          return;
        }

        const res = await scrapeRaw(
          {
            url: `https://${BLACKLISTED_DOMAIN}/page`,
            threatProtection: {
              mode: "normal",
              blacklist: [BLACKLISTED_DOMAIN],
            },
          } as any,
          identity,
        );
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe("unsafe_domain_blocked");

        // Async-inserted; poll the export API.
        const deadline = Date.now() + 30000;
        let entry: any;
        while (Date.now() < deadline && !entry) {
          const logs = await getLogs(identity, {
            decision: "blocked",
            domain: BLACKLISTED_DOMAIN,
            limit: "10",
          });
          expect(logs.statusCode).toBe(200);
          entry = logs.body.data.logs[0];
          if (!entry) await new Promise(resolve => setTimeout(resolve, 1000));
        }

        expect(entry).toBeDefined();
        expect(entry.domain).toBe(BLACKLISTED_DOMAIN);
        expect(entry.decision).toBe("blocked");
        expect(entry.rule).toBe("blacklist");
        expect(entry.mode).toBe("normal");
        expect(entry.providerConsulted).toBe(false);
      },
      scrapeTimeout * 2,
    );
  });

  describe("SIEM push (local receiver)", () => {
    let identity: Identity;
    let siemConfigured = false;

    beforeAll(async () => {
      if (!HAS_LOCAL_WEBHOOKS) {
        console.warn(
          "ALLOW_LOCAL_WEBHOOKS is not set; skipping SIEM local-receiver tests",
        );
        return;
      }

      identity = await idmux({
        name: "threat-protection-logging/siem",
        flags: { threatProtection: "allowed" },
        credits: 1_000_000,
      });

      await startSiemReceiver();

      // Org config with a SIEM destination. Needs the
      // threat_protection_config table; self-skip when unavailable.
      const res = await putConfig(
        {
          mode: "normal",
          blacklist: [BLACKLISTED_DOMAIN],
          failurePolicy: "open",
          siem: {
            url: `http://localhost:${SIEM_RECEIVER_PORT}/siem`,
            secret: SIEM_SECRET,
            events: "blocked",
          },
        },
        identity,
      );
      siemConfigured = res.statusCode === 200;
      if (!siemConfigured) {
        console.warn(
          "threat protection config API unavailable (missing DDL?); skipping SIEM tests",
          res.statusCode,
          res.body,
        );
      }
    }, scrapeTimeout);

    afterAll(async () => {
      if (siemConfigured) {
        await putConfig({ mode: "off", siem: null }, identity);
      }
      if (siemReceiver) {
        await new Promise(resolve => siemReceiver!.close(resolve));
        siemReceiver = null;
      }
    }, scrapeTimeout);

    it(
      "test-siem delivers a signed synthetic event to the receiver",
      async () => {
        if (!siemConfigured) return;

        const res = await postTestSiem(identity);
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.delivered).toBe(true);
        expect(res.body.data.statusCode).toBe(200);

        const received = await waitFor(
          () =>
            siemRequests.find(
              x => x.payload?.type === "threat_protection.test",
            ),
          10000,
        );
        expect(received).toBeDefined();
        expect(received!.payload.test).toBe(true);
        expect(received!.payload.events).toHaveLength(1);
        expect(received!.payload.events[0].rule).toBe("siem-test");
        expectValidSignature(received!);
      },
      scrapeTimeout,
    );

    it(
      'pushes batched, signed check events, honoring events: "blocked"',
      async () => {
        if (!siemConfigured) return;

        // One allowed decision (clean domain, failurePolicy open) ...
        const allowed = await scrape(
          { url: TEST_SUITE_WEBSITE } as any,
          identity,
        );
        expect(allowed.metadata.statusCode).toBe(200);

        // ... and one blocked decision (org blacklist).
        const blocked = await scrapeRaw(
          { url: `https://${BLACKLISTED_DOMAIN}/page` } as any,
          identity,
        );
        expect(blocked.statusCode).toBe(403);
        expect(blocked.body.code).toBe("unsafe_domain_blocked");

        // Buffered delivery: default flush interval is 5s; poll the receiver.
        const received = await waitFor(
          () =>
            siemRequests.find(
              x =>
                x.payload?.type === "threat_protection.check_batch" &&
                x.payload.events?.some(
                  (event: any) => event.url_domain === BLACKLISTED_DOMAIN,
                ),
            ),
          30000,
        );
        expect(received).toBeDefined();
        expectValidSignature(received!);

        const batch = received!.payload;
        expect(batch.batchId).toEqual(expect.any(String));
        expect(batch.sentAt).toEqual(expect.any(String));
        const event = batch.events.find(
          (x: any) => x.url_domain === BLACKLISTED_DOMAIN,
        );
        expect(event.decision).toBe("blocked");
        expect(event.rule).toBe("blacklist");
        expect(event.mode).toBe("normal");
        expect(event.team_id).toBe(identity.teamId);

        // events: "blocked" — no allowed decision may ever reach the SIEM.
        for (const req of siemRequests) {
          if (req.payload?.type !== "threat_protection.check_batch") continue;
          for (const event of req.payload.events) {
            expect(event.decision).toBe("blocked");
          }
        }
      },
      scrapeTimeout * 3,
    );

    it(
      "test-siem returns 400 when no SIEM destination is configured",
      async () => {
        if (!siemConfigured) return;

        await putConfig(
          { mode: "normal", blacklist: [BLACKLISTED_DOMAIN], siem: null },
          identity,
        );
        const res = await postTestSiem(identity);
        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain("No SIEM destination");

        // Restore for any remaining assertions/reruns.
        await putConfig(
          {
            mode: "normal",
            blacklist: [BLACKLISTED_DOMAIN],
            failurePolicy: "open",
            siem: {
              url: `http://localhost:${SIEM_RECEIVER_PORT}/siem`,
              secret: SIEM_SECRET,
              events: "blocked",
            },
          },
          identity,
        );
      },
      scrapeTimeout,
    );
  });
});
