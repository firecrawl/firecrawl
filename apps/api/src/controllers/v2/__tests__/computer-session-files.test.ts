vi.mock("../../../services/rate-limiter", () => ({ redisRateLimitClient: {} }));
vi.mock("../../../lib/logger", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: { ...log, child: () => log } };
});

import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { config } from "../../../config";
import {
  MAX_FILE_BYTES,
  VersionMismatchError,
  computerSessionFileControllers,
  configuredComputerSessionFiles,
  type ComputerSessionFileStore,
} from "../computer-session-files";

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

const WORKSPACE = "/v2/computer/sessions/session-1/workspace";
const LINKS = "/v2/computer/sessions/session-1/links";
const app = express();
app.put(
  "/v2/computer/sessions/:sessionId/workspace",
  auth,
  run(controllers.saveWorkspace),
);
app.get(
  "/v2/computer/sessions/:sessionId/workspace",
  auth,
  run(controllers.readWorkspace),
);
app.post(
  "/v2/computer/sessions/:sessionId/links",
  auth,
  run(controllers.createLink),
);
app.get("/v2/computer/files/:token{/:filename}", run(controllers.download));

let server: http.Server;
beforeAll(() => {
  server = app.listen(0);
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  objects.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const save = (team: string, bytes: string, path = WORKSPACE) =>
  request(server)
    .put(path)
    .set("x-test-team", team)
    .type("application/octet-stream")
    .send(Buffer.from(bytes));
const read = (team: string) =>
  request(server).get(WORKSPACE).set("x-test-team", team).responseType("blob");
const link = (bytes: string, query: Record<string, string | number>) =>
  request(server)
    .post(LINKS)
    .query(query)
    .set("x-test-team", "team-a")
    .type("application/octet-stream")
    .send(Buffer.from(bytes));
const download = (url: string) =>
  request(server).get(new URL(url).pathname).responseType("blob");
/** The status of a save that only declares its body, so no test sends one over the limit. */
const declare = (headers: http.OutgoingHttpHeaders) =>
  new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        port: (server.address() as AddressInfo).port,
        method: "PUT",
        path: WORKSPACE,
        headers: {
          "x-test-team": "team-a",
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

describe("workspace", () => {
  it("reads back the bytes it saved", async () => {
    const saved = await save("team-a", "files");
    expect(saved.status).toBe(200);
    expect(saved.body.data).toEqual({ sizeBytes: 5, version: "1" });

    const res = await read("team-a");
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe('"1"');
    expect(res.body.toString()).toBe("files");
  });

  it("keeps one team's session from another team using the same session id", async () => {
    await save("team-a", "a-files");
    expect((await read("team-b")).status).toBe(404);

    await save("team-b", "b-files");
    expect((await read("team-a")).body.toString()).toBe("a-files");
    expect((await read("team-b")).body.toString()).toBe("b-files");
  });

  it.each([
    ["a caller that is not the hosted MCP", { "x-test-direct": "1" }],
    ["a zero data retention team", { "x-test-zdr": "1" }],
  ])("refuses %s on every session route", async (_name, headers) => {
    await save("team-a", "files");
    const calls = [
      request(server)
        .put(WORKSPACE)
        .type("application/octet-stream")
        .send(Buffer.from("x")),
      request(server).get(WORKSPACE),
      request(server)
        .post(LINKS)
        .query({ filename: "a.txt" })
        .type("application/octet-stream")
        .send(Buffer.from("x")),
    ];
    for (const call of calls) {
      const res = await call.set("x-test-team", "team-a").set(headers);
      expect(res.status).toBe(403);
    }
    expect([...objects.keys()]).toEqual(["workspaces/team-a/session-1"]);
    expect(objects.get("workspaces/team-a/session-1")?.bytes.toString()).toBe(
      "files",
    );
  });

  it.each(["a.b", "..%2Fteam-b%2Fsession-1", "x".repeat(129)])(
    "refuses the session id %s",
    async sessionId => {
      const res = await save(
        "team-a",
        "files",
        `/v2/computer/sessions/${sessionId}/workspace`,
      );
      expect(res.status).toBe(400);
      expect(objects.size).toBe(0);
    },
  );

  it("refuses a body over the limit, or of unknown size, before reading it", async () => {
    expect(await declare({ "content-length": MAX_FILE_BYTES + 1 })).toBe(413);
    expect(await declare({})).toBe(411);
    expect(
      await declare({
        "content-length": 1,
        "content-type": "application/json",
      }),
    ).toBe(415);
    expect(objects.size).toBe(0);
  });

  it("saves over a version only when If-Match names the stored one", async () => {
    expect((await save("team-a", "one").set("If-Match", '"0"')).status).toBe(
      200,
    );
    expect((await save("team-a", "lost").set("If-Match", '"0"')).status).toBe(
      412,
    );
    expect(
      (await save("team-a", "two").set("If-Match", '"1"')).body.data.version,
    ).toBe("2");
    expect((await save("team-a", "lost").set("If-Match", '"1"')).status).toBe(
      412,
    );
    expect(
      (await save("team-a", "lost").set("If-Match", "latest")).status,
    ).toBe(400);
    expect((await read("team-a")).body.toString()).toBe("two");
  });
});

describe("download links", () => {
  it("serves the file to anyone holding the link, as a download", async () => {
    const created = await link("a,b\n1,2\n", {
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
    const created = await link("data", {
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
    await save("team-a", "files");
    for (const token of [
      "u".repeat(43),
      "workspaces%2Fteam-a%2Fsession-1",
      "short",
    ]) {
      expect(
        (await request(server).get(`/v2/computer/files/${token}`)).status,
      ).toBe(404);
    }
  });

  it.each([
    ["no filename", {}],
    ["a lifetime over an hour", { filename: "a.txt", expiresInSeconds: 3601 }],
    ["a lifetime under a minute", { filename: "a.txt", expiresInSeconds: 5 }],
  ])("refuses a link with %s", async (_name, query) => {
    expect((await link("data", query)).status).toBe(400);
    expect(objects.size).toBe(0);
  });
});

describe("configuration", () => {
  const original = {
    bucket: config.GCS_COMPUTER_SESSION_FILES_BUCKET_NAME,
    url: config.COMPUTER_SESSION_FILES_PUBLIC_BASE_URL,
  };
  afterAll(() => {
    config.GCS_COMPUTER_SESSION_FILES_BUCKET_NAME = original.bucket;
    config.COMPUTER_SESSION_FILES_PUBLIC_BASE_URL = original.url;
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
});
