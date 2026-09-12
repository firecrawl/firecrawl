import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function scrapeOptionProperties(file: string) {
  const spec = JSON.parse(
    readFileSync(resolve(process.cwd(), file), "utf8"),
  ) as {
    components: {
      schemas: { ScrapeOptions: { properties: Record<string, unknown> } };
    };
  };
  return spec.components.schemas.ScrapeOptions.properties;
}

describe("OpenAPI ScrapeOptions", () => {
  it("documents onlyCleanContent on v2 ScrapeOptions", () => {
    expect(
      scrapeOptionProperties("openapi.json").onlyCleanContent,
    ).toMatchObject({
      type: "boolean",
      default: false,
    });
  });

  it("documents onlyCleanContent on v1 ScrapeOptions", () => {
    expect(
      scrapeOptionProperties("v1-openapi.json").onlyCleanContent,
    ).toMatchObject({
      type: "boolean",
      default: false,
    });
  });
});
