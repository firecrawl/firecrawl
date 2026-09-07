import express from "express";
import http from "node:http";
import { bullAuthRoute, createRequireBullAuth } from "../bull-auth";

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
    bullAuthRoute(key, "/redis-health"),
    createRequireBullAuth(key),
    (_req, res) => res.send("ok"),
  );
}

function mountQueues(app: express.Express, key: string) {
  const inner = express.Router();
  inner.get("/", (_req, res) => res.send("queues"));
  inner.get("/api/queues", (_req, res) => res.send("api-queues"));
  inner.get("/api/queues/:name/:id", (_req, res) =>
    res.send(`${_req.params.name}/${_req.params.id}`),
  );
  app.use(bullAuthRoute(key, "/queues"), createRequireBullAuth(key), inner);
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

  it("builds one param per key segment", () => {
    expect(bullAuthRoute("secret)oops", "/redis-health")).toBe(
      "/admin/:bullAuth0/redis-health",
    );
    expect(bullAuthRoute("abc/def", "/queues")).toBe(
      "/admin/:bullAuth0/:bullAuth1/queues",
    );
    expect(bullAuthRoute("a//b", "/queues")).toBe(
      "/admin/:bullAuth0//:bullAuth2/queues",
    );
    expect(bullAuthRoute("trail/", "/queues")).toBe(
      "/admin/:bullAuth0//queues",
    );
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
      expect(miss.text).toBe(JSON.stringify({ error: "Not found" }));
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

  it("forwards Bull Board sub-paths for a ) key", async () => {
    const key = "secret)oops";
    const app = express();
    mountQueues(app, key);
    const server = await listen(app);
    try {
      const shell = await get(server, `/admin/${key}/queues`);
      expect(shell.status).toBe(200);
      expect(shell.text).toBe("queues");
      const api = await get(server, `/admin/${key}/queues/api/queues`);
      expect(api.status).toBe(200);
      expect(api.text).toBe("api-queues");
      const item = await get(server, `/admin/${key}/queues/api/queues/q/1`);
      expect(item.status).toBe(200);
      expect(item.text).toBe("q/1");
      const miss = await get(server, "/admin/wrong/queues/api/queues");
      expect(miss.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("forwards Bull Board sub-paths for a key containing a slash", async () => {
    const key = "abc/def";
    const app = express();
    mountQueues(app, key);
    const server = await listen(app);
    try {
      const api = await get(server, `/admin/${key}/queues/api/queues`);
      expect(api.status).toBe(200);
      expect(api.text).toBe("api-queues");
      const item = await get(server, `/admin/${key}/queues/api/queues/q/1`);
      expect(item.status).toBe(200);
      expect(item.text).toBe("q/1");
      const miss = await get(server, "/admin/xxx/yyy/queues/api/queues");
      expect(miss.status).toBe(404);
      expect(miss.text).toBe(JSON.stringify({ error: "Not found" }));
    } finally {
      server.close();
    }
  });

  it("forwards Bull Board sub-paths for a key with empty segments", async () => {
    for (const key of ["a//b", "trail/"]) {
      const app = express();
      mountQueues(app, key);
      const server = await listen(app);
      try {
        const api = await get(server, `/admin/${key}/queues/api/queues`);
        expect(api.status).toBe(200);
        expect(api.text).toBe("api-queues");
        const item = await get(server, `/admin/${key}/queues/api/queues/q/1`);
        expect(item.status).toBe(200);
        expect(item.text).toBe("q/1");
      } finally {
        server.close();
      }
    }
  });
});
