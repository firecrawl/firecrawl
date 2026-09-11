vi.mock("../../../config", () => ({ config: {} }));
import { feedbackRedisUrl, keylessFeedbackRedis } from "./keyless-redis";

describe("feedback cache configuration", () => {
  it("does not fall back to the rate-limit store", () => {
    expect(keylessFeedbackRedis).toBeNull();
    expect(feedbackRedisUrl(undefined, "redis://quota:6379")).toBeUndefined();
  });
  it("rejects the same server even with different credentials or logical databases", () => {
    expect(
      feedbackRedisUrl("redis://other@quota/2", "redis://user@quota:6379/1"),
    ).toBeUndefined();
    expect(
      feedbackRedisUrl("redis://localhost:6379", "redis://127.0.0.1:6379"),
    ).toBeUndefined();
  });
  it("accepts a separately configured server", () => {
    expect(feedbackRedisUrl("redis://cache:6379", "redis://quota:6379")).toBe(
      "redis://cache:6379",
    );
  });
  it("disables optional storage when its URL is malformed", () => {
    expect(feedbackRedisUrl("not-a-url", "redis://quota")).toBeUndefined();
  });
});
