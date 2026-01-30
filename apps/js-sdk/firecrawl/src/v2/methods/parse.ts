import type { Document, ParseFileInput, ParseOptions, ParseRequestParams } from "../types";
import { HttpClient } from "../utils/httpClient";
import { ensureValidParseOptions } from "../utils/validation";
import { throwForBadResponse, normalizeAxiosError } from "../utils/errorHandler";

function toFilePart(
  input: ParseFileInput,
  filename?: string,
  contentType?: string
): { blob: Blob | File; filename: string } {
  const inferredName =
    filename ||
    (typeof File !== "undefined" && input instanceof File ? input.name : undefined) ||
    "file";

  if (typeof File !== "undefined" && input instanceof File) {
    return { blob: input, filename: inferredName };
  }

  const typeHint =
    contentType ||
    (typeof Blob !== "undefined" && input instanceof Blob ? input.type : undefined);

  if (typeof Blob !== "undefined" && input instanceof Blob) {
    return { blob: input, filename: inferredName };
  }

  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    const blob = new Blob([input], typeHint ? { type: typeHint } : undefined);
    return { blob, filename: inferredName };
  }

  throw new Error("Unsupported file input");
}

export async function parse(
  http: HttpClient,
  file: ParseFileInput,
  options?: ParseOptions,
  params?: ParseRequestParams,
): Promise<Document> {
  if (!file) {
    throw new Error("file is required");
  }
  if (options) ensureValidParseOptions(options);

  const form = new FormData();
  const { blob, filename } = toFilePart(file, params?.filename, params?.contentType);
  form.append("file", blob, filename);

  if (options) {
    form.append("options", JSON.stringify(options));
  }
  if (params?.origin) {
    form.append("origin", params.origin);
  }
  if (params?.integration) {
    form.append("integration", params.integration);
  }
  if (params?.zeroDataRetention !== undefined) {
    form.append("zeroDataRetention", String(params.zeroDataRetention));
  }

  try {
    const res = await http.postFormData<{ success: boolean; data?: Document; error?: string }>(
      "/v2/parse",
      form,
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
