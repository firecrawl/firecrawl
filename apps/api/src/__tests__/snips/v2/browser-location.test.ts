import { config } from "../../../config";
import { itIf } from "../lib";
import { browserCreateRaw, idmux, Identity } from "./lib";

describe("POST /v2/interact location", () => {
  let identity: Identity;

  beforeAll(async () => {
    identity = await idmux({ name: "browser-location", credits: 100 });
  });

  it.each(["zz", "us-generic", "us-whitelist"])(
    "rejects %s as a country",
    async country => {
      const res = await browserCreateRaw({ location: { country } }, identity);
      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
    },
  );

  it("rejects languages, which a browser session cannot apply", async () => {
    const res = await browserCreateRaw(
      { location: { country: "DE", languages: ["de-DE"] } },
      identity,
    );
    expect(res.statusCode).toBe(400);
  });

  // Without Hangar a valid request stops at the 503 after validation.
  itIf(!config.HANGAR_URL)("accepts an ISO country", async () => {
    const res = await browserCreateRaw(
      { location: { country: "GB" } },
      identity,
    );
    expect(res.statusCode).toBe(503);
  });
});
