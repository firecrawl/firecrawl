const NODE_MODULES = "/node_modules/";

function packageOf(file: string): string | null {
  let path = file.replace(/^file:\/\//, "").replace(/\\/g, "/");
  try {
    path = decodeURIComponent(path);
  } catch {}
  const at = path.lastIndexOf(NODE_MODULES);
  if (at < 0) return null;
  const [first, second] = path.slice(at + NODE_MODULES.length).split("/");
  const name = first?.startsWith("@") ? (second ? `${first}/${second}` : "") : first;
  return name && !name.startsWith(".") ? name : null;
}

/** File of a V8 stack line, or null for frames without one (native, anonymous, runtime internals). */
function frameFile(line: string): string | null {
  const text = line.trim().replace(/^at /, "");
  const open = text.indexOf(" (");
  const location = open >= 0 && text.endsWith(")") ? text.slice(open + 2, -1) : text;
  const match = /^(.*):\d+:\d+$/.exec(location);
  return match && !match[1]!.startsWith("node:") ? match[1]! : null;
}

// Downstream surface classification matches "playground" anywhere in an origin.
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}

/**
 * Slug of the installed package that created the client, or null when the
 * caller is application code or detection is disabled. Never throws.
 */
export function detectCallerPackage(stack?: string): string | null {
  try {
    if (process.env.FIRECRAWL_DISABLE_CALLER_ORIGIN === "1") return null;
    if (stack === undefined) {
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 50;
      try {
        stack = new Error().stack ?? "";
      } finally {
        Error.stackTraceLimit = limit;
      }
    }
    let ownFile: string | null = null;
    let ownPackage: string | null = null;
    for (const line of stack.split("\n")) {
      if (!/^\s*at /.test(line)) continue;
      const file = frameFile(line);
      if (!file) continue;
      if (ownFile === null) {
        ownFile = file;
        ownPackage = packageOf(file);
      }
      if (file === ownFile) continue;
      const name = packageOf(file);
      if (name && name === ownPackage) continue;
      const slug = name ? slugify(name) : "";
      return slug && !slug.includes("playground") ? slug : null;
    }
  } catch {}
  return null;
}

/** Origin sent with requests: `js-sdk@<version>`, or `js-sdk.<package>@<version>` for wrapper libraries. */
export function defaultOrigin(version: string): string {
  const caller = detectCallerPackage();
  return caller ? `js-sdk.${caller}@${version}` : `js-sdk@${version}`;
}
