// Registers an already pushed guest image with Flare and moves the `deterministic-json` snapshot to it.
//   FLARE_API_KEY=... [FLARE_API_URL=...] [FLARE_REGISTRY_TOKEN=...] [FLARE_SNAPSHOT_FORCE=1] node apps/deterministic-json-guest/snapshot.mjs <image reference>
const source = process.argv[2];
if (!source)
  throw new Error(
    "usage: node apps/deterministic-json-guest/snapshot.mjs <image reference>",
  );
const key = process.env.FLARE_API_KEY;
if (!key) throw new Error("FLARE_API_KEY is required");

const api = (process.env.FLARE_API_URL || "https://api.flare.computer").replace(
  /\/+$/,
  "",
);
const name = "deterministic-json";
const resources = { vcpus: 1, memory_mb: 2048, disk_mb: 1024 };
const registry_auth = process.env.FLARE_REGISTRY_TOKEN
  ? { username: "x-access-token", password: process.env.FLARE_REGISTRY_TOKEN }
  : undefined;

async function request(
  base,
  path,
  { method = "GET", json, token = key, query = "" } = {},
) {
  const res = await fetch(base + path + query, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(json !== undefined && {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      }),
    },
    body: json !== undefined ? JSON.stringify(json) : undefined,
    signal: AbortSignal.timeout(90_000),
  });
  if (res.status === 404 && method === "GET") return undefined;
  if (!res.ok)
    throw new Error(
      `${method} ${path} failed: ${res.status} ${await res.text().catch(() => "")}`,
    );
  return res.status === 204 ? undefined : res.json();
}
const flare = (path, opts) => request(api, path, opts);

async function until(path, data, done, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (!done(data)) {
    if (data.status === "failed" || data.status === "stopped")
      throw new Error(
        `${path}: ${data.error ?? data.stop_reason ?? data.status}`,
      );
    if (Date.now() > deadline) throw new Error(`${path}: timed out`);
    data = { ...data, ...(await flare(path, { query: "?wait=30" })) };
  }
  return data;
}

const createSandbox = async (body) => {
  const sb = await flare("/v1/sandboxes", {
    method: "POST",
    json: body,
    query: "?wait=30",
  });
  return until(`/v1/sandboxes/${sb.id}`, sb, (s) => s.ready, 120);
};
const run = async (sb, cmd) => {
  const r = await request(
    sb.data_url.replace(/\/+$/, ""),
    `/v1/sandboxes/${sb.id}/exec`,
    {
      method: "POST",
      token: sb.token,
      json: { cmd, user: "node", timeout_s: 60 },
    },
  );
  if (r.exit_code !== 0)
    throw new Error(`${cmd.join(" ")} exited ${r.exit_code}: ${r.stderr}`);
  return r.stdout.trim();
};
const remove = (path) => flare(path, { method: "DELETE" });

const probe = [
  "node",
  "-e",
  "const { JSDOM } = require('/opt/node_modules/jsdom'); console.log(new JSDOM('<p>ok</p>').window.document.querySelector('p').textContent)",
];

const previous = await flare(`/v1/snapshots/${name}`);
let image = await flare("/v1/images", {
  method: "POST",
  json: { source, name, registry_auth },
  query: "?wait=30",
});
image = await until(
  `/v1/images/${image.id}`,
  image,
  (i) => i.status === "ready",
  600,
);
console.log(`image ${image.id}`);
const same =
  previous?.image === image.id &&
  Object.entries(resources).every(([k, v]) => previous.resources[k] === v);
if (same && !process.env.FLARE_SNAPSHOT_FORCE) {
  console.log(`${name} already snapshots ${image.id}`);
  process.exit(0);
}

const base = await createSandbox({
  image: image.id,
  cmd: [],
  resources,
  timeout_s: 600,
});
await run(base, probe);
let snap = await flare(`/v1/sandboxes/${base.id}/snapshots`, {
  method: "POST",
  json: { name, labels: { source } },
  query: "?wait=30",
});
snap = await until(
  `/v1/snapshots/${snap.id}`,
  snap,
  (s) => s.status === "ready",
  300,
);
await remove(`/v1/sandboxes/${base.id}`);
console.log(`snapshot ${snap.id}`);

const fork = await createSandbox({
  snapshot: snap.id,
  network: { egress: "none" },
  timeout_s: 120,
});
const loaded = await run(fork, probe);
const net = await run(fork, [
  "node",
  "-e",
  "fetch('https://example.com', { signal: AbortSignal.timeout(5000) }).then(() => console.log('reached'), () => console.log('blocked'))",
]);
await remove(`/v1/sandboxes/${fork.id}`);
if (loaded !== "ok") throw new Error("fork could not load jsdom");
if (net !== "blocked")
  throw new Error(`fork egress: expected blocked, got ${net}`);
console.log(`fork ${fork.id} verified`);

if (previous && previous.id !== snap.id) {
  await remove(`/v1/snapshots/${previous.id}`);
  if (previous.image && previous.image !== image.id)
    await remove(`/v1/images/${previous.image}`);
  console.log(`deleted ${previous.id}`);
}
