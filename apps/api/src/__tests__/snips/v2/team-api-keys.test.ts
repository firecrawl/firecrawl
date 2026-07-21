import { describeIf, TEST_PRODUCTION } from "../lib";
import { createApiKeyRaw, creditUsageRaw, idmux, Identity } from "./lib";

// Creating keys writes to the api_keys table (and, with a spend limit, to
// Autumn), so this only runs against a real deployment.
describeIf(TEST_PRODUCTION)("POST /v2/team/api-keys", () => {
  let identity: Identity;

  beforeAll(async () => {
    identity = await idmux({ name: "team-api-keys", credits: 1000 });
  });

  it.concurrent(
    "creates a key with just a name and the token authenticates",
    async () => {
      const res = await createApiKeyRaw({ name: "ci-created-key" }, identity);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.apiKey.name).toBe("ci-created-key");
      expect(res.body.apiKey.teamId).toBe(identity.teamId);
      expect(res.body.apiKey).toHaveProperty("ownerId");
      expect(res.body.apiKey.spendLimit).toBeNull();
      expect(typeof res.body.apiKey.token).toBe("string");
      expect(res.body.apiKey.token).toMatch(/^fc-/);

      // The returned token must be a working API key.
      const usage = await creditUsageRaw(res.body.apiKey.token);
      expect(usage.statusCode).toBe(200);
    },
    30000,
  );

  it.concurrent(
    "creates a key with an optional spend limit and echoes it back",
    async () => {
      const res = await createApiKeyRaw(
        {
          name: "ci-limited-key",
          spendLimit: { credits: 5000, interval: "month" },
        },
        identity,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.apiKey.spendLimit).toEqual({
        credits: 5000,
        interval: "month",
      });
      expect(res.body.apiKey.token).toMatch(/^fc-/);
    },
    30000,
  );

  it.concurrent(
    "rejects an invalid interval with 400",
    async () => {
      const res = await createApiKeyRaw(
        { spendLimit: { credits: 5000, interval: "yearly" } },
        identity,
      );
      expect(res.statusCode).toBe(400);
    },
    30000,
  );

  it.concurrent(
    "rejects a non-positive credit limit with 400",
    async () => {
      const res = await createApiKeyRaw(
        { spendLimit: { credits: 0, interval: "day" } },
        identity,
      );
      expect(res.statusCode).toBe(400);
    },
    30000,
  );

  it.concurrent(
    "rejects an unknown field with 400",
    async () => {
      const res = await createApiKeyRaw(
        { name: "x", budgetCents: 5000 },
        identity,
      );
      expect(res.statusCode).toBe(400);
    },
    30000,
  );

  it.concurrent(
    "requires authentication",
    async () => {
      const res = await createApiKeyRaw(
        { name: "no-auth" },
        { apiKey: "", teamId: identity.teamId },
      );
      expect(res.statusCode).toBe(401);
    },
    30000,
  );
});
