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
  redisIdempotency,
} from "./defaults";
import type {
  BlocklistModule,
  IdempotencyModule,
  MessagesModule,
  Modules,
  UploadsModule,
  WebhooksModule,
} from "./modules";
import { createService, replaceService, type CoreParts } from "./service";
import { testService, withService } from "./testing";

const parts: CoreParts = { core: { name: "core" }, logger: { error: vi.fn() } };

afterEach(() => {
  replaceService(undefined);
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
    if (!prepared.ok) throw new Error("expected prepared upload");
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
    if (!wrongTeam.ok) expect(wrongTeam.status).toBe(404);

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
    if (!prepared.ok) throw new Error("expected prepared upload");
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
    if (!received.ok) expect(received.status).toBe(404);
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

describe("redisIdempotency", () => {
  it("claims team-scoped keys with the default 24h TTL and rejects duplicates", async () => {
    const seen = new Map<string, number>();
    const idempotency = redisIdempotency({
      setIfAbsent: async (key, ttlSeconds) => {
        if (seen.has(key)) return false;
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
        setIfAbsent: "not-a-function" as unknown as () => Promise<boolean>,
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

    expect(() => directWebhooks({ secret: 123 as unknown as string })).toThrow(
      "Invalid webhooks secret",
    );
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
  it("fills omitted module slots with built-in defaults", () => {
    const built = createService({}, parts);

    expect(Object.isFrozen(built.modules)).toBe(true);
    expect(Object.isFrozen(built.modules.blocklist)).toBe(true);
    expect(Object.isFrozen(built.modules.messages)).toBe(true);
    expect(Object.isFrozen(built.modules.uploads)).toBe(true);
    expect(Object.isFrozen(built.modules.uploads.driver())).toBe(true);
    expect(Object.isFrozen(built.modules.idempotency)).toBe(true);
    expect(Object.isFrozen(built.modules.webhooks)).toBe(true);
    expect(built.describe().modules).toEqual([
      "blocklist",
      "idempotency",
      "messages",
      "uploads",
      "webhooks",
    ]);
    expect(
      built.modules.blocklist.isBlocked("https://example.com", {
        teamId: "team-1",
        zeroDataRetention: false,
      }),
    ).toBe(false);
    expect(built.modules.messages.errorContact()).toBe(
      logsMessages().errorContact(),
    );
    expect(built.modules.uploads.driver().name).toBe("local");
  });

  it("keeps defaults for unspecified slots and snapshots provided modules and drivers", async () => {
    const initSpy = vi.fn(async () => {});
    const customBlocklist: BlocklistModule = {
      init: initSpy,
      isBlocked: url => url.includes("blocked.example"),
      hasScopedRules: ctx => ctx.teamId === "scoped-team",
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
          blocklist: customBlocklist,
          messages: customMessages,
          uploads: customUploads,
          idempotency: customIdempotency,
          webhooks: customWebhooks,
        },
      },
      parts,
    );

    customBlocklist.init = async () => {
      throw new Error("mutated");
    };
    customBlocklist.isBlocked = () => false;
    customBlocklist.hasScopedRules = () => false;
    customMessages.errorContact = () => "mutated";
    customDriver.read = async () => Buffer.from("mutated");
    customUploads.driver = () => ({
      ...customDriver,
      name: "mutated",
    });
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
    expect(built.modules.messages.errorContact("42")).toBe("custom:42");
    expect(built.modules.uploads.driver().name).toBe("custom");
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
        { modules: { blocklist: {} as unknown as BlocklistModule } },
        parts,
      ),
    ).toThrow("Invalid blocklist module");
    expect(() =>
      createService(
        { modules: { blocklist: null as unknown as BlocklistModule } },
        parts,
      ),
    ).toThrow("Invalid blocklist module");
    expect(() =>
      createService(
        {
          modules: {
            blocklist: {
              init: async () => {},
              isBlocked: () => false,
            } as unknown as BlocklistModule,
          },
        },
        parts,
      ),
    ).toThrow("Invalid blocklist module");
    expect(() =>
      createService(
        { modules: { messages: {} as unknown as MessagesModule } },
        parts,
      ),
    ).toThrow("Invalid messages module");
    expect(() =>
      createService(
        { modules: { messages: null as unknown as MessagesModule } },
        parts,
      ),
    ).toThrow("Invalid messages module");
    expect(() =>
      createService(
        { modules: { uploads: {} as unknown as UploadsModule } },
        parts,
      ),
    ).toThrow("Invalid uploads module");
    expect(() =>
      createService(
        { modules: { uploads: null as unknown as UploadsModule } },
        parts,
      ),
    ).toThrow("Invalid uploads module");
    expect(() =>
      createService(
        { modules: { idempotency: {} as unknown as IdempotencyModule } },
        parts,
      ),
    ).toThrow("Invalid idempotency module");
    expect(() =>
      createService(
        { modules: { idempotency: null as unknown as IdempotencyModule } },
        parts,
      ),
    ).toThrow("Invalid idempotency module");
    expect(() =>
      createService(
        { modules: { webhooks: {} as unknown as WebhooksModule } },
        parts,
      ),
    ).toThrow("Invalid webhooks module");
    expect(() =>
      createService(
        { modules: { webhooks: null as unknown as WebhooksModule } },
        parts,
      ),
    ).toThrow("Invalid webhooks module");
    expect(() =>
      createService(
        {
          modules: {
            webhooks: {
              signingSecret: async () => undefined,
              deliver: async () => ({ delivered: true }),
              shutdown: "not-a-function",
            } as unknown as WebhooksModule,
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
              driver: () => ({ name: "broken" }) as unknown as never,
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
              driver: () =>
                ({
                  name: "broken",
                  prepareUpload: async () => ({
                    ok: false,
                    status: 503,
                    code: "PARSE_UPLOAD_STORAGE_DISABLED",
                    error: "disabled",
                  }),
                  read: async () => Buffer.alloc(0),
                  delete: async () => {},
                  receiveUpload: "not-a-function",
                }) as unknown as never,
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
            upload: memoryUploads(),
          } as unknown as Partial<Modules>,
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
