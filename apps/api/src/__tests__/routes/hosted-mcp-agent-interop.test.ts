const mocks = vi.hoisted(() => ({ authenticateUser: vi.fn() }));

vi.mock("../../config", async importOriginal => {
  const actual = await importOriginal<typeof import("../../config")>();
  return {
    ...actual,
    config: { ...actual.config, AGENT_INTEROP_SECRET: "agent-secret" },
  };
});
vi.mock("../../controllers/auth", () => ({
  authenticateUser: mocks.authenticateUser,
}));
vi.mock("ioredis", () => ({ default: class {} }));
vi.mock("../../services/redis", () => ({
  getValue: vi.fn(),
  setValue: vi.fn(),
  deleteKey: vi.fn(),
}));

import { authMiddleware } from "../../routes/shared";
import { RateLimiterMode } from "../../types";

async function authOf(
  body: Record<string, unknown>,
  verified: boolean,
  headers: Record<string, string> = {},
) {
  mocks.authenticateUser.mockResolvedValueOnce({
    success: true,
    team_id: "team-1",
    org_id: "org-1",
    chunk: null,
    ...(verified ? { hostedMcp: true } : {}),
  });
  const req: any = { body, headers };
  await new Promise<void>((resolve, reject) =>
    authMiddleware(RateLimiterMode.Scrape)(req, {} as any, (error?: unknown) =>
      error ? reject(error) : resolve(),
    ),
  );
  return req.auth;
}

const interop = (auth: string, hostedMcp?: boolean) => ({
  __agentInterop: {
    auth,
    requestId: "agent-run",
    shouldBill: true,
    ...(hostedMcp === undefined ? {} : { hostedMcp }),
  },
});

describe("hosted MCP signal on agent interop calls", () => {
  beforeEach(() => vi.clearAllMocks());

  it("carries a verified hosted MCP call through", async () => {
    expect(await authOf({}, true)).toMatchObject({ hostedMcp: true });
  });

  it("takes the signal from a trusted interop block", async () => {
    expect(await authOf(interop("agent-secret", true), false)).toMatchObject({
      agentInterop: "trusted",
      hostedMcp: true,
    });
  });

  it.each([
    ["an untrusted interop block", interop("wrong", true), {}],
    ["a trusted block that does not say so", interop("agent-secret"), {}],
    [
      "a trusted header with an untrusted block",
      interop("wrong", true),
      { "x-firecrawl-agent-interop": "agent-secret" },
    ],
    ["a bare flag without interop", { hostedMcp: true }, {}],
  ])("ignores %s", async (_, body, headers) => {
    expect(await authOf(body, false, headers)).not.toHaveProperty("hostedMcp");
  });
});
