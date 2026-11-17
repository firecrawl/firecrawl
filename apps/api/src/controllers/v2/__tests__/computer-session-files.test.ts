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

import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { and, eq, inArray, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { config } from "../../../config";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";
import {
  MAX_FILE_BYTES,
  MAX_LIVE_SESSIONS,
  VersionMismatchError,
  computerSessionFileControllers,
  configuredComputerSessionFiles,
  type ComputerSessionFileStore,
} from "../computer-session-files";

const databaseUrl = process.env.COMPUTER_SESSION_TEST_DATABASE_URL;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const TEAM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNISSUED = "00000000-0000-4000-8000-000000000000";

const objects = new Map<
  string,
  { bytes: Buffer; version: number; metadata: Record<string, string> }
>();
const store: ComputerSessionFileStore = {
  async write(objectPath, body, { metadata = {}, ifVersion } = {}) {
    const bytes = Buffer.concat(await body.toArray());
    const stored = objects.get(objectPath);
    if (ifVersion !== undefined && ifVersion !== String(stored?.version ?? 0)) {
      throw new VersionMismatchError();
    }
    const version = (stored?.version ?? 0) + 1;
    objects.set(objectPath, { bytes, version, metadata });
    return String(version);
  },
  async read(objectPath) {
    const stored = objects.get(objectPath);
    if (!stored) return null;
    return {
      sizeBytes: stored.bytes.length,
      version: String(stored.version),
      metadata: stored.metadata,
      stream: () => Readable.from([stored.bytes]),
    };
  },
};

const controllers = computerSessionFileControllers(
  store,
  "https://files.test/",
);
// Stands in for authMiddleware: the team, the hosted MCP mark and the team
// flags come from test headers.
const auth: express.RequestHandler = (req, _res, next) => {
  Object.assign(req, {
    auth: {
      team_id: req.get("x-test-team"),
      ...(req.get("x-test-direct") ? {} : { hostedMcp: true }),
    },
    acuc: { flags: req.get("x-test-zdr") ? { forceZDR: true } : {} },
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
app.get("/v2/computer/files/:token{/:filename}", run(controllers.download));

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
) =>
  request(server)
    .post(`${SESSIONS}/${id}/links`)
    .query(query)
    .set("x-test-team", TEAM_A)
    .type("application/octet-stream")
    .send(Buffer.from(bytes));
const download = (url: string) =>
  request(server).get(new URL(url).pathname).responseType("blob");
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

describe.skipIf(!databaseUrl)("session routes", () => {
  beforeAll(async () => {
    // The table as the firecrawl-db migration creates it.
    await db.execute(sql`
    CREATE TABLE IF NOT EXISTS computer_sessions (
      id uuid PRIMARY KEY,
      team_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL
    )
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
      expect(res.headers["content-length"]).toBe("0");
      expect(res.headers.etag).toBe('"0"');
      expect(res.body.length).toBe(0);
    });

    it("moves the session's end out on each save, up to a week from its start", async () => {
      const { id, expiresAt } = (await create()).body.data;
      const start = new Date(expiresAt).getTime() - DAY_MS;
      const now = vi.spyOn(Date, "now");

      now.mockReturnValue(start + 20 * HOUR_MS);
      const saved = await save(TEAM_A, id, "files");
      expect(new Date(saved.body.data.expiresAt).getTime()).toBe(
        start + 44 * HOUR_MS,
      );
      // Past the end it was created with, and still live.
      now.mockReturnValue(start + 30 * HOUR_MS);
      expect((await read(TEAM_A, id)).status).toBe(200);
      // A read does not move the end.
      now.mockReturnValue(start + 44 * HOUR_MS + 1);
      expect((await read(TEAM_A, id)).status).toBe(404);

      const busy = (await create()).body.data.id;
      const began = new Date((await storedSession(busy)).created_at).getTime();
      let last;
      for (let hour = 20; hour < 7 * 24; hour += 20) {
        now.mockReturnValue(began + hour * HOUR_MS);
        last = await save(TEAM_A, busy, "files");
        expect(last.status).toBe(200);
      }
      expect(new Date(last!.body.data.expiresAt).getTime()).toBe(
        began + 7 * DAY_MS,
      );
      now.mockReturnValue(began + 7 * DAY_MS);
      expect((await save(TEAM_A, busy, "files")).status).toBe(404);
    });

    it("refuses a new session once the team has the limit of live ones", async () => {
      await seed(TEAM_A, MAX_LIVE_SESSIONS - 1, Date.now() + DAY_MS);
      await seed(TEAM_A, 5, Date.now() - 1);
      expect((await create()).status).toBe(200);
      expect((await create()).status).toBe(429);
      expect((await create(TEAM_B)).status).toBe(200);
    });

    it("admits only up to the limit when creations arrive together", async () => {
      await seed(TEAM_A, MAX_LIVE_SESSIONS - 3, Date.now() + DAY_MS);
      const statuses = await Promise.all(
        Array.from({ length: 10 }, async () => (await create()).status),
      );
      expect(statuses.filter(status => status === 200)).toHaveLength(3);
      expect(statuses.filter(status => status === 429)).toHaveLength(7);
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
          vi.spyOn(Date, "now").mockReturnValue(Date.now() + DAY_MS + 1);
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

    it.each([
      ["a caller that is not the hosted MCP", { "x-test-direct": "1" }],
      ["a zero data retention team", { "x-test-zdr": "1" }],
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
        version: "1",
        expiresAt: expect.any(String),
      });
      expect([...objects.keys()]).toEqual([`workspaces/${TEAM_A}/${id}`]);

      const res = await read(TEAM_A, id);
      expect(res.status).toBe(200);
      expect(res.headers.etag).toBe('"1"');
      expect(res.body.toString()).toBe("files");
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

    it("saves over a version only when If-Match names the stored one", async () => {
      const id = await createId();
      expect(
        (await save(TEAM_A, id, "one").set("If-Match", '"0"')).body.data
          .version,
      ).toBe("1");
      expect(
        (await save(TEAM_A, id, "lost").set("If-Match", '"0"')).status,
      ).toBe(412);
      expect(
        (await save(TEAM_A, id, "lost").set("If-Match", "latest")).status,
      ).toBe(400);
      expect((await save(TEAM_A, id, "two")).body.data.version).toBe("2");
      expect((await read(TEAM_A, id)).body.toString()).toBe("two");
    });
  });

  describe("download links", () => {
    it("serves the file to anyone holding the link, as a download", async () => {
      const created = await link(await createId(), "a,b\n1,2\n", {
        filename: "../../quarterly report.csv",
      });
      expect(created.status).toBe(200);
      const { url, expiresAt, sizeBytes } = created.body.data;
      expect(url).toMatch(
        /^https:\/\/files\.test\/v2\/computer\/files\/[A-Za-z0-9_-]{43}\/quarterly_report\.csv$/,
      );
      expect(sizeBytes).toBe(8);
      const lifetimeMs = new Date(expiresAt).getTime() - Date.now();
      expect(lifetimeMs).toBeGreaterThan(14 * 60 * 1000);
      expect(lifetimeMs).toBeLessThanOrEqual(15 * 60 * 1000);

      for (const target of [url, url.slice(0, url.lastIndexOf("/"))]) {
        const res = await download(target);
        expect(res.status).toBe(200);
        expect(res.body.toString()).toBe("a,b\n1,2\n");
        expect(res.headers["content-type"]).toBe("application/octet-stream");
        expect(res.headers["content-disposition"]).toBe(
          'attachment; filename="quarterly_report.csv"',
        );
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
      }
    });

    it("stops serving a link once it expires", async () => {
      const created = await link(await createId(), "data", {
        filename: "a.txt",
        expiresInSeconds: 60,
      });
      expect((await download(created.body.data.url)).status).toBe(200);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
      expect((await download(created.body.data.url)).status).toBe(410);
    });

    it("never serves a stored file that records no expiry", async () => {
      const token = "t".repeat(43);
      objects.set(`links/${token}`, {
        bytes: Buffer.from("x"),
        version: 1,
        metadata: {},
      });
      expect(
        (await request(server).get(`/v2/computer/files/${token}`)).status,
      ).toBe(410);
    });

    it("finds nothing for an unknown token or a workspace path", async () => {
      const id = await createId();
      await save(TEAM_A, id, "files");
      for (const token of [
        "u".repeat(43),
        `workspaces%2F${TEAM_A}%2F${id}`,
        "short",
      ]) {
        expect(
          (await request(server).get(`/v2/computer/files/${token}`)).status,
        ).toBe(404);
      }
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
    url: config.COMPUTER_SESSION_FILES_PUBLIC_BASE_URL,
    redis: config.REDIS_RATE_LIMIT_URL,
  };
  afterAll(() => {
    config.GCS_COMPUTER_SESSION_FILES_BUCKET_NAME = original.bucket;
    config.COMPUTER_SESSION_FILES_PUBLIC_BASE_URL = original.url;
    config.REDIS_RATE_LIMIT_URL = original.redis;
  });

  it.each([
    [undefined, undefined],
    ["bucket", undefined],
    [undefined, "https://files.test"],
  ])("has no handlers with bucket %s and public URL %s", (bucket, url) => {
    config.GCS_COMPUTER_SESSION_FILES_BUCKET_NAME = bucket;
    config.COMPUTER_SESSION_FILES_PUBLIC_BASE_URL = url;
    expect(configuredComputerSessionFiles()).toBeNull();
  });

  it("has every handler, and a download limit per IP, with both set", async () => {
    config.GCS_COMPUTER_SESSION_FILES_BUCKET_NAME = "bucket";
    config.COMPUTER_SESSION_FILES_PUBLIC_BASE_URL = "https://files.test";
    // The limiter counts in memory, so the test needs no Redis.
    config.REDIS_RATE_LIMIT_URL = undefined;
    const handlers = configuredComputerSessionFiles();
    expect(Object.keys(handlers ?? {}).sort()).toEqual([
      "createLink",
      "createSession",
      "download",
      "downloadRateLimit",
      "readWorkspace",
      "saveWorkspace",
    ]);

    const limited = express();
    limited.get("/", handlers!.downloadRateLimit, (_req, res) => {
      res.sendStatus(204);
    });
    for (let call = 0; call < 60; call++) {
      expect((await request(limited).get("/")).status).toBe(204);
    }
    const refused = await request(limited).get("/");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
  });
});
