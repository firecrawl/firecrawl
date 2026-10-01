import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The self-host docs tell operators to set OPENAI_API_MODE and
 * OPENAI_STRUCTURED_OUTPUT_MODE. Root Compose only forwards an explicit
 * variable list, so a setting that is not listed there silently never reaches
 * the container. This guards the documented deployment path.
 */

const repoRoot = join(__dirname, "../../../../..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");

describe("self-host deployment wiring", () => {
  // Only non-secret settings are enumerated by these deployment surfaces;
  // OPENAI_API_KEY is supplied separately (a secret), so it is not listed here.
  const openaiVars = ["OPENAI_BASE_URL", "MODEL_NAME"] as const;
  const newVars = ["OPENAI_API_MODE", "OPENAI_STRUCTURED_OUTPUT_MODE"] as const;

  it("root compose forwards every OpenAI setting the API accepts", () => {
    const compose = read("docker-compose.yaml");
    for (const v of [...openaiVars, ...newVars, "OPENAI_API_KEY"]) {
      expect(compose).toContain(v);
    }
  });

  it("root compose gives the new variables the same auto default as config.ts", () => {
    const compose = read("docker-compose.yaml");
    for (const v of newVars) {
      expect(compose).toMatch(new RegExp(`${v}:\\s*\\$\\{${v}:-auto\\}`));
    }
  });

  it("the helm chart exposes the same variables as the API", () => {
    const values = read("examples/kubernetes/firecrawl-helm/values.yaml");
    const configmap = read(
      "examples/kubernetes/firecrawl-helm/templates/configmap.yaml",
    );
    for (const v of [...openaiVars, ...newVars]) {
      expect(values).toContain(v);
      expect(configmap).toContain(v);
    }
  });

  it("documents the same variables SELF_HOST.md tells operators to set", () => {
    const docs = read("SELF_HOST.md");
    for (const v of [...newVars, "OPENAI_BASE_URL", "MODEL_NAME"]) {
      expect(docs).toContain(v);
    }
  });
});
