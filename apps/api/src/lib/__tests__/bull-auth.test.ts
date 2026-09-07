import express from "express";
import http from "node:http";
import { createRequireBullAuth } from "../bull-auth";

function listen(app: express.Express): Promise<http.Server> {
  const server = http.createServer(app);
  return new Promise(resolve => {
    server.listen(0, () => resolve(server));
  });
}

async function get(server: http.Server, path: string) {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`);
  return { status: res.status, text: await res.text() };
}

function mountHealth(app: express.Express, key: string) {
  app.get(
    "/admin/*bullAuthKey/redis-health",
    createRequireBullAuth(key),
    (_req, res) => res.send("ok"),
  );
}

describe("createRequireBullAuth", () => {
  it("throws if the key is interpolated into the Express path", () => {
    const app = express();
    expect(() => {
      app.get("/admin/secret)oops/redis-health", (_req, res) => res.send("ok"));
    }).toThrow(/Unexpected \)/);
    expect(() => {
      app.use("/admin/secret)oops/queues", (_req, _res, next) => next());
    }).toThrow(/Unexpected \)/);
  });

  it("serves a key containing )", async () => {
    const key = "secret)oops";
    const app = express();
    mountHealth(app, key);
    const server = await listen(app);
    try {
      const hit = await get(server, `/admin/${key}/redis-health`);
      expect(hit.status).toBe(200);
      expect(hit.text).toBe("ok");
      const miss = await get(server, "/admin/wrong/redis-health");
      expect(miss.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("serves a key containing a slash, which a single-segment param would 404", async () => {
    const key = "abc/def";
    const app = express();
    mountHealth(app, key);
    const server = await listen(app);
    try {
      const hit = await get(server, `/admin/${key}/redis-health`);
      expect(hit.status).toBe(200);
      expect(hit.text).toBe("ok");
    } finally {
      server.close();
    }
  });

  it("serves a key containing braces", async () => {
    const key = "sec{ret}";
    const app = express();
    mountHealth(app, key);
    const server = await listen(app);
    try {
      const hit = await get(server, `/admin/${key}/redis-health`);
      expect(hit.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it("mounts a Bull Board-style prefix with a ) key", async () => {
    const key = "secret)oops";
    const app = express();
    const inner = express.Router();
    inner.get("/", (_req, res) => res.send("queues"));
    app.use("/admin/*bullAuthKey/queues", createRequireBullAuth(key), inner);
    const server = await listen(app);
    try {
      const hit = await get(server, `/admin/${key}/queues`);
      expect(hit.status).toBe(200);
      expect(hit.text).toBe("queues");
      const miss = await get(server, "/admin/wrong/queues");
      expect(miss.status).toBe(404);
    } finally {
      server.close();
    }
  });
});
