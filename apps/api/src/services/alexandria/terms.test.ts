const mocks = vi.hoisted(() => ({ request: vi.fn(), mirror: vi.fn() }));
vi.mock("./client", () => ({ exchangeRequest: mocks.request }));
vi.mock("./access-record", () => ({ mirrorLedgerAcceptance: mocks.mirror }));
import { acceptProviderTerms } from "./terms";

const digest = "c".repeat(64);
const body = {
  provider: "benzinga",
  version: "C-1.0.0",
  digest,
  confirmed: true as const,
  agent: { name: "claude" },
};
const accept = () =>
  acceptProviderTerms({ teamId: "team", orgId: "org", apiKeyId: "42", body });
const exchange = (event: unknown) =>
  mocks.request.mockImplementation(async ({ path }: { path: string }) =>
    path.includes("requirements")
      ? {
          status: 200,
          body: {
            providers: [
              {
                provider: "benzinga",
                required: true,
                terms: {
                  key: "benzinga",
                  version: "C-1.0.0",
                  digest,
                  schedule: "C",
                },
              },
            ],
          },
        }
      : event,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mirror.mockResolvedValue({ outcome: "written", action: "insert" });
});

it("mirrors a ledger acceptance into the access record after the ledger confirms it", async () => {
  exchange({
    status: 201,
    body: { id: "event-1", occurred_at: "2026-09-25T12:00:00.000Z" },
  });
  expect(await accept()).toMatchObject({
    status: 200,
    body: { success: true },
  });
  expect(mocks.mirror).toHaveBeenCalledWith({
    teamId: "team",
    orgId: "org",
    termsKey: "benzinga",
    acceptance: {
      provider: "benzinga",
      version: "C-1.0.0",
      digest,
      acceptedAt: "2026-09-25T12:00:00.000Z",
      eventId: "event-1",
      apiKeyId: "42",
      actorType: "agent",
      surface: "api",
      agent: { name: "claude" },
    },
  });
});

it("writes no access record when the ledger did not accept", async () => {
  exchange({ status: 503, body: "down" });
  expect((await accept()).status).toBe(503);
  expect(mocks.mirror).not.toHaveBeenCalled();
});

it("still answers the accept when the access record could not be written", async () => {
  exchange({
    status: 201,
    body: { id: "event-1", occurred_at: "2026-09-25T12:00:00.000Z" },
  });
  mocks.mirror.mockResolvedValue({ outcome: "failed", reason: "db down" });
  expect(await accept()).toMatchObject({
    status: 200,
    body: { success: true },
  });
});
