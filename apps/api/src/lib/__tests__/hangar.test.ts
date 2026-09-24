import { vi } from "vitest";
import {
  createHangarBrowser,
  executeHangarBrowser,
  stopHangarBrowser,
  HangarError,
} from "../hangar";

vi.mock("../../config", () => ({
  config: { HANGAR_URL: "http://hangar.internal" },
}));

const browser = {
  id: "br_test",
  status: "running",
  cdp_url: "wss://hangar.example/cdp?token=cdp",
  view_url: "https://hangar.example/live#view",
  control_url: "https://hangar.example/live#control",
  playlist_url: "https://hangar.example/recordings/recording/index.m3u8",
  created_at: 100,
  ended_at: null,
  max_expires_at: 700,
};

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());
const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

it("uses an idempotency key and returns Hangar capability URLs unchanged", async () => {
  vi.mocked(fetch).mockResolvedValue(respond(browser, 201));
  expect(
    await createHangarBrowser("request-id", "team-id", {
      ttl: 600,
      activityTtl: 300,
      streamWebView: true,
      recordSession: true,
      profile: { name: "signed-in", saveChanges: false },
    }),
  ).toEqual(browser);
  expect(fetch).toHaveBeenCalledWith(
    "http://hangar.internal/v1/browsers?wait=30",
    expect.objectContaining({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "request-id",
      },
      body: JSON.stringify({
        owner: "team-id",
        max_lifetime_seconds: 600,
        idle_timeout_seconds: 300,
        live_view: { enabled: true, interactive: true },
        recording: { enabled: true },
        execution: { enabled: true },
        profile: { name: "signed-in", save_changes: false },
      }),
    }),
  );
});

it("waits for an accepted browser without dropping its creation links", async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(respond({ ...browser, status: "starting" }, 202))
    .mockResolvedValueOnce(respond({ id: browser.id, status: "running" }));
  expect(
    (
      await createHangarBrowser("request", "team", {
        ttl: 600,
        activityTtl: 300,
        streamWebView: false,
        recordSession: false,
      })
    ).cdp_url,
  ).toBe(browser.cdp_url);
  expect(vi.mocked(fetch).mock.calls[1][0]).toBe(
    "http://hangar.internal/v1/browsers/br_test?wait=30",
  );
});

it("does not retry profile conflicts", async () => {
  vi.mocked(fetch).mockResolvedValue(
    respond({ error: "profile is locked" }, 409),
  );
  await expect(
    createHangarBrowser("request", "team", {
      ttl: 600,
      activityTtl: 300,
      streamWebView: true,
      recordSession: true,
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("maps execution output and never retries a command", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    respond({
      stdout: "",
      stderr: "failed",
      result: "",
      exit_code: 1,
      killed: false,
      truncated: true,
    }),
  );
  expect(
    await executeHangarBrowser("br_test", {
      code: "throw Error()",
      language: "node",
      timeout: 30,
      origin: "api",
    }),
  ).toMatchObject({ exitCode: 1, truncated: true });
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual(
    { code: "throw Error()", language: "node", timeout: 30 },
  );
  vi.mocked(fetch).mockRejectedValueOnce(new Error("connection lost"));
  await expect(
    executeHangarBrowser("br_test", {
      code: "click()",
      language: "node",
      timeout: 30,
    }),
  ).rejects.toBeInstanceOf(HangarError);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("treats stop as asynchronous lifecycle acceptance", async () => {
  vi.mocked(fetch).mockResolvedValue(
    respond({ id: "br_test", status: "stopping" }, 202),
  );
  expect(await stopHangarBrowser("br_test")).toMatchObject({
    status: "stopping",
  });
  expect(fetch).toHaveBeenCalledWith(
    "http://hangar.internal/v1/browsers/br_test/stop",
    expect.objectContaining({ method: "POST" }),
  );
});
