import { type Document, type ParseFile, type ParseOptions } from "../types";
import { HttpClient } from "../utils/httpClient";
import { ensureValidParseOptions } from "../utils/validation";
import {
  throwForBadResponse,
  normalizeAxiosError,
} from "../utils/errorHandler";
import { getVersion } from "../utils/getVersion";

function toUploadBlob(input: ParseFile["data"], contentType?: string): Blob {
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    if (contentType && input.type !== contentType) {
      return new Blob([input], { type: contentType });
    }
    return input;
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(input)) {
    return new Blob([input], { type: contentType });
  }

  if (input instanceof ArrayBuffer) {
    return new Blob([input], { type: contentType });
  }

  if (ArrayBuffer.isView(input)) {
    return new Blob([input], { type: contentType });
  }

  if (typeof input === "string") {
    return new Blob([input], {
      type: contentType ?? "text/plain; charset=utf-8",
    });
  }

  throw new Error("Unsupported parse file data type");
}

export async function parse(
  http: HttpClient,
  file: ParseFile,
  options?: ParseOptions,
): Promise<Document> {
  if (!file || !file.filename || !file.filename.trim()) {
    throw new Error("filename cannot be empty");
  }

  if (file.data == null) {
    throw new Error("file data cannot be empty");
  }

  const blob = toUploadBlob(file.data, file.contentType);
  if (blob.size === 0) {
    throw new Error("file data cannot be empty");
  }

  if (options) ensureValidParseOptions(options);

  const version = getVersion();
  const normalizedOptions: ParseOptions = {
    ...(options ?? {}),
    origin:
      typeof options?.origin === "string" && options.origin.includes("mcp")
        ? options.origin
        : (options?.origin ?? `js-sdk@${version}`),
  };

  const formData = new FormData();
  formData.append("options", JSON.stringify(normalizedOptions));
  formData.append(
    "file",
    toUploadBlob(file.data, file.contentType),
    file.filename.trim(),
  );

  try {
    const res = await http.postMultipart<{
      success: boolean;
      data?: Document;
      error?: string;
    }>(
      "/v2/parse",
      formData,
      typeof normalizedOptions.timeout === "number"
        ? { timeoutMs: normalizedOptions.timeout + 5000 }
        : {},
    );
    if (res.status !== 200 || !res.data?.success) {
      throwForBadResponse(res, "parse");
    }
    return (res.data.data || {}) as Document;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "parse");
    throw err;
  }
}
