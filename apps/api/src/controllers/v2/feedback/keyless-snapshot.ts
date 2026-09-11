const sensitiveKey =
  /headers|cookie|token|secret|password|authorization|api.?key|^uploadref$|^buffer$|base64|^__/i;

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return "[redacted]";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[redacted]";
  }
}

// Bound traversal and strings before serialization, including nested JSON output.
export function snapshotCopier(maxBytes: number) {
  let remaining = maxBytes;
  let nodes = 2048;
  let truncated = false;
  function copy(value: unknown, key = "", depth = 0): any {
    if (remaining < 8 || --nodes < 0 || depth > 8) {
      truncated = true;
      return undefined;
    }
    remaining -= 4;
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      remaining -= 24;
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "string") {
      let text = value.slice(0, Math.min(16000, remaining));
      if (text.length < value.length) truncated = true;
      if (/url$/i.test(key)) text = redactUrl(text);
      let size = Buffer.byteLength(JSON.stringify(text));
      if (size > remaining) {
        text = text.slice(0, Math.max(0, Math.floor((remaining - 2) / 6)));
        size = Buffer.byteLength(JSON.stringify(text));
        truncated = true;
      }
      remaining -= size;
      return text;
    }
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const item of value) {
        if (result.length >= 100 || remaining < 8 || nodes < 0) {
          truncated = true;
          break;
        }
        // Action arguments can contain form credentials or executable code.
        result.push(
          copy(key === "actions" ? { type: item?.type } : item, key, depth + 1),
        );
      }
      return result;
    }
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = Object.create(null);
      for (const field in value) {
        if (!Object.hasOwn(value, field) || sensitiveKey.test(field)) continue;
        if (field.length > 256) {
          truncated = true;
          break;
        }
        const cost = Buffer.byteLength(JSON.stringify(field)) + 2;
        if (cost > remaining || nodes < 0) {
          truncated = true;
          break;
        }
        remaining -= cost;
        result[field] = copy(value[field], field, depth + 1);
      }
      return result;
    }
    return undefined;
  }
  return {
    copy,
    get truncated() {
      return truncated;
    },
  };
}
