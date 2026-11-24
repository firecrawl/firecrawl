vi.mock("../../../services/rate-limiter", () => ({ redisRateLimitClient: {} }));
// Sessions are rows in Postgres, so these tests run the real queries against
// COMPUTER_SESSION_TEST_DATABASE_URL, and are skipped without it.
vi.mock("../../../db/connection", async () => {
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const client = new Pool({
    connectionString: process.env.COMPUTER_SESSION_TEST_DATABASE_URL,
  });
  return { db: drizzle({ client }) };
});
vi.mock("../../../lib/logger", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: { ...log, child: () => log } };
});
// A key made here signs the same way a service account's does.
vi.mock("../../../lib/gcs-jobs", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { Storage } = await import("@google-cloud/storage");
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    storage: new Storage({
      credentials: {
        type: "service_account",
        client_email: "signer@test.iam.gserviceaccount.com",
        private_key: privateKey,
      },
    }),
  };
});

import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import express from "express";
import { RateLimiterMemory } from "rate-limiter-flexible";
import request from "supertest";
import { config } from "../../../config";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";
import {
  MAX_FILE_BYTES,
  MAX_LIVE_SESSIONS,
  computerSessionFileControllers,
  configuredComputerSessionFiles,
  gcsStore,
  type ComputerSessionFileStore,
} from "../computer-session-files";

const databaseUrl = process.env.COMPUTER_SESSION_TEST_DATABASE_URL;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const TEAM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNISSUED = "00000000-0000-4000-8000-000000000000";

const objects = new Map<string, Buffer>();
const store: ComputerSessionFileStore = {
  async write(objectPath, body) {
    objects.set(objectPath, Buffer.concat(await body.toArray()));
  },
  async read(objectPath) {
    const bytes = objects.get(objectPath);
    return bytes ? Readable.from([bytes]) : null;
  },
  async delete(objectPath) {
    objects.delete(objectPath);
  },
  // What the link was signed for, readable back from the URL.
  async downloadUrl(objectPath, filename, expiresAt) {
    return `https://storage.test/${objectPath}?filename=${filename}&expires=${expiresAt}`;
  },
};

// Each link in these tests is under a mebibyte, so it counts as one.
const LINKS_PER_HOUR = 5;
const linkLimit = new RateLimiterMemory({
  points: LINKS_PER_HOUR,
  duration: 60 * 60,
});
const linkTargets = new Map<string, string>();
const controllers = computerSessionFileControllers(store, linkLimit, {
  set: async (token, url) => linkTargets.set(token, url),
  get: async token => linkTargets.get(token) ?? null,
});
// Stands in for authMiddleware: the team, the hosted MCP mark and the team
// flags come from test headers.
const auth: express.RequestHandler = (req, _res, next) => {
  Object.assign(req, {
    auth: {
      team_id: req.get("x-test-team"),
      ...(req.get("x-test-direct") ? {} : { hostedMcp: true }),
    },
    acuc: { flags: JSON.parse(req.get("x-test-flags") ?? "{}") },
  });
  next();
};
const run =
  (
    controller: (req: any, res: express.Response) => Promise<unknown>,
  ): express.RequestHandler =>
  (req, res, next) => {
    controller(req, res).catch(next);
  };

const SESSIONS = "/v2/computer/sessions";
const workspaceOf = (id: string) => `${SESSIONS}/${id}/workspace`;
const app = express();
app.post(SESSIONS, auth, run(controllers.createSession));
app.put(
  `${SESSIONS}/:sessionId/workspace`,
  auth,
  run(controllers.saveWorkspace),
);
app.get(
  `${SESSIONS}/:sessionId/workspace`,
  auth,
  run(controllers.readWorkspace),
);
app.post(`${SESSIONS}/:sessionId/links`, auth, run(controllers.createLink));
app.get("/v2/computer/links/:token", run(controllers.openLink));

const sessions = schema.computer_sessions;
const forgetSessions = () =>
  db.delete(sessions).where(inArray(sessions.team_id, [TEAM_A, TEAM_B]));

let server: http.Server;
afterEach(() => {
  vi.restoreAllMocks();
});

const create = (team = TEAM_A) =>
  request(server).post(SESSIONS).set("x-test-team", team);
const createId = async (team = TEAM_A) =>
  (await create(team)).body.data.id as string;
const save = (team: string, id: string, bytes: string) =>
  request(server)
    .put(workspaceOf(id))
    .set("x-test-team", team)
    .type("application/octet-stream")
    .send(Buffer.from(bytes));
const read = (team: string, id: string) =>
  request(server)
    .get(workspaceOf(id))
    .set("x-test-team", team)
    .responseType("blob");
const link = (
  id: string,
  bytes: string,
  query: Record<string, string | number>,
  team = TEAM_A,
) =>
  request(server)
    .post(`${SESSIONS}/${id}/links`)
    .query(query)
    .set("x-test-team", team)
    .type("application/octet-stream")
    .send(Buffer.from(bytes));
/** The status of a save that only declares its body, so no test sends one over the limit. */
const declare = (id: string, headers: http.OutgoingHttpHeaders) =>
  new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        port: (server.address() as AddressInfo).port,
        method: "PUT",
        path: workspaceOf(id),
        headers: {
          "x-test-team": TEAM_A,
          "content-type": "application/octet-stream",
          ...headers,
        },
      },
      res => {
        resolve(res.statusCode ?? 0);
        req.destroy();
      },
    );
    req.on("error", reject);
    req.write("x");
  });
const seed = (team: string, count: number, expiresAt: number) =>
  db.insert(sessions).values(
    Array.from({ length: count }, () => ({
      id: crypto.randomUUID(),
      team_id: team,
      expires_at: new Date(expiresAt).toISOString(),
    })),
  );
const storedSession = async (id: string) =>
  (await db.select().from(sessions).where(eq(sessions.id, id)))[0];
/** Moves a session's times back, as if that long had passed. */
const elapse = (id: string, ms: number) =>
  db.execute(sql`
    UPDATE computer_sessions
    SET created_at = created_at - ${ms}::float8 * interval '1 millisecond',
        last_saved_at = last_saved_at - ${ms}::float8 * interval '1 millisecond',
        expires_at = expires_at - ${ms}::float8 * interval '1 millisecond'
    WHERE id = ${id}::uuid
  `);
const liveSessions = (team: string) =>
  db.$count(
    sessions,
    and(
      eq(sessions.team_id, team),
      gt(sessions.expires_at, new Date().toISOString()),
    ),
  );

describe.skipIf(!databaseUrl)("session routes", () => {
  beforeAll(async () => {
    // The table as the firecrawl-db migration creates it.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS computer_sessions (
        id uuid PRIMARY KEY,
        team_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_saved_at timestamptz,
        expires_at timestamptz NOT NULL
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS computer_sessions_team_id_expires_at_idx
        ON computer_sessions (team_id, expires_at)
    `);
    server = app.listen(0);
  });
  afterAll(async () => {
    server.closeAllConnections();
    server.close();
    await forgetSessions();
    await (
      db as unknown as { $client: { end(): Promise<void> } }
    ).$client.end();
  });
  beforeEach(async () => {
    objects.clear();
    await forgetSessions();
    await linkLimit.delete(TEAM_A);
  });

  describe("sessions", () => {
    it("creates a session the API names, empty and live for a day", async () => {
      const created = await create();
      expect(created.status).toBe(200);
      const { id, expiresAt } = created.body.data;
      expect(id).toMatch(UUID);
      const lifetimeMs = new Date(expiresAt).getTime() - Date.now();
      expect(lifetimeMs).toBeGreaterThan(DAY_MS - 60_000);
      expect(lifetimeMs).toBeLessThanOrEqual(DAY_MS);
      // The session is a row, and nothing is stored until the first save.
      expect(await storedSession(id)).toMatchObject({ id, team_id: TEAM_A });
      expect(objects.size).toBe(0);

      const res = await read(TEAM_A, id);
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(0);
    });

    it("moves the session's end out on each save, up to a week from its start", async () => {
      const lifetimeMs = (saved: request.Response) =>
        new Date(saved.body.data.expiresAt).getTime() - Date.now();
      const id = await createId();
      await elapse(id, 20 * HOUR_MS);
      const saved = await save(TEAM_A, id, "files");
      expect(lifetimeMs(saved)).toBeGreaterThan(DAY_MS - 60_000);
      expect(lifetimeMs(saved)).toBeLessThanOrEqual(DAY_MS);
      // Past the end it was created with, and still live.
      await elapse(id, 20 * HOUR_MS);
      expect((await read(TEAM_A, id)).status).toBe(200);
      // A read does not move the end.
      await elapse(id, 5 * HOUR_MS);
      expect((await read(TEAM_A, id)).status).toBe(404);

      const busy = await createId();
      let last: request.Response;
      for (let hour = 20; hour < 7 * 24; hour += 20) {
        await elapse(busy, 20 * HOUR_MS);
        last = await save(TEAM_A, busy, "files");
        expect(last.status).toBe(200);
      }
      // 160 hours in, so the week leaves 8.
      expect(lifetimeMs(last!)).toBeGreaterThan(8 * HOUR_MS - 60_000);
      expect(lifetimeMs(last!)).toBeLessThanOrEqual(8 * HOUR_MS);
      await elapse(busy, 8 * HOUR_MS);
      expect((await save(TEAM_A, busy, "files")).status).toBe(404);
    });

    it("ends the session saved longest ago when a team at the limit starts another", async () => {
      const idle = await createId();
      await save(TEAM_A, idle, "files");
      await db
        .update(sessions)
        .set({ last_saved_at: new Date(Date.now() - HOUR_MS).toISOString() })
        .where(eq(sessions.id, idle));
      const other = await createId(TEAM_B);
      await save(TEAM_B, other, "files");
      await seed(TEAM_A, 5, Date.now() - 1);
      await seed(TEAM_A, MAX_LIVE_SESSIONS - 2, Date.now() + DAY_MS);

      // The last free place, so nothing ends.
      expect((await create()).status).toBe(200);
      expect((await read(TEAM_A, idle)).status).toBe(200);

      const created = await create();
      expect(created.status).toBe(200);
      expect((await read(TEAM_A, created.body.data.id)).status).toBe(200);
      // The ended session is gone with its files, and no other team's is.
      expect((await read(TEAM_A, idle)).status).toBe(404);
      expect([...objects.keys()]).toEqual([`workspaces/${TEAM_B}/${other}`]);
      expect((await read(TEAM_B, other)).status).toBe(200);
      expect(await liveSessions(TEAM_A)).toBe(MAX_LIVE_SESSIONS);
    });

    it("holds a team to the limit when creations arrive together", async () => {
      await seed(TEAM_A, MAX_LIVE_SESSIONS - 3, Date.now() + DAY_MS);
      const statuses = await Promise.all(
        Array.from({ length: 10 }, async () => (await create()).status),
      );
      expect(statuses).toEqual(Array(10).fill(200));
      expect(await liveSessions(TEAM_A)).toBe(MAX_LIVE_SESSIONS);
    });

    it.each([
      ["an id the API did not issue", async () => UNISSUED],
      ["an id of another shape", async () => "a.b"],
      [
        "a path out of the team's own sessions",
        async () => `..%2F${TEAM_B}%2Fx`,
      ],
      ["another team's session", () => createId(TEAM_B)],
      [
        "an expired session",
        async () => {
          const id = await createId();
          await elapse(id, DAY_MS);
          return id;
        },
      ],
    ])("finds no session for %s on any route", async (_name, sessionId) => {
      const id = await sessionId();
      const before = new Map(objects);
      expect((await save(TEAM_A, id, "files")).status).toBe(404);
      expect((await read(TEAM_A, id)).status).toBe(404);
      expect((await link(id, "data", { filename: "a.txt" })).status).toBe(404);
      expect(objects).toEqual(before);
    });

    it.each<[string, Record<string, string>]>([
      ["a caller that is not the hosted MCP", { "x-test-direct": "1" }],
      ...[
        { forceZDR: true },
        { scrapeZDR: "forced" },
        { searchZDR: "forced-zdr" },
        { searchZDR: "forced-anon" },
        { safeMode: true, safeModeConfig: { lockdown: true } },
      ].map((flags): [string, Record<string, string>] => {
        const json = JSON.stringify(flags);
        return [`a team with the flags ${json}`, { "x-test-flags": json }];
      }),
    ])("refuses %s on every session route", async (_name, headers) => {
      const id = await createId();
      const before = new Map(objects);
      const bytes = Buffer.from("x");
      const calls = [
        request(server).post(SESSIONS),
        request(server)
          .put(workspaceOf(id))
          .type("application/octet-stream")
          .send(bytes),
        request(server).get(workspaceOf(id)),
        request(server)
          .post(`${SESSIONS}/${id}/links`)
          .query({ filename: "a.txt" })
          .type("application/octet-stream")
          .send(bytes),
      ];
      for (const call of calls) {
        const res = await call.set("x-test-team", TEAM_A).set(headers);
        expect(res.status).toBe(403);
      }
      expect(objects).toEqual(before);
    });
  });

  describe("workspace", () => {
    it("reads back the bytes it saved", async () => {
      const id = await createId();
      const saved = await save(TEAM_A, id, "files");
      expect(saved.status).toBe(200);
      expect(saved.body.data).toEqual({
        sizeBytes: 5,
        expiresAt: expect.any(String),
      });
      expect([...objects.keys()]).toEqual([`workspaces/${TEAM_A}/${id}`]);

      const res = await read(TEAM_A, id);
      expect(res.status).toBe(200);
      expect(res.body.toString()).toBe("files");
    });

    it("leaves a session ended, and stores nothing, when it ends while a save uploads", async () => {
      const id = await createId();
      await save(TEAM_A, id, "one");
      const write = store.write;
      vi.spyOn(store, "write").mockImplementationOnce(async (...args) => {
        await write(...args);
        await db
          .update(sessions)
          .set({ expires_at: new Date(Date.now() - 1).toISOString() })
          .where(eq(sessions.id, id));
      });

      expect((await save(TEAM_A, id, "two")).status).toBe(404);
      expect(objects.size).toBe(0);
      expect(await liveSessions(TEAM_A)).toBe(0);
      expect((await read(TEAM_A, id)).status).toBe(404);
    });

    it("says so when a saved workspace is no longer stored", async () => {
      const id = await createId();
      await save(TEAM_A, id, "files");
      objects.clear();
      expect((await read(TEAM_A, id)).status).toBe(410);
    });

    it("refuses a body over the limit, or of unknown size, before reading it", async () => {
      const id = await createId();
      expect(await declare(id, { "content-length": MAX_FILE_BYTES + 1 })).toBe(
        413,
      );
      expect(await declare(id, {})).toBe(411);
      expect(
        await declare(id, {
          "content-length": 1,
          "content-type": "application/json",
        }),
      ).toBe(415);
      expect(objects.size).toBe(0);
    });
  });

  describe("download links", () => {
    it("stores the file and returns a link signed for it, under a safe name", async () => {
      const created = await link(await createId(), "a,b\n1,2\n", {
        filename: "../../quarterly report.csv",
      });
      expect(created.status).toBe(200);
      const { url, expiresAt, sizeBytes } = created.body.data;
      expect(sizeBytes).toBe(8);
      const lifetimeMs = new Date(expiresAt).getTime() - Date.now();
      expect(lifetimeMs).toBeGreaterThan(14 * 60 * 1000);
      expect(lifetimeMs).toBeLessThanOrEqual(15 * 60 * 1000);

      // The short link redirects to the URL signed for the file.
      expect(url).toMatch(/\/v2\/computer\/links\/[A-Za-z0-9_-]{22}$/);
      const opened = await request(server).get(new URL(url).pathname);
      expect(opened.status).toBe(302);
      const signed = new URL(opened.headers.location);
      const objectPath = decodeURIComponent(signed.pathname.slice(1));
      expect(objectPath).toMatch(
        /^links\/[0-9a-f-]{36}\/quarterly_report\.csv$/,
      );
      expect(objects.get(objectPath)?.toString()).toBe("a,b\n1,2\n");
      expect(signed.searchParams.get("filename")).toBe("quarterly_report.csv");
      // Signed to end when the caller is told it ends.
      expect(Number(signed.searchParams.get("expires"))).toBe(
        new Date(expiresAt).getTime(),
      );
    });

    it("signs the link for the time asked, counted from the end of the upload", async () => {
      const write = store.write;
      const began = Date.now();
      vi.spyOn(store, "write").mockImplementationOnce(async (...args) => {
        await write(...args);
        vi.spyOn(Date, "now").mockReturnValue(began + HOUR_MS);
      });
      const created = await link(await createId(), "data", {
        filename: "a.txt",
        expiresInSeconds: 60,
      });
      expect(new Date(created.body.data.expiresAt).getTime()).toBe(
        began + HOUR_MS + 60_000,
      );
    });

    it("holds a team's links to its hourly limit", async () => {
      const id = await createId();
      // A link that could not be stored, or not signed, does not count, and
      // leaves nothing stored.
      vi.spyOn(store, "write").mockRejectedValueOnce(new Error("storage"));
      expect((await link(id, "data", { filename: "a.txt" })).status).toBe(500);
      vi.spyOn(store, "downloadUrl").mockRejectedValueOnce(
        new Error("signing"),
      );
      expect((await link(id, "data", { filename: "a.txt" })).status).toBe(500);
      expect(objects.size).toBe(0);
      for (let made = 0; made < LINKS_PER_HOUR; made++) {
        expect((await link(id, "data", { filename: "a.txt" })).status).toBe(
          200,
        );
      }
      const stored = objects.size;
      const refused = await link(id, "data", { filename: "a.txt" });
      expect(refused.status).toBe(429);
      expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
      expect(objects.size).toBe(stored);
      const other = await createId(TEAM_B);
      expect(
        (await link(other, "data", { filename: "a.txt" }, TEAM_B)).status,
      ).toBe(200);
    });

    it.each([
      ["no filename", {}],
      [
        "a lifetime over an hour",
        { filename: "a.txt", expiresInSeconds: 3601 },
      ],
      ["a lifetime under a minute", { filename: "a.txt", expiresInSeconds: 5 }],
    ])("refuses a link with %s", async (_name, query) => {
      const id = await createId();
      expect((await link(id, "data", query)).status).toBe(400);
      expect(objects.size).toBe(0);
    });
  });
});

describe("configuration", () => {
  const original = {
    bucket: config.GCS_COMPUTER_SESSION_FILES_BUCKET_NAME,
    redis: config.REDIS_RATE_LIMIT_URL,
  };
  afterAll(() => {
    config.GCS_COMPUTER_SESSION_FILES_BUCKET_NAME = original.bucket;
    config.REDIS_RATE_LIMIT_URL = original.redis;
  });

  it("has no handlers without a bucket", () => {
    config.GCS_COMPUTER_SESSION_FILES_BUCKET_NAME = undefined;
    expect(configuredComputerSessionFiles()).toBeNull();
  });

  it("has every handler with a bucket", () => {
    config.GCS_COMPUTER_SESSION_FILES_BUCKET_NAME = "bucket";
    // The limiter counts in memory, so the test needs no Redis.
    config.REDIS_RATE_LIMIT_URL = undefined;
    expect(Object.keys(configuredComputerSessionFiles() ?? {}).sort()).toEqual([
      "createLink",
      "createSession",
      "openLink",
      "readWorkspace",
      "saveWorkspace",
    ]);
  });

  it("signs a link that only downloads its file, under its name, until its end", async () => {
    const url = new URL(
      await gcsStore("bucket").downloadUrl(
        "links/id/report.csv",
        "report.csv",
        Date.now() + 60_000,
      ),
    );
    expect(url.origin + url.pathname).toBe(
      "https://storage.googleapis.com/bucket/links/id/report.csv",
    );
    const signed = url.searchParams;
    expect(signed.get("X-Goog-Algorithm")).toBe("GOOG4-RSA-SHA256");
    expect(signed.get("X-Goog-Signature")).toMatch(/^[0-9a-f]{512}$/);
    expect(Number(signed.get("X-Goog-Expires"))).toBeGreaterThan(55);
    expect(Number(signed.get("X-Goog-Expires"))).toBeLessThanOrEqual(60);
    expect(signed.get("response-content-disposition")).toBe(
      'attachment; filename="report.csv"',
    );
    expect(signed.get("response-content-type")).toBe(
      "application/octet-stream",
    );
  });
});
