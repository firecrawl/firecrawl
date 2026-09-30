import crypto from "crypto";
import request from "supertest";
import { config } from "../../../config";
import {
  ALLOW_TEST_SUITE_WEBSITE,
  TEST_SELF_HOST,
  TEST_SUITE_WEBSITE,
  TEST_API_URL,
  itIf,
} from "../lib";
import {
  Identity,
  idmux,
  browserCreateRaw,
  browserExecuteRaw,
  browserDeleteRaw,
  browserReplayRaw,
  browserReplayPageRaw,
  scrapeTimeout,
} from "./lib";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("Interact session replay", () => {
  let identity: Identity;
  let otherIdentity: Identity;

  beforeAll(async () => {
    identity = await idmux({
      name: "browser-replay",
      concurrency: 20,
      credits: 1_000_000,
    });
    otherIdentity = await idmux({
      name: "browser-replay-other",
      concurrency: 10,
      credits: 1_000_000,
    });
  }, 10000 + scrapeTimeout);

  const canRunReplayHappyPath =
    !TEST_SELF_HOST && ALLOW_TEST_SUITE_WEBSITE && !!config.HANGAR_URL;

  itIf(canRunReplayHappyPath)(
    "records a session and serves replay metadata + HLS playlist after destroy",
    async () => {
      let sessionId: string | null = null;

      try {
        const createResponse = await browserCreateRaw(
          { ttl: 120, activityTtl: 120, recordSession: true },
          identity,
        );
        expect(createResponse.statusCode).toBe(200);
        expect(createResponse.body.success).toBe(true);
        sessionId = createResponse.body.id as string;
        expect(createResponse.body.playlistUrl).toBeUndefined();

        expect(createResponse.body.cdpUrl).toMatch(/^wss?:\/\//);
        const readonlyView = new URL(createResponse.body.liveViewUrl);
        const interactiveView = new URL(
          createResponse.body.interactiveLiveViewUrl,
        );
        expect(readonlyView.pathname).toBe("/live");
        expect(interactiveView.origin + interactiveView.pathname).toBe(
          readonlyView.origin + readonlyView.pathname,
        );
        expect(readonlyView.hash).not.toBe("");
        expect(interactiveView.hash).not.toBe("");
        expect(interactiveView.hash).not.toBe(readonlyView.hash);

        // Generate on-screen activity so the screencast has frames to record.
        const executeResponse = await browserExecuteRaw(
          sessionId,
          {
            language: "node",
            timeout: 60,
            code: `
              await page.goto("${TEST_SUITE_WEBSITE}?testId=${crypto.randomUUID()}");
              console.log("navigated");
            `,
          },
          identity,
        );
        expect(executeResponse.statusCode).toBe(200);
        expect(executeResponse.body.success).toBe(true);

        // Wait past a segment boundary (10s) so at least one segment uploads.
        await sleep(15_000);
      } finally {
        if (sessionId) {
          const deleted = await browserDeleteRaw(sessionId, identity);
          expect(deleted.statusCode).toBe(200);
          expect(deleted.body.sessionDurationMs).toEqual(expect.any(Number));
          expect(deleted.body.creditsBilled).toEqual(expect.any(Number));
        }
      }

      // Replay must be available after the session is destroyed.
      let replayResponse = await browserReplayRaw(sessionId!, identity);
      for (let i = 0; i < 10 && replayResponse.statusCode === 404; i++) {
        await sleep(2000);
        replayResponse = await browserReplayRaw(sessionId!, identity);
      }

      expect(replayResponse.statusCode).toBe(200);
      expect(replayResponse.body.success).toBe(true);
      expect(replayResponse.body.pageCount).toBe(1);
      expect(replayResponse.body.pages).toEqual([
        {
          pageId: "0",
          url: `/v2/interact/${sessionId}/replay/0`,
          pageUrl: "",
          startTimeMs: 0,
          endTimeMs: expect.any(Number),
        },
      ]);
      expect(replayResponse.body.pages[0].endTimeMs).toBeGreaterThan(0);
      const legacyPlaylist = await browserReplayPageRaw(
        sessionId!,
        "0",
        identity,
      );
      expect(legacyPlaylist.statusCode).toBe(200);
      expect(legacyPlaylist.headers["content-type"]).toContain(
        "application/vnd.apple.mpegurl",
      );
      expect(legacyPlaylist.text).toContain("#EXTM3U");
      const segmentUrl = legacyPlaylist.text
        .split(/\r?\n/)
        .find((line: string) => line && !line.startsWith("#"));
      if (!segmentUrl) throw new Error("Recording has no video segments");
      expect(replayResponse.body.playlistUrl).toBeUndefined();
      expect((await fetch(segmentUrl)).status).toBe(200);
      expect(
        (await browserReplayPageRaw(sessionId!, "1", identity)).statusCode,
      ).toBe(404);
      expect(
        (await browserReplayPageRaw(sessionId!, "invalid", identity))
          .statusCode,
      ).toBe(400);
      const browserAlias = await request(TEST_API_URL)
        .get(`/v2/browser/${sessionId}/replay/0`)
        .set("Authorization", `Bearer ${identity.apiKey}`);
      expect(browserAlias.statusCode).toBe(200);
    },
    scrapeTimeout + 60_000,
  );

  itIf(!TEST_SELF_HOST && !!config.HANGAR_URL)(
    "returns 404 when the session does not exist",
    async () => {
      const response = await browserReplayRaw(crypto.randomUUID(), identity);

      expect(response.statusCode).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Browser session not found.");
    },
  );

  itIf(canRunReplayHappyPath && !!config.IDMUX_URL)(
    "returns 403 when the session belongs to another team",
    async () => {
      if (identity.teamId === otherIdentity.teamId) {
        return;
      }

      let sessionId: string | null = null;
      try {
        const createResponse = await browserCreateRaw(
          { ttl: 60, activityTtl: 60 },
          identity,
        );
        expect(createResponse.statusCode).toBe(200);
        sessionId = createResponse.body.id as string;

        const response = await browserReplayRaw(sessionId, otherIdentity);
        expect(response.statusCode).toBe(403);
        expect(response.body.success).toBe(false);
        expect(response.body.error).toBe("Forbidden.");
        expect(
          (await browserReplayPageRaw(sessionId, "0", otherIdentity))
            .statusCode,
        ).toBe(403);
      } finally {
        if (sessionId) {
          await browserDeleteRaw(sessionId, identity);
        }
      }
    },
    scrapeTimeout,
  );
  itIf(canRunReplayHappyPath)(
    "keeps viewer fields as strings when disabled and reports no replay",
    async () => {
      let sessionId: string | undefined;
      try {
        const created = await browserCreateRaw(
          {
            ttl: 120,
            activityTtl: 120,
            streamWebView: false,
            recordSession: false,
          },
          identity,
        );
        expect(created.statusCode).toBe(200);
        sessionId = created.body.id;
        expect(created.body.cdpUrl).toMatch(/^wss?:\/\//);
        expect(created.body.liveViewUrl).toBe("");
        expect(created.body.interactiveLiveViewUrl).toBe("");
        expect(created.body.playlistUrl).toBeUndefined();
        expect((await browserReplayRaw(sessionId!, identity)).statusCode).toBe(
          404,
        );
        expect(
          (await browserReplayPageRaw(sessionId!, "0", identity)).statusCode,
        ).toBe(404);
      } finally {
        if (sessionId) await browserDeleteRaw(sessionId, identity);
      }
    },
    scrapeTimeout,
  );

  itIf(!TEST_SELF_HOST && !!config.HANGAR_URL)(
    "persists profiles, excludes concurrent writers, and discards reader changes",
    async () => {
      const profile = {
        name: `snips-${crypto.randomUUID()}`,
        saveChanges: true,
      };
      const active = new Set<string>();
      const create = async (saveChanges: boolean) => {
        const response = await browserCreateRaw(
          {
            ttl: 300,
            activityTtl: 300,
            recordSession: false,
            streamWebView: false,
            profile: { ...profile, saveChanges },
          },
          identity,
        );
        expect(response.statusCode).toBe(200);
        active.add(response.body.id);
        return response.body.id as string;
      };
      const stop = async (id: string) => {
        expect((await browserDeleteRaw(id, identity)).statusCode).toBe(200);
        for (let attempt = 0; attempt < 90; attempt++) {
          const response = await request(TEST_API_URL)
            .get(`/v2/browser/${id}`)
            .set("Authorization", `Bearer ${identity.apiKey}`);
          expect(response.statusCode).toBe(200);
          if (response.body.status === "stopped") {
            expect(response.body.error).toBeUndefined();
            active.delete(id);
            return;
          }
          await sleep(1000);
        }
        throw new Error("Hangar did not stop the profile session");
      };
      try {
        const writer = await create(true);
        const conflict = await browserCreateRaw(
          { profile, recordSession: false },
          identity,
        );
        expect(conflict.statusCode).toBe(409);
        const readerDuringWrite = await create(false);
        await stop(readerDuringWrite);
        const written = await browserExecuteRaw(
          writer,
          {
            language: "node",
            code: `await context.addCookies([{name:'hangar-profile', value:'saved', domain:'example.com', path:'/', expires:Math.floor(Date.now()/1000)+3600}]);`,
          },
          identity,
        );
        expect(written.body.exitCode).toBe(0);
        await stop(writer);
        const reader = await create(false);
        const read = await browserExecuteRaw(
          reader,
          {
            code: `console.log((await context.cookies()).find(c => c.name === 'hangar-profile')?.value); await context.clearCookies();`,
          },
          identity,
        );
        expect(read.body.stdout).toContain("saved");
        await stop(reader);
        const next = await create(false);
        const unchanged = await browserExecuteRaw(
          next,
          {
            code: `console.log((await context.cookies()).find(c => c.name === 'hangar-profile')?.value);`,
          },
          identity,
        );
        expect(unchanged.body.stdout).toContain("saved");
        await stop(next);
      } finally {
        for (const id of active) await browserDeleteRaw(id, identity);
      }
    },
    scrapeTimeout + 300_000,
  );
});
