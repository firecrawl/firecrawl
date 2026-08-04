import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logRequest: vi.fn(),
  logSearch: vi.fn(),
  logResearchEndpoint: vi.fn(),
  fetchResearchUpstream: vi.fn(),
}));

vi.mock("../../../services/logging/log_job", () => ({
  logRequest: mocks.logRequest,
  logSearch: mocks.logSearch,
  logResearchEndpoint: mocks.logResearchEndpoint,
}));

vi.mock("../../../lib/research-upstream", () => ({
  fetchResearchUpstream: mocks.fetchResearchUpstream,
}));

vi.mock("../../../services/billing/credit_billing", () => ({
  billTeam: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { createDeveloperRouter } from "../research-proxy";
import { billTeam } from "../../../services/billing/credit_billing";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";

/** Lets the un-awaited controller (wrapped by `wrap`) and its `finally` run. */
const flush = () => new Promise(resolve => setImmediate(resolve));

/** Pulls the GET handler out of the router's stack for either mount shape. */
function developerHandler(options: { root?: boolean } = {}) {
  const router: any = createDeveloperRouter(options);
  const path = options.root ? "/" : "/search";
  const layer = router.stack.find(
    (l: any) => l.route?.path === path && l.route?.methods?.get,
  );
  return layer.route.stack[0].handle;
}

function makeReq(flags: Record<string, unknown> | null) {
  return {
    method: "GET",
    query: { query: "http client" },
    body: {},
    headers: {},
    auth: { team_id: TEAM_ID },
    acuc: flags === null ? undefined : { api_key_id: 7, flags },
  } as any;
}

function makeRes() {
  const res: any = {
    status: vi.fn(),
    json: vi.fn(),
    send: vi.fn(),
    end: vi.fn(),
    setHeader: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.send.mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logRequest.mockResolvedValue(undefined);
  mocks.logResearchEndpoint.mockResolvedValue(undefined);
  // The controller consumes this as a `fetch` Response: `.ok`, `.status`,
  // `.headers.get()` and `await .text()`. A plain body object makes
  // `.headers.get()` throw and the handler answer 502 from its catch block,
  // which would let these tests pass without ever serving a real response.
  // At least one result is required for the request to bill any credits.
  mocks.fetchResearchUpstream.mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () =>
      JSON.stringify({ success: true, results: [{ id: "repo-one" }] }),
  });
});

describe.each([
  { name: "/v2/search/developer", options: { root: true } },
  { name: "/v2/developer/search (compatibility mount)", options: {} },
])("developer endpoint access on $name", ({ options }) => {
  it("serves a team with no flags at all", async () => {
    const res = makeRes();
    await developerHandler(options)(makeReq({}), res);
    await flush();

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(mocks.fetchResearchUpstream).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    expect(billTeam).toHaveBeenCalled();
  });

  it("serves a keyless caller (no acuc at all)", async () => {
    const res = makeRes();
    await developerHandler(options)(makeReq(null), res);
    await flush();

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(mocks.fetchResearchUpstream).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    expect(billTeam).toHaveBeenCalled();
  });
});
