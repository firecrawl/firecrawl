import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DocumentFetchProxyError,
  DocumentPrefetchFailed,
  NoEnginesLeftError,
  PDFFetchProxyError,
  PDFPrefetchFailed,
} from "../scraper/scrapeURL/error";
import {
  defaultModules,
  directWebhooks,
  logsMessages,
  memoryUploads,
  noBlocklist,
  noLimits,
  openAuth,
  queueJobStore,
  redisIdempotency,
  unmeteredBilling,
  unrestrictedPolicy,
} from "./defaults";
import { currentLimits, resolveJobPriority } from "../lib/limits";
import type {
  AuthModule,
  BillingModule,
  BlocklistModule,
  IdempotencyModule,
  JobStoreModule,
  LimitsModule,
  MessagesModule,
  UploadsModule,
  WebhooksModule,
} from "./modules";
import { createService, replaceService } from "./service";
import type { CoreParts } from "./service";
import { testService, withService } from "./testing";

const parts: CoreParts = { core: { name: "core" }, logger: { error: vi.fn() } };

afterEach(() => {
  replaceService(undefined);
});

describe("noLimits", () => {
  it("returns unlimited concurrency, base priority, and no queue backend override", async () => {
    const limits = noLimits();
    const ctx = { teamId: "team-1", zeroDataRetention: false };

    await expect(limits.concurrency(ctx)).resolves.toBeNull();
    await expect(limits.teamConcurrency("team-1")).resolves.toBeNull();
    expect(limits.keyConcurrency).toBeUndefined();
    await expect(limits.jobPriority({ ctx, base: 10 })).resolves.toBe(10);
    await expect(limits.jobPriority({ ctx, base: 21 })).resolves.toBe(21);
    expect(limits.queueBackend(ctx)).toBeUndefined();
  });
});

describe("logsMessages", () => {
  it("returns local log and config guidance for every message", () => {
    const messages = logsMessages();

    expect(messages.errorContact()).toBe(
      "An error occurred. Please check your logs for more details.",
    );
    expect(messages.errorContact("err-123")).toBe(
      "An error occurred. Please check your logs for more details. Error ID: err-123",
    );
    expect(messages.restrictedCountryContact()).toBe(
      "Please check your server configuration.",
    );
    expect(messages.allEnginesFailedContact()).toBe(
      "Check your server logs for more detailed error information from each engine.",
    );
    expect(messages.fileFetchProxyError("PDF")).toBe(
      "Failed to download the PDF file because the configured proxy could not establish a connection to the website (the proxy rejected the tunneling request). Check your proxy configuration (PROXY_SERVER) and whether the target site is reachable from it, then retry.",
    );
    expect(messages.fileFetchProxyError("document")).toBe(
      "Failed to download the document file because the configured proxy could not establish a connection to the website (the proxy rejected the tunneling request). Check your proxy configuration (PROXY_SERVER) and whether the target site is reachable from it, then retry.",
    );
    expect(messages.filePrefetchFailedContact()).toBe(
      "Check your server logs for more details about the specific protection mechanism encountered.",
    );
  });
});

describe("memoryUploads", () => {
  it("prepares, commits, receives, reads, and deletes uploads", async () => {
    const uploads = memoryUploads();
    const driver = uploads.driver();
    expect(driver.name).toBe("local");

    const expiresAt = Date.now() + 60_000;
    const prepared = await driver.prepareUpload({
      uploadId: "upload-1",
      teamId: "team-1",
      objectPath: "parse-uploads/team-1/upload-1/sample.html",
      filename: "sample.html",
      contentType: "text/html",
      expiresAt,
      maxBytes: 1024,
      uploadRef: "signed.ref+1",
      publicBaseUrl: "http://localhost:3002/",
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error("expected prepared upload");
    }
    expect(prepared.target).toEqual({
      uploadUrl:
        "http://localhost:3002/v2/parse/upload/upload-1?uploadRef=signed.ref%2B1",
      method: "PUT",
      headers: { "Content-Type": "text/html" },
    });

    // Not stored until commit() runs.
    const beforeCommit = await driver.receiveUpload!({
      uploadId: "upload-1",
      teamId: "team-1",
      body: Buffer.from("<p>hi</p>"),
    });
    expect(beforeCommit).toEqual({
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      error: "Upload URL not found or expired.",
    });

    await prepared.commit?.();

    const wrongTeam = await driver.receiveUpload!({
      uploadId: "upload-1",
      teamId: "team-2",
      body: Buffer.from("<p>hi</p>"),
    });
    expect(wrongTeam.ok).toBe(false);
    if (!wrongTeam.ok) {
      expect(wrongTeam.status).toBe(404);
    }

    const tooLarge = await driver.receiveUpload!({
      uploadId: "upload-1",
      teamId: "team-1",
      body: Buffer.alloc(1025, 1),
    });
    expect(tooLarge).toEqual({
      ok: false,
      status: 400,
      code: "BAD_REQUEST",
      error: "Uploaded file exceeds maximum size of 50MB.",
    });

    // Reading before body upload fails.
    const ref = {
      uploadId: "upload-1",
      teamId: "team-1",
      objectPath: "parse-uploads/team-1/upload-1/sample.html",
      maxBytes: 1024,
    };
    await expect(driver.read(ref)).rejects.toThrow(
      "Uploaded file is not available. Upload the file before parsing.",
    );

    const stored = await driver.receiveUpload!({
      uploadId: "upload-1",
      teamId: "team-1",
      body: Buffer.from("<p>hello</p>"),
    });
    expect(stored).toEqual({ ok: true });

    const data = await driver.read(ref);
    expect(data.toString("utf8")).toBe("<p>hello</p>");

    await expect(driver.read({ ...ref, teamId: "team-2" })).rejects.toThrow(
      "Uploaded file is not available",
    );
    await expect(driver.read({ ...ref, maxBytes: 4 })).rejects.toThrow(
      "Uploaded file exceeds maximum size of 50MB.",
    );

    await driver.delete(ref);
    await expect(driver.read(ref)).rejects.toThrow(
      "Uploaded file is not available",
    );
    await expect(driver.delete(ref)).resolves.toBeUndefined();
  });

  it("evicts expired uploads and defaults missing contentType", async () => {
    const driver = memoryUploads().driver();
    const prepared = await driver.prepareUpload({
      uploadId: "expired-1",
      teamId: "team-1",
      objectPath: "parse-uploads/team-1/expired-1/file.pdf",
      filename: "file.pdf",
      expiresAt: Date.now() - 1000,
      maxBytes: 1024,
      uploadRef: "ref",
      publicBaseUrl: "http://localhost:3002",
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error("expected prepared upload");
    }
    expect(prepared.target.headers).toEqual({
      "Content-Type": "application/octet-stream",
    });

    await prepared.commit?.();
    const received = await driver.receiveUpload!({
      uploadId: "expired-1",
      teamId: "team-1",
      body: Buffer.from("pdf"),
    });
    expect(received.ok).toBe(false);
    if (!received.ok) {
      expect(received.status).toBe(404);
    }
  });
});

describe("noBlocklist", () => {
  it("initializes as a no-op, allows every URL, and reports no scoped rules", async () => {
    const blocklist = noBlocklist();
    const ctx = { teamId: "team-1", zeroDataRetention: false };

    await expect(blocklist.init()).resolves.toBeUndefined();
    expect(blocklist.isBlocked("https://example.com/page", ctx)).toBe(false);
    expect(
      blocklist.isBlocked("https://example.com/page", ctx, {
        origin: "api",
        record: true,
      }),
    ).toBe(false);
    expect(blocklist.hasScopedRules(ctx)).toBe(false);
  });
});

describe("openAuth", () => {
  it("admits requests under the bypass team by default and returns fresh caller objects", async () => {
    const auth = openAuth();
    const first = await auth.authenticate(express.request, { kind: "scrape" });
    const second = await auth.authenticate(express.request, { kind: "crawl" });

    expect(first).toEqual({ ok: true, caller: { teamId: "bypass" } });
    expect(second).toEqual({ ok: true, caller: { teamId: "bypass" } });
    if (first.ok && second.ok) {
      expect(first.caller).not.toBe(second.caller);
    }
  });

  it("uses the supplied team id", async () => {
    const auth = openAuth("local-team");
    const result = await auth.authenticate(express.request, { kind: "map" });

    expect(result).toEqual({ ok: true, caller: { teamId: "local-team" } });
  });
});

describe("redisIdempotency", () => {
  it("claims team-scoped keys with the default 24h TTL and rejects duplicates", async () => {
    const seen = new Map<string, number>();
    const idempotency = redisIdempotency({
      setIfAbsent: async (key, ttlSeconds) => {
        if (seen.has(key)) {
          return false;
        }
        seen.set(key, ttlSeconds);
        return true;
      },
    });

    await expect(idempotency.claim("k1", { teamId: "team-a" })).resolves.toBe(
      true,
    );
    await expect(idempotency.claim("k1", { teamId: "team-a" })).resolves.toBe(
      false,
    );
    await expect(idempotency.claim("k1", { teamId: "team-b" })).resolves.toBe(
      true,
    );
    expect(seen.get("idempotency:team-a:k1")).toBe(86_400);
    expect(seen.get("idempotency:team-b:k1")).toBe(86_400);
  });

  it("supports a custom TTL and rejects invalid options", async () => {
    const calls: Array<{ key: string; ttlSeconds: number }> = [];
    const idempotency = redisIdempotency({
      ttlSeconds: 120,
      setIfAbsent: async (key, ttlSeconds) => {
        calls.push({ key, ttlSeconds });
        return true;
      },
    });

    await expect(idempotency.claim("k2", { teamId: "team-a" })).resolves.toBe(
      true,
    );
    expect(calls).toEqual([{ key: "idempotency:team-a:k2", ttlSeconds: 120 }]);

    expect(() => redisIdempotency({ ttlSeconds: 0 })).toThrow(
      "Invalid idempotency ttlSeconds",
    );
    expect(() => redisIdempotency({ ttlSeconds: -5 })).toThrow(
      "Invalid idempotency ttlSeconds",
    );
    expect(() => redisIdempotency({ ttlSeconds: 1.5 })).toThrow(
      "Invalid idempotency ttlSeconds",
    );
    expect(() =>
      redisIdempotency({
        // @ts-expect-error: verifying runtime rejection of non-function setIfAbsent
        setIfAbsent: "not-a-function",
      }),
    ).toThrow("Invalid idempotency setIfAbsent");
  });
});

describe("directWebhooks", () => {
  it("resolves static, undefined, and lazy secrets and delivers in-process", async () => {
    const withStatic = directWebhooks({ secret: "hmac-1" });
    const withUndefined = directWebhooks({ secret: undefined });
    let dynamicSecret: string | undefined = "hmac-2";
    const withFn = directWebhooks({ secret: () => dynamicSecret });
    const ctx = { teamId: "team-1", zeroDataRetention: false };

    await expect(withStatic.signingSecret(ctx)).resolves.toBe("hmac-1");
    await expect(withUndefined.signingSecret(ctx)).resolves.toBeUndefined();
    await expect(withFn.signingSecret(ctx)).resolves.toBe("hmac-2");
    dynamicSecret = "hmac-3";
    await expect(withFn.signingSecret(ctx)).resolves.toBe("hmac-3");

    const send = vi.fn(async () => ({ ok: true, status: 202 }));
    const result = await withStatic.deliver(
      ctx,
      {
        url: "https://example.com/hook",
        event: "crawl.completed",
        payload: { success: true },
        headers: {},
        jobId: "job-1",
        timeoutMs: 10_000,
      },
      send,
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      delivered: true,
      queued: false,
      statusCode: 202,
    });

    expect(() =>
      // @ts-expect-error: verifying runtime rejection of non-string secret
      directWebhooks({ secret: 123 }),
    ).toThrow("Invalid webhooks secret");
  });

  it("propagates send errors from direct delivery", async () => {
    const webhooks = directWebhooks({ secret: undefined });
    await expect(
      webhooks.deliver(
        { teamId: "team-1", zeroDataRetention: false },
        {
          url: "https://example.com/hook",
          event: "crawl.completed",
          payload: {},
          headers: {},
          jobId: "job-1",
          timeoutMs: 10_000,
        },
        async () => {
          throw new Error("network error");
        },
      ),
    ).rejects.toThrow("network error");
  });
});

describe("service module slots", () => {
  it("fills omitted module slots with built-in defaults", async () => {
    const built = createService({}, parts);
    const ctx = { teamId: "team-1", zeroDataRetention: false };

    expect(Object.isFrozen(built.modules)).toBe(true);
    expect(Object.isFrozen(built.modules.auth)).toBe(true);
    expect(Object.isFrozen(built.modules.billing)).toBe(true);
    expect(Object.isFrozen(built.modules.blocklist)).toBe(true);
    expect(Object.isFrozen(built.modules.limits)).toBe(true);
    expect(Object.isFrozen(built.modules.messages)).toBe(true);
    expect(Object.isFrozen(built.modules.policy)).toBe(true);
    expect(Object.isFrozen(built.modules.uploads)).toBe(true);
    expect(Object.isFrozen(built.modules.uploads.driver())).toBe(true);
    expect(Object.isFrozen(built.modules.jobStore)).toBe(true);
    expect(Object.isFrozen(built.modules.idempotency)).toBe(true);
    expect(Object.isFrozen(built.modules.webhooks)).toBe(true);
    expect(built.describe().modules).toEqual([
      "auth",
      "billing",
      "blocklist",
      "idempotency",
      "jobStore",
      "limits",
      "messages",
      "policy",
      "uploads",
      "webhooks",
    ]);
    await expect(
      built.modules.auth.authenticate(express.request, { kind: "scrape" }),
    ).resolves.toEqual({ ok: true, caller: { teamId: "bypass" } });
    await expect(
      built.modules.billing.authorize({
        caller: { teamId: "t1" },
        operation: "scrape",
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      built.modules.billing.charge({
        kind: "map",
        ctx: { teamId: "t1", zeroDataRetention: false },
        requestId: "map-1",
        urls: 5,
      }),
    ).resolves.toBeUndefined();
    expect(built.modules.blocklist.isBlocked("https://example.com", ctx)).toBe(
      false,
    );
    await expect(built.modules.limits.concurrency(ctx)).resolves.toBeNull();
    await expect(
      built.modules.limits.teamConcurrency("team-1"),
    ).resolves.toBeNull();
    await expect(
      built.modules.limits.jobPriority({ ctx, base: 15 }),
    ).resolves.toBe(15);
    expect(built.modules.limits.queueBackend(ctx)).toBeUndefined();
    expect(built.modules.messages.errorContact()).toBe(
      logsMessages().errorContact(),
    );
    expect(built.modules.uploads.driver().name).toBe("local");
    expect(built.modules.jobStore.storesResultsExternally?.()).toBe(false);
  });

  it("keeps defaults for unspecified slots and snapshots provided modules and drivers", async () => {
    const customAuth: AuthModule = {
      authenticate: async () => ({
        ok: true,
        caller: { teamId: "custom-team" },
      }),
    };
    const customBilling: BillingModule = {
      authorize: async () => ({ ok: true, maxUnits: 12 }),
      charge: async () => 3,
      settle: async () => {},
    };
    const initSpy = vi.fn(async () => {});
    const customBlocklist: BlocklistModule = {
      init: initSpy,
      isBlocked: url => url.includes("blocked.example"),
      hasScopedRules: ctx => ctx.teamId === "scoped-team",
    };
    const customLimits: LimitsModule = {
      concurrency: async () => 25,
      teamConcurrency: async () => 20,
      keyConcurrency: async () => ({ id: "7", limit: 5 }),
      jobPriority: async ({ base }) => base + 3,
      queueBackend: () => "fdb",
    };
    const customMessages: MessagesModule = {
      ...logsMessages(),
      errorContact: id => `custom:${id ?? "none"}`,
    };
    const customDriver = {
      name: "custom",
      prepareUpload: async () => ({
        ok: false as const,
        status: 503 as const,
        code: "PARSE_UPLOAD_STORAGE_DISABLED" as const,
        error: "disabled",
      }),
      read: async () => Buffer.from("original"),
      delete: async () => {},
    };
    const customUploads: UploadsModule = { driver: () => customDriver };
    const customJobStore: JobStoreModule = {
      ...queueJobStore(),
      storesResultsExternally: () => true,
      usage: async () => 42,
    };
    const customIdempotency: IdempotencyModule = {
      claim: async key => key === "allow",
    };
    const shutdownSpy = vi.fn(async () => {});
    const customWebhooks: WebhooksModule = {
      signingSecret: async () => "original-secret",
      deliver: async () => ({ delivered: false, queued: true }),
      shutdown: shutdownSpy,
    };
    const built = createService(
      {
        modules: {
          auth: customAuth,
          billing: customBilling,
          blocklist: customBlocklist,
          limits: customLimits,
          messages: customMessages,
          uploads: customUploads,
          jobStore: customJobStore,
          idempotency: customIdempotency,
          webhooks: customWebhooks,
        },
      },
      parts,
    );

    customAuth.authenticate = async () => ({
      ok: true,
      caller: { teamId: "mutated" },
    });
    customBilling.authorize = async () => ({
      ok: false,
      refusal: { status: 402, body: { success: false, error: "mutated" } },
    });
    customBilling.charge = async () => 999;
    customBlocklist.init = async () => {
      throw new Error("mutated");
    };
    customBlocklist.isBlocked = () => false;
    customBlocklist.hasScopedRules = () => false;
    customLimits.concurrency = async () => 999;
    customLimits.keyConcurrency = async () => ({ id: "mutated", limit: 1 });
    customMessages.errorContact = () => "mutated";
    customDriver.read = async () => Buffer.from("mutated");
    customUploads.driver = () => ({
      ...customDriver,
      name: "mutated",
    });
    customJobStore.usage = async () => 999;
    customJobStore.storesResultsExternally = () => false;
    customIdempotency.claim = async () => false;
    customWebhooks.signingSecret = async () => "mutated-secret";
    customWebhooks.deliver = async () => ({ delivered: true, queued: false });
    customWebhooks.shutdown = async () => {
      throw new Error("mutated shutdown");
    };

    await expect(built.modules.blocklist.init()).resolves.toBeUndefined();
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(
      built.modules.blocklist.isBlocked("https://blocked.example/path", {
        teamId: "team-1",
        zeroDataRetention: false,
      }),
    ).toBe(true);
    expect(
      built.modules.blocklist.hasScopedRules({
        teamId: "scoped-team",
        zeroDataRetention: false,
      }),
    ).toBe(true);
    const ctx = { teamId: "team-1", zeroDataRetention: false };
    await expect(built.modules.limits.concurrency(ctx)).resolves.toBe(25);
    await expect(built.modules.limits.teamConcurrency("team-1")).resolves.toBe(
      20,
    );
    await expect(built.modules.limits.keyConcurrency!(ctx)).resolves.toEqual({
      id: "7",
      limit: 5,
    });
    await expect(
      built.modules.limits.jobPriority({ ctx, base: 10 }),
    ).resolves.toBe(13);
    expect(built.modules.limits.queueBackend(ctx)).toBe("fdb");
    await expect(
      built.modules.auth.authenticate(express.request, { kind: "scrape" }),
    ).resolves.toEqual({ ok: true, caller: { teamId: "custom-team" } });
    await expect(
      built.modules.billing.authorize({
        caller: { teamId: "t1" },
        operation: "crawl",
      }),
    ).resolves.toEqual({ ok: true, maxUnits: 12 });
    await expect(
      built.modules.billing.charge({
        kind: "map",
        ctx: { teamId: "t1", zeroDataRetention: false },
        requestId: "m1",
        urls: 2,
      }),
    ).resolves.toBe(3);
    expect(built.modules.messages.errorContact("42")).toBe("custom:42");
    expect(built.modules.uploads.driver().name).toBe("custom");
    expect(built.modules.jobStore.storesResultsExternally?.()).toBe(true);
    expect(await built.modules.jobStore.usage("req-1")).toBe(42);
    const data = await built.modules.uploads.driver().read({
      uploadId: "u1",
      teamId: "t1",
      objectPath: "p1",
      maxBytes: 100,
    });
    expect(data.toString("utf8")).toBe("original");
    await expect(
      built.modules.idempotency.claim("allow", { teamId: "t1" }),
    ).resolves.toBe(true);
    await expect(
      built.modules.webhooks.signingSecret({
        teamId: "t1",
        zeroDataRetention: false,
      }),
    ).resolves.toBe("original-secret");
    await expect(
      built.modules.webhooks.deliver(
        { teamId: "t1", zeroDataRetention: false },
        {
          url: "https://example.com/hook",
          event: "crawl.completed",
          payload: {},
          headers: {},
          jobId: "j1",
          timeoutMs: 10_000,
        },
        async () => ({ ok: true, status: 200 }),
      ),
    ).resolves.toEqual({ delivered: false, queued: true });
    await built.modules.webhooks.shutdown?.();
    expect(shutdownSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid, null, or unknown module slots and malformed upload drivers at service creation", () => {
    expect(() =>
      createService(
        {
          modules: {
            // @ts-expect-error: verifying runtime rejection of empty auth module
            auth: {},
          },
        },
        parts,
      ),
    ).toThrow("Invalid auth module");
    expect(() =>
      createService(
        {
          modules: {
            // @ts-expect-error: verifying runtime rejection of null auth module
            auth: null,
          },
        },
        parts,
      ),
    ).toThrow("Invalid auth module");
    expect(() =>
      createService(
        {
          modules: {
            // @ts-expect-error: verifying runtime rejection of empty blocklist module
            blocklist: {},
          },
        },
        parts,
      ),
    ).toThrow("Invalid blocklist module");
    expect(() =>
      createService(
        {
          modules: {
            // @ts-expect-error: verifying runtime rejection of null blocklist module
            blocklist: null,
          },
        },
        parts,
      ),
    ).toThrow("Invalid blocklist module");
    expect(() =>
      createService(
        {
          modules: {
            // @ts-expect-error: verifying runtime rejection of incomplete blocklist module
            blocklist: {
              init: async () => {},
              isBlocked: () => false,
            },
          },
        },
        parts,
      ),
    ).toThrow("Invalid blocklist module");
    expect(() =>
      createService(
        {
          modules: {
            // @ts-expect-error: verifying runtime rejection of empty limits module
            limits: {},
          },
        },
        parts,
      ),
    ).toThrow("Invalid limits module");
    expect(() =>
      createService(
        {
          modules: {
            // @ts-expect-error: verifying runtime rejection of null limits module
            limits: null,
          },
        },
        parts,
      ),
    ).toThrow("Invalid limits module");
    expect(() =>
      createService(
        {
          modules: {
            limits: {
              ...noLimits(),
              // @ts-expect-error: verifying runtime rejection of non-function keyConcurrency
              keyConcurrency: "not-a-function",
            },
          },
        },
        parts,
      ),
    ).toThrow("Invalid limits module");
    expect(() =>
      createService(
        {
          modules: {
            // @ts-expect-error: verifying runtime rejection of empty billing module
            billing: {},
          },
        },
        parts,
      ),
    ).toThrow("Invalid billing module");
    expect(() =>
      createService(
        {
          modules: {
            // @ts-expect-error: verifying runtime rejection of null billing module
            billing: null,
          },
        },
        parts,
      ),
    ).toThrow("Invalid billing module");
    expect(() =>
      createService(
        {
          modules: {
            billing: {
              ...unmeteredBilling(),
              // @ts-expect-error: verifying runtime rejection of non-function settle
              settle: "not-a-function",
            },
          },
        },
        parts,
      ),
    ).toThrow("Invalid billing module");
    expect(() =>
      createService(
        {
          modules: {
            // @ts-expect-error: verifying runtime rejection of empty messages module
            messages: {},
          },
        },
        parts,
      ),
    ).toThrow("Invalid messages module");
    expect(() =>
      createService(
        {
          modules: {
            // @ts-expect-error: verifying runtime rejection of null messages module
            messages: null,
          },
        },
        parts,
      ),
    ).toThrow("Invalid messages module");
    expect(() =>
      createService(
        {
          modules: {
            // @ts-expect-error: verifying runtime rejection of empty uploads module
            uploads: {},
          },
        },
        parts,
      ),
    ).toThrow("Invalid uploads module");
    expect(() =>
      createService(
        {
          modules: {
            // @ts-expect-error: verifying runtime rejection of null uploads module
            uploads: null,
          },
        },
        parts,
      ),
    ).toThrow("Invalid uploads module");
    expect(() =>
      createService(
        {
          modules: {
            // @ts-expect-error: verifying runtime rejection of empty jobStore module
            jobStore: {},
          },
        },
        parts,
      ),
    ).toThrow("Invalid jobStore module");
    expect(() =>
      createService(
        {
          modules: {
            // @ts-expect-error: verifying runtime rejection of null jobStore module
            jobStore: null,
          },
        },
        parts,
      ),
    ).toThrow("Invalid jobStore module");
    expect(() =>
      createService(
        {
          modules: {
            // @ts-expect-error: verifying runtime rejection of empty idempotency module
            idempotency: {},
          },
        },
        parts,
      ),
    ).toThrow("Invalid idempotency module");
    expect(() =>
      createService(
        {
          modules: {
            // @ts-expect-error: verifying runtime rejection of null idempotency module
            idempotency: null,
          },
        },
        parts,
      ),
    ).toThrow("Invalid idempotency module");
    expect(() =>
      createService(
        {
          modules: {
            // @ts-expect-error: verifying runtime rejection of empty webhooks module
            webhooks: {},
          },
        },
        parts,
      ),
    ).toThrow("Invalid webhooks module");
    expect(() =>
      createService(
        {
          modules: {
            // @ts-expect-error: verifying runtime rejection of null webhooks module
            webhooks: null,
          },
        },
        parts,
      ),
    ).toThrow("Invalid webhooks module");
    expect(() =>
      createService(
        {
          modules: {
            // @ts-expect-error: verifying runtime rejection of empty policy module
            policy: {},
          },
        },
        parts,
      ),
    ).toThrow("Invalid policy module");
    expect(() =>
      createService(
        {
          modules: {
            // @ts-expect-error: verifying runtime rejection of null policy module
            policy: null,
          },
        },
        parts,
      ),
    ).toThrow("Invalid policy module");
    expect(() =>
      createService(
        {
          modules: {
            policy: {
              ...unrestrictedPolicy(),
              // @ts-expect-error: verifying runtime rejection of non-function policy.context
              context: "not-a-function",
            },
          },
        },
        parts,
      ),
    ).toThrow("Invalid policy module");
    expect(() =>
      createService(
        {
          modules: {
            jobStore: {
              ...queueJobStore(),
              // @ts-expect-error: verifying runtime rejection of non-function jobStore.readMany
              readMany: "not-a-function",
            },
          },
        },
        parts,
      ),
    ).toThrow("Invalid jobStore module");
    expect(() =>
      createService(
        {
          modules: {
            jobStore: {
              ...queueJobStore(),
              // @ts-expect-error: verifying runtime rejection of non-function jobStore.storesResultsExternally
              storesResultsExternally: "not-a-function",
            },
          },
        },
        parts,
      ),
    ).toThrow("Invalid jobStore module");
    expect(() =>
      createService(
        {
          modules: {
            webhooks: {
              signingSecret: async () => undefined,
              deliver: async () => ({ delivered: true }),
              // @ts-expect-error: verifying runtime rejection of non-function webhooks.shutdown
              shutdown: "not-a-function",
            },
          },
        },
        parts,
      ),
    ).toThrow("Invalid webhooks module");
    expect(() =>
      createService(
        {
          modules: {
            uploads: {
              // @ts-expect-error: verifying runtime rejection of incomplete uploads driver
              driver: () => ({ name: "broken" }),
            },
          },
        },
        parts,
      ),
    ).toThrow("Invalid uploads driver");
    expect(() =>
      createService(
        {
          modules: {
            uploads: {
              driver: () => ({
                name: "broken",
                prepareUpload: async () => ({
                  ok: false,
                  status: 503,
                  code: "PARSE_UPLOAD_STORAGE_DISABLED",
                  error: "disabled",
                }),
                read: async () => Buffer.alloc(0),
                delete: async () => {},
                // @ts-expect-error: verifying runtime rejection of non-function driver.receiveUpload
                receiveUpload: "not-a-function",
              }),
            },
          },
        },
        parts,
      ),
    ).toThrow("Invalid uploads driver");
    expect(() =>
      createService(
        {
          modules: {
            // @ts-expect-error: verifying runtime rejection of unknown module slot name
            upload: memoryUploads(),
          },
        },
        parts,
      ),
    ).toThrow('Unknown module slot "upload"');
  });
});

describe("scrape error messages", () => {
  it("uses built-in default wording when no service is installed", () => {
    expect(new NoEnginesLeftError(["fetch"]).message).toContain(
      "Check your server logs for more detailed error information from each engine.",
    );
    expect(new PDFFetchProxyError().message).toBe(
      logsMessages().fileFetchProxyError("PDF"),
    );
    expect(new PDFPrefetchFailed().message).toContain(
      logsMessages().filePrefetchFailedContact(),
    );
    expect(new DocumentFetchProxyError().message).toBe(
      logsMessages().fileFetchProxyError("document"),
    );
    expect(new DocumentPrefetchFailed().message).toContain(
      logsMessages().filePrefetchFailedContact(),
    );
  });

  it("uses the installed service messages module when constructing errors", async () => {
    const customMessages: MessagesModule = {
      errorContact: id => `contact:${id ?? "none"}`,
      restrictedCountryContact: () => "custom-country",
      allEnginesFailedContact: () => "custom-all-engines",
      fileFetchProxyError: kind => `custom-proxy:${kind}`,
      filePrefetchFailedContact: () => "custom-prefetch",
    };

    await withService(
      testService(defaultModules(), parts, { messages: customMessages }),
      async () => {
        expect(new NoEnginesLeftError(["fetch"]).message).toContain(
          "custom-all-engines",
        );
        expect(new PDFFetchProxyError().message).toBe("custom-proxy:PDF");
        expect(new PDFPrefetchFailed().message).toContain("custom-prefetch");
        expect(new DocumentFetchProxyError().message).toBe(
          "custom-proxy:document",
        );
        expect(new DocumentPrefetchFailed().message).toContain(
          "custom-prefetch",
        );
      },
    );
  });
});

describe("currentLimits", () => {
  it("falls back to noLimits when no service is installed and reads the installed module otherwise", async () => {
    const ctx = { teamId: "team-1", zeroDataRetention: false };

    await expect(currentLimits().concurrency(ctx)).resolves.toBeNull();
    await expect(currentLimits().teamConcurrency("team-1")).resolves.toBeNull();
    await expect(currentLimits().jobPriority({ ctx, base: 10 })).resolves.toBe(
      10,
    );
    expect(currentLimits().queueBackend(ctx)).toBeUndefined();

    const customLimits: LimitsModule = {
      concurrency: async () => 12,
      teamConcurrency: async () => 8,
      jobPriority: async ({ base }) => base + 5,
      queueBackend: () => "fdb",
    };

    await withService(
      testService(defaultModules(), parts, { limits: customLimits }),
      async () => {
        await expect(currentLimits().concurrency(ctx)).resolves.toBe(12);
        await expect(currentLimits().teamConcurrency("team-1")).resolves.toBe(
          8,
        );
        await expect(
          currentLimits().jobPriority({ ctx, base: 10 }),
        ).resolves.toBe(15);
        expect(currentLimits().queueBackend(ctx)).toBe("fdb");
      },
    );

    await expect(currentLimits().concurrency(ctx)).resolves.toBeNull();

    const onError = vi.fn();
    await withService(
      testService(defaultModules(), parts, {
        limits: {
          ...noLimits(),
          jobPriority: async () => {
            throw new Error("priority failed");
          },
        },
      }),
      async () => {
        await expect(resolveJobPriority(ctx, 21, onError)).resolves.toBe(21);
      },
    );
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("unrestrictedPolicy", () => {
  it("admits requests and preserves caller-requested zeroDataRetention and robotsUserAgent", async () => {
    const policy = unrestrictedPolicy();
    const admitted = await policy.admit({
      kind: "scrape",
      caller: { teamId: "team-1" },
      body: {
        url: "https://example.com",
        zeroDataRetention: true,
        // @ts-expect-error: passing partial body with robotsUserAgent to verify admit() field extraction
        robotsUserAgent: "CustomBot",
      },
    });

    expect(admitted.ok).toBe(true);
    if (admitted.ok) {
      expect(admitted.ctx).toEqual({
        teamId: "team-1",
        zeroDataRetention: true,
        robotsUserAgent: "CustomBot",
      });
    }
  });

  it("propagates zeroDataRetention and usOnly on system contexts", () => {
    const policy = unrestrictedPolicy();

    expect(policy.system("robots-txt")).toEqual({
      teamId: "robots-txt",
      zeroDataRetention: false,
    });
    expect(
      policy.system("sitemap", {
        teamId: "team-1",
        zeroDataRetention: true,
        usOnly: true,
      }),
    ).toEqual({
      teamId: "sitemap",
      zeroDataRetention: true,
      usOnly: true,
    });
  });
});
