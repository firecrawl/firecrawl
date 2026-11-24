/*
 * Default open-source module implementations.
 *
 * This file imports only module types so constructing default modules or
 * describing a service never loads configuration, queues, or storage clients.
 */
import type {
  BlocklistModule,
  FetchProxyFileKind,
  MessagesModule,
  Modules,
  UploadDriver,
  UploadsModule,
} from "./modules";

/** Empty blocklist that initializes as a no-op and allows every URL. */
export function noBlocklist(): BlocklistModule {
  return {
    async init() {},
    isBlocked: () => false,
    hasScopedRules: () => false,
  };
}

/** Default user-facing messages that direct operators to local logs and config. */
export function logsMessages(): MessagesModule {
  return {
    errorContact(errorId?: string): string {
      return errorId
        ? `An error occurred. Please check your logs for more details. Error ID: ${errorId}`
        : "An error occurred. Please check your logs for more details.";
    },
    restrictedCountryContact(): string {
      return "Please check your server configuration.";
    },
    allEnginesFailedContact(): string {
      return "Check your server logs for more detailed error information from each engine.";
    },
    fileFetchProxyError(kind: FetchProxyFileKind): string {
      return `Failed to download the ${kind} file because the configured proxy could not establish a connection to the website (the proxy rejected the tunneling request). Check your proxy configuration (PROXY_SERVER) and whether the target site is reachable from it, then retry.`;
    },
    filePrefetchFailedContact(): string {
      return "Check your server logs for more details about the specific protection mechanism encountered.";
    },
  };
}

type LocalUploadRecord = {
  buffer?: Buffer;
  filename: string;
  contentType?: string;
  teamId: string;
  expiresAt: number;
  maxBytes: number;
};

/**
 * In-memory upload storage for single-instance deployments.
 * Multi-instance or restart-durable deployments should supply a shared
 * `UploadsModule` implementation to `createService`.
 */
export function memoryUploads(): UploadsModule {
  const localUploads = new Map<string, LocalUploadRecord>();

  const cleanupExpired = (now = Date.now()) => {
    for (const [uploadId, record] of localUploads.entries()) {
      if (now > record.expiresAt) {
        localUploads.delete(uploadId);
      }
    }
  };

  const driver: UploadDriver = {
    name: "local",

    async prepareUpload(input) {
      cleanupExpired();
      const baseUrl = input.publicBaseUrl.replace(/\/$/, "");
      return {
        ok: true,
        target: {
          uploadUrl: `${baseUrl}/v2/parse/upload/${input.uploadId}?uploadRef=${encodeURIComponent(input.uploadRef)}`,
          method: "PUT",
          headers: {
            "Content-Type": input.contentType || "application/octet-stream",
          },
        },
        commit() {
          localUploads.set(input.uploadId, {
            filename: input.filename,
            contentType: input.contentType,
            teamId: input.teamId,
            expiresAt: input.expiresAt,
            maxBytes: input.maxBytes,
          });
        },
      };
    },

    async receiveUpload(input) {
      cleanupExpired();
      const record = localUploads.get(input.uploadId);
      if (!record || record.teamId !== input.teamId) {
        return {
          ok: false,
          status: 404,
          code: "NOT_FOUND",
          error: "Upload URL not found or expired.",
        };
      }
      if (input.body.length > record.maxBytes) {
        return {
          ok: false,
          status: 400,
          code: "BAD_REQUEST",
          error: "Uploaded file exceeds maximum size of 50MB.",
        };
      }
      record.buffer = input.body;
      return { ok: true };
    },

    async read(ref) {
      cleanupExpired();
      const record = localUploads.get(ref.uploadId);
      if (!record || record.teamId !== ref.teamId || !record.buffer) {
        throw new Error(
          "Uploaded file is not available. Upload the file before parsing.",
        );
      }
      if (record.buffer.length > ref.maxBytes) {
        throw new Error("Uploaded file exceeds maximum size of 50MB.");
      }
      return record.buffer;
    },

    async delete(ref) {
      localUploads.delete(ref.uploadId);
    },
  };

  return { driver: () => driver };
}

/** Returns fresh instances of every default module slot. */
export function defaultModules(): Modules {
  return {
    blocklist: noBlocklist(),
    messages: logsMessages(),
    uploads: memoryUploads(),
  };
}
