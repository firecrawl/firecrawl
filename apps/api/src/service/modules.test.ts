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
  logsMessages,
  memoryUploads,
  noLimits,
} from "./defaults";
import { currentLimits } from "../lib/limits";
import type {
  LimitsModule,
  MessagesModule,
  Modules,
  UploadsModule,
} from "./modules";
import { createService, replaceService, type CoreParts } from "./service";
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

describe("service module slots", () => {
  it("fills omitted module slots with built-in defaults", async () => {
    const built = createService({}, parts);
    const ctx = { teamId: "team-1", zeroDataRetention: false };

    expect(Object.isFrozen(built.modules)).toBe(true);
    expect(Object.isFrozen(built.modules.limits)).toBe(true);
    expect(Object.isFrozen(built.modules.messages)).toBe(true);
    expect(Object.isFrozen(built.modules.uploads)).toBe(true);
    expect(Object.isFrozen(built.modules.uploads.driver())).toBe(true);
    expect(built.describe().modules).toEqual(["limits", "messages", "uploads"]);
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
  });

  it("keeps defaults for unspecified slots and snapshots provided modules and drivers", async () => {
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
    const built = createService(
      {
        modules: {
          limits: customLimits,
          messages: customMessages,
          uploads: customUploads,
        },
      },
      parts,
    );

    customLimits.concurrency = async () => 999;
    customLimits.keyConcurrency = async () => ({ id: "mutated", limit: 1 });
    customMessages.errorContact = () => "mutated";
    customDriver.read = async () => Buffer.from("mutated");
    customUploads.driver = () => ({
      ...customDriver,
      name: "mutated",
    });

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
    expect(built.modules.messages.errorContact("42")).toBe("custom:42");
    expect(built.modules.uploads.driver().name).toBe("custom");
    const data = await built.modules.uploads.driver().read({
      uploadId: "u1",
      teamId: "t1",
      objectPath: "p1",
      maxBytes: 100,
    });
    expect(data.toString("utf8")).toBe("original");
  });

  it("rejects invalid, null, or unknown module slots and malformed upload drivers at service creation", () => {
    expect(() =>
      createService(
        { modules: { limits: {} as unknown as LimitsModule } },
        parts,
      ),
    ).toThrow("Invalid limits module");
    expect(() =>
      createService(
        { modules: { limits: null as unknown as LimitsModule } },
        parts,
      ),
    ).toThrow("Invalid limits module");
    expect(() =>
      createService(
        {
          modules: {
            limits: {
              ...noLimits(),
              keyConcurrency: "not-a-function" as unknown as never,
            },
          },
        },
        parts,
      ),
    ).toThrow("Invalid limits module");
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
  });
});
