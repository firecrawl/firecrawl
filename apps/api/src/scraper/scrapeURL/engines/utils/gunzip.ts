import { gunzip } from "node:zlib";
import { promisify } from "node:util";

// Upper bound on inflated output. A few kilobytes of gzip can inflate to
// gigabytes, so every gunzip of caller-controlled bytes must carry a cap.
export const MAX_GUNZIPPED_FILE_SIZE = 50 * 1024 * 1024; // 50MB

const gunzipAsync = promisify(gunzip);

/**
 * Inflates `buffer`, rejecting with a RangeError (ERR_BUFFER_TOO_LARGE) once
 * the output would exceed `maxOutputLength`.
 */
export async function gunzipBounded(
  buffer: Buffer,
  maxOutputLength: number = MAX_GUNZIPPED_FILE_SIZE,
): Promise<Buffer> {
  return gunzipAsync(buffer, { maxOutputLength });
}
