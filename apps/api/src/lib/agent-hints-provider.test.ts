import { createHash, createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { config } from "../config";
import {
  agentHintsProviderRequestsTotal,
  getProviderHints,
  mergeAgentHints,
  providerTeamId,
  type AgentHintsProviderContext,
} from "./agent-hints-provider";

type Handler = (
  body: any,
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void;

let handler: Handler;
let requests: { body: any; headers: http.IncomingHttpHeaders }[] = [];
let server: http.Server;
let providerUrl: string;
let teamCounter = 0;

function context(
  overrides: Partial<AgentHintsProviderContext> = {},
): AgentHintsProviderContext {
  return {
    teamId: `team-${++teamCounter}`,
    orgId: "org-1",
    apiKeyId: 42,
    endpoint: "scrape",
    surface: "mcp",
    keyless: false,
    ...overrides,
  };
}

function reply(status: number, payload: unknown): Handler {
  return (_body, _req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  };
}

async function counter(outcome: string): Promise<number> {
  const metric = await agentHintsProviderRequestsTotal.get();
  return metric.values.find(v => v.labels.outcome === outcome)?.value ?? 0;
}

async function settle(holder: { settled: boolean } | undefined) {
  await vi.waitFor(() => expect(holder?.settled).toBe(true));
}

describe("external agent hints provider", () => {
  const original = {
    url: config.AGENT_HINTS_PROVIDER_URL,
    secret: config.AGENT_HINTS_PROVIDER_SECRET,
    pseudonymKey: config.AGENT_HINTS_PROVIDER_PSEUDONYM_KEY,
    timeout: config.AGENT_HINTS_PROVIDER_TIMEOUT_MS,
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", chunk => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw);
        requests.push({ body, headers: req.headers });
        handler(body, req, res);
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    providerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/hints`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    config.AGENT_HINTS_PROVIDER_URL = original.url;
    config.AGENT_HINTS_PROVIDER_SECRET = original.secret;
    config.AGENT_HINTS_PROVIDER_PSEUDONYM_KEY = original.pseudonymKey;
    config.AGENT_HINTS_PROVIDER_TIMEOUT_MS = original.timeout;
  });

  beforeEach(() => {
    requests = [];
    handler = reply(200, {
      hints: [{ id: "h1", text: "Provider hint." }],
      ttl_seconds: 60,
    });
    config.AGENT_HINTS_PROVIDER_URL = providerUrl;
    config.AGENT_HINTS_PROVIDER_SECRET = undefined;
    config.AGENT_HINTS_PROVIDER_PSEUDONYM_KEY = undefined;
    config.AGENT_HINTS_PROVIDER_TIMEOUT_MS = 500;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is inert when no provider URL is configured", async () => {
    config.AGENT_HINTS_PROVIDER_URL = undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const disabledBefore = await counter("disabled");
    expect(getProviderHints(context())).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await counter("disabled")).toBe(disabledBefore + 1);
  });

  it("returns an unsettled holder immediately and fills it once the provider answers", async () => {
    const holder = getProviderHints(context());
    expect(holder).toEqual({ settled: false, hints: [], rules: [] });
    await settle(holder);
    expect(holder!.hints).toEqual([{ id: "h1", text: "Provider hint." }]);
  });

  it("sends exactly the contract fields and never the API key", async () => {
    config.AGENT_HINTS_PROVIDER_SECRET = "shared-secret";
    await settle(
      getProviderHints(
        context({ teamId: "team-contract", surface: "cli", keyless: true }),
      ),
    );
    expect(requests).toHaveLength(1);
    const { body, headers } = requests[0];
    expect(Object.keys(body).sort()).toEqual(
      [
        "api_key_id",
        "endpoint",
        "keyless",
        "org_id",
        "surface",
        "team_id",
        "version",
      ].sort(),
    );
    expect(body).toEqual({
      version: 2,
      team_id: "team-contract",
      org_id: "org-1",
      api_key_id: 42,
      endpoint: "scrape",
      surface: "cli",
      keyless: true,
    });
    expect(JSON.stringify(body)).not.toContain('api_key"');
    expect(headers.authorization).toBe("Bearer shared-secret");
  });

  it.each([
    {
      name: "keyed by the configured pseudonym key",
      pseudonymKey: "k".repeat(32),
      ip: "203.0.113.8",
    },
    {
      name: "keyed by a per-process key when none is configured",
      pseudonymKey: undefined,
      ip: "203.0.113.9",
    },
  ])(
    "never sends a raw keyless team ID or IP: pseudonym $name",
    async ({ pseudonymKey, ip }) => {
      config.AGENT_HINTS_PROVIDER_SECRET = "shared-secret";
      config.AGENT_HINTS_PROVIDER_PSEUDONYM_KEY = pseudonymKey;
      const teamId = `preview_keyless_${ip}`;
      await settle(
        getProviderHints(
          context({ teamId, orgId: null, apiKeyId: 0, keyless: true }),
        ),
      );
      expect(requests).toHaveLength(1);
      const { body } = requests[0];
      expect(body.team_id).toMatch(/^keyless_[0-9a-f]{64}$/);
      expect(body.keyless).toBe(true);
      for (const value of Object.values(body)) {
        expect(String(value)).not.toContain(ip);
        expect(String(value)).not.toContain("preview_keyless_");
      }
      expect(JSON.stringify(body)).not.toContain(ip);
      const guessable = [
        createHash("sha256").update(teamId).digest("hex"),
        createHmac("sha256", "shared-secret").update(teamId).digest("hex"),
      ];
      expect(guessable.map(d => `keyless_${d}`)).not.toContain(body.team_id);
      if (pseudonymKey) {
        expect(body.team_id).toBe(
          `keyless_${createHmac("sha256", pseudonymKey).update(teamId).digest("hex")}`,
        );
      }
    },
  );

  it("gives a keyless team the same pseudonym on every lookup", async () => {
    const teamId = "preview_keyless_198.51.100.4";
    await settle(
      getProviderHints(context({ teamId, endpoint: "scrape", keyless: true })),
    );
    await settle(
      getProviderHints(context({ teamId, endpoint: "search", keyless: true })),
    );
    expect(requests).toHaveLength(2);
    expect(requests[0].body.team_id).toBe(requests[1].body.team_id);
    expect(requests[0].body.team_id).toMatch(/^keyless_[0-9a-f]{64}$/);
  });

  it("sends account team IDs unchanged", () => {
    expect(providerTeamId("team-uuid")).toBe("team-uuid");
  });

  it("omits the authorization header when no secret is configured", async () => {
    await settle(getProviderHints(context()));
    expect(requests[0].headers.authorization).toBeUndefined();
  });

  it("serves later requests from cache and dedupes concurrent cold requests", async () => {
    const ctx = context();
    const first = getProviderHints(ctx);
    const concurrent = getProviderHints(ctx);
    expect(concurrent).toBe(first);
    await settle(first);
    const hitsBefore = await counter("hit");
    for (let i = 0; i < 5; i++) {
      expect(getProviderHints(ctx)).toBe(first);
    }
    expect(requests).toHaveLength(1);
    expect(await counter("hit")).toBe(hitsBefore + 5);
  });

  it("keys the cache by team, endpoint, and surface", async () => {
    const ctx = context();
    await settle(getProviderHints(ctx));
    await settle(getProviderHints({ ...ctx, endpoint: "search" }));
    await settle(getProviderHints({ ...ctx, surface: "api" }));
    expect(requests).toHaveLength(3);
  });

  it("refetches after the provider TTL expires", async () => {
    handler = reply(200, { hints: [], ttl_seconds: 5 });
    const ctx = context();
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    await settle(getProviderHints(ctx));
    now.mockReturnValue(start + 4_000);
    getProviderHints(ctx);
    expect(requests).toHaveLength(1);
    now.mockReturnValue(start + 6_000);
    await settle(getProviderHints(ctx));
    expect(requests).toHaveLength(2);
  });

  it("clamps the TTL to ten minutes", async () => {
    handler = reply(200, { hints: [], ttl_seconds: 86_400 });
    const ctx = context();
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    await settle(getProviderHints(ctx));
    now.mockReturnValue(start + 601_000);
    await settle(getProviderHints(ctx));
    expect(requests).toHaveLength(2);
  });

  it.each([
    {
      name: "a timeout",
      outcome: "timeout",
      handler: ((_b, _r, res) => {
        setTimeout(
          () =>
            reply(200, { hints: [{ id: "late", text: "Late." }] })(_b, _r, res),
          300,
        );
      }) as Handler,
    },
    { name: "a 500", outcome: "error", handler: reply(500, { hints: [] }) },
    { name: "a 204", outcome: "error", handler: reply(204, "") },
    { name: "invalid JSON", outcome: "error", handler: reply(200, "not json") },
    {
      name: "a body without a hints array",
      outcome: "error",
      handler: reply(200, { hints: "Provider hint." }),
    },
  ])(
    "fails open on $name with no hints and a 30s negative cache",
    async ({ outcome, handler: failing }) => {
      config.AGENT_HINTS_PROVIDER_TIMEOUT_MS = 50;
      handler = failing;
      const ctx = context();
      const before = await counter(outcome);
      const start = Date.now();
      const now = vi.spyOn(Date, "now").mockReturnValue(start);
      const holder = getProviderHints(ctx);
      await settle(holder);
      expect(holder!.hints).toEqual([]);
      expect(await counter(outcome)).toBe(before + 1);

      now.mockReturnValue(start + 29_000);
      expect(getProviderHints(ctx)).toBe(holder);
      now.mockReturnValue(start + 31_000);
      const refetched = getProviderHints(ctx);
      expect(refetched).not.toBe(holder);
      await settle(refetched);
    },
  );

  it.each([
    {
      name: "declared",
      handler: ((_b, _r, res) => {
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(1024 * 1024),
        });
        res.end();
      }) as Handler,
    },
    {
      name: "streamed",
      handler: ((_b, _r, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write(`{"hints":[{"id":"big","text":"${"x".repeat(80 * 1024)}`);
        res.end('"}]}');
      }) as Handler,
    },
  ])(
    "fails open on an oversized $name response body",
    async ({ handler: oversized }) => {
      handler = oversized;
      const before = await counter("error");
      const holder = getProviderHints(context());
      await settle(holder);
      expect(holder!.hints).toEqual([]);
      expect(await counter("error")).toBe(before + 1);
    },
  );

  it("fails open on a network error", async () => {
    config.AGENT_HINTS_PROVIDER_URL = "http://127.0.0.1:1/v1/hints";
    const before = await counter("error");
    const holder = getProviderHints(context());
    await settle(holder);
    expect(holder!.hints).toEqual([]);
    expect(await counter("error")).toBe(before + 1);
  });

  it("sanitises provider hints and ignores unknown fields", async () => {
    handler = reply(200, {
      hints: [
        { id: " ok ", text: "  Line one\nline two\u0007  ", extra: true },
        { id: "too-long", text: "x".repeat(501) },
        { id: "x".repeat(65), text: "Long id." },
        { id: "blank", text: "   " },
        { id: 7, text: "Numeric id." },
        "not an object",
        null,
        { id: "max", text: "y".repeat(500) },
      ],
      ttl_seconds: "soon",
      future_field: { anything: true },
    });
    const holder = getProviderHints(context());
    await settle(holder);
    expect(holder!.hints).toEqual([
      { id: "ok", text: "Line one line two" },
      { id: "max", text: "y".repeat(500) },
    ]);
  });

  it("parses a valid provider rule set and cleans rule text", async () => {
    handler = reply(200, {
      hints: [],
      rules: [
        {
          id: "r1",
          group: "g",
          when: [
            { signal: "endpoint", op: "eq", value: "scrape" },
            { signal: "page_status", op: "in", value: [404, 410] },
          ],
          text: "  Rule one {page_status}.\n",
        },
        { id: "no-when", text: "Always." },
      ],
      ttl_seconds: 60,
    });
    const holder = getProviderHints(context());
    await settle(holder);
    expect(holder!.rules).toEqual([
      {
        id: "r1",
        group: "g",
        when: [
          { signal: "endpoint", op: "eq", value: "scrape" },
          { signal: "page_status", op: "in", value: [404, 410] },
        ],
        text: "Rule one {page_status}.",
      },
      { id: "no-when", when: [], text: "Always." },
    ]);
  });

  it("treats a missing rules field as no rules", async () => {
    const holder = getProviderHints(context());
    await settle(holder);
    expect(holder!.hints).toEqual([{ id: "h1", text: "Provider hint." }]);
    expect(holder!.rules).toEqual([]);
  });

  it.each([
    ["a non-array rules field", { id: "r1" }],
    [
      "one rule with an unknown operator",
      [
        { id: "ok", when: [], text: "Fine." },
        {
          id: "bad-op",
          when: [{ signal: "endpoint", op: "matches", value: "s" }],
          text: "Bad.",
        },
      ],
    ],
    [
      "one rule with a string threshold",
      [
        {
          id: "bad-value",
          when: [{ signal: "remaining_credits", op: "lt", value: "100" }],
          text: "Bad.",
        },
      ],
    ],
    ["one rule with blank text", [{ id: "blank", when: [], text: "  " }]],
    ["a non-object rule", ["not a rule"]],
  ])(
    "treats %s as a failed lookup with a negative cache",
    async (_name, rules) => {
      handler = reply(200, {
        hints: [{ id: "h1", text: "Provider hint." }],
        rules,
        ttl_seconds: 60,
      });
      const before = await counter("error");
      const ctx = context();
      const holder = getProviderHints(ctx);
      await settle(holder);
      expect(holder!.hints).toEqual([]);
      expect(holder!.rules).toEqual([]);
      expect(await counter("error")).toBe(before + 1);
      expect(getProviderHints(ctx)).toBe(holder);
      expect(requests).toHaveLength(1);
    },
  );

  it("bounds the cache and evicts the oldest entry first", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ hints: [], ttl_seconds: 600 }), {
          status: 200,
        }),
    );
    const oldest = context({ teamId: "evict-oldest" });
    getProviderHints(oldest);
    for (let i = 0; i < 10_000; i++) {
      getProviderHints(context({ teamId: `evict-${i}` }));
    }
    const callsBefore = fetchSpy.mock.calls.length;
    getProviderHints(context({ teamId: "evict-9999" }));
    expect(fetchSpy.mock.calls.length).toBe(callsBefore);
    getProviderHints(oldest);
    expect(fetchSpy.mock.calls.length).toBe(callsBefore + 1);
  });
});

describe("mergeAgentHints", () => {
  const hint = (id: string, text = `${id} text`) => ({ id, text });

  it("returns deterministic hints unchanged when there are no provider hints", () => {
    const deterministic = ["a", "b"];
    expect(mergeAgentHints(deterministic, [])).toEqual({
      hints: ["a", "b"],
      providerHintIds: [],
    });
  });

  it("appends provider hints after deterministic ones", () => {
    expect(mergeAgentHints(["a"], [hint("p1"), hint("p2")])).toEqual({
      hints: ["a", "p1 text", "p2 text"],
      providerHintIds: ["p1", "p2"],
    });
  });

  it("caps provider hints at two", () => {
    expect(mergeAgentHints([], [hint("p1"), hint("p2"), hint("p3")])).toEqual({
      hints: ["p1 text", "p2 text"],
      providerHintIds: ["p1", "p2"],
    });
  });

  it("caps the total at three without dropping deterministic hints", () => {
    expect(mergeAgentHints(["a", "b"], [hint("p1"), hint("p2")])).toEqual({
      hints: ["a", "b", "p1 text"],
      providerHintIds: ["p1"],
    });
    expect(mergeAgentHints(["a", "b", "c", "d"], [hint("p1")])).toEqual({
      hints: ["a", "b", "c", "d"],
      providerHintIds: [],
    });
  });

  it("drops exact duplicates of deterministic and earlier provider hints", () => {
    expect(
      mergeAgentHints(
        ["a"],
        [hint("dup", "a"), hint("p1"), hint("p1-again", "p1 text"), hint("p2")],
      ),
    ).toEqual({
      hints: ["a", "p1 text", "p2 text"],
      providerHintIds: ["p1", "p2"],
    });
  });
});
