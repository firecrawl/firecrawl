import request from "supertest";
import { describeIf, TEST_API_URL, TEST_PRODUCTION } from "../lib";

// Denials write an auth/denied log line; the response must stay the same.
describeIf(TEST_PRODUCTION)("Auth denial responses", () => {
  it.each([
    ["no token after the scheme", "Bearer", "Unauthorized: Token missing"],
    ["a malformed key", "Bearer not-a-real-key", "Unauthorized: Invalid token"],
    [
      "an unknown key",
      `Bearer fc-${crypto.randomUUID().replace(/-/g, "")}`,
      "Unauthorized: Invalid token",
    ],
  ])("returns the same 401 body for %s", async (_, authorization, error) => {
    const response = await request(TEST_API_URL)
      .post("/v2/scrape")
      .set("Authorization", authorization)
      .set("Content-Type", "application/json")
      .send({ url: "https://example.com" });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({ success: false, error });
  });
});
