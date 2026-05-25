import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "../../../..");
const OPENAPI_PATH = join(ROOT, "openapi.json");
const V2_ROUTES_PATH = join(ROOT, "src/routes/v2.ts");

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "options",
  "head",
  "trace",
]);

function loadSpec() {
  return JSON.parse(readFileSync(OPENAPI_PATH, "utf-8"));
}

function parseOpenAPIOperations(spec: any) {
  const ops: { method: string; path: string; id: string }[] = [];
  for (const [path, item] of Object.entries<any>(spec.paths)) {
    for (const [method, op] of Object.entries<any>(item)) {
      if (HTTP_METHODS.has(method)) {
        ops.push({ method: method.toUpperCase(), path, id: op.operationId });
      }
    }
  }
  return ops;
}

function parseV2Routes() {
  const src = readFileSync(V2_ROUTES_PATH, "utf-8");
  const pattern = /v2Router\.(post|get|delete|patch|put)\(\s*\n?\s*"([^"]+)"/g;
  const routes: { method: string; normalized: string; raw: string }[] = [];
  let m;
  while ((m = pattern.exec(src)) !== null) {
    const method = m[1].toUpperCase();
    const raw = m[2];
    const normalized = raw.replace(/:[^/]+/g, "{}");
    routes.push({ method, normalized, raw });
  }
  return routes;
}

function normalizeOpenAPIPath(p: string) {
  return p.replace(/\{[^/]+\}/g, "{}");
}

describe("openapi.json drift detection", () => {
  const spec = loadSpec();
  const operations = parseOpenAPIOperations(spec);
  const v2Routes = parseV2Routes();

  test("openapi.json is valid JSON with paths", () => {
    expect(spec).toHaveProperty("openapi");
    expect(spec).toHaveProperty("paths");
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
  });

  test("every operation has an operationId", () => {
    const missing = operations.filter((o) => !o.id);
    expect(missing.map((m) => `${m.method} ${m.path}`)).toEqual([]);
  });

  test("no duplicate operationIds", () => {
    const ids = operations.map((o) => o.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });

  test("all $ref pointers resolve to existing schemas", () => {
    const schemas = spec.components?.schemas ?? {};
    const missing: { location: string; ref: string }[] = [];

    function walk(node: any, path: string) {
      if (node && typeof node === "object") {
        if ("$ref" in node) {
          const ref = node["$ref"];
          if (typeof ref === "string" && ref.startsWith("#/components/schemas/")) {
            const name = ref.split("/").pop()!;
            if (!(name in schemas)) {
              missing.push({ location: path, ref });
            }
          }
        }
        for (const [k, v] of Object.entries(node)) {
          walk(v, `${path}/${k}`);
        }
      }
    }

    walk(spec, "$");
    expect(missing).toEqual([]);
  });

  test("every registered v2 route has a matching OpenAPI operation", () => {
    const opSet = new Set(
      operations.map((o) => `${o.method}|${normalizeOpenAPIPath(o.path)}`)
    );

    const missing = v2Routes.filter(
      (r) => !opSet.has(`${r.method}|${r.normalized}`)
    );

    expect(missing.map((m) => `${m.method} ${m.raw}`)).toEqual([]);
  });

  test("every OpenAPI operation maps to a registered v2 route", () => {
    const routeSet = new Set(
      v2Routes.map((r) => `${r.method}|${r.normalized}`)
    );

    const extra = operations.filter(
      (o) => !routeSet.has(`${o.method}|${normalizeOpenAPIPath(o.path)}`)
    );

    expect(extra.map((e) => `${e.method} ${e.path}`)).toEqual([]);
  });

  test("operation count matches v2 route count", () => {
    expect(operations.length).toBe(v2Routes.length);
  });
});
