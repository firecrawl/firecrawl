import { afterEach, describe, expect, it, vi } from "vitest";
const config = vi.hoisted(() => ({ ALLOW_LOCAL_WEBHOOKS: false }));
vi.mock("../../config", () => ({ config }));
import { webhookSchema } from "./schema";

afterEach(() => {
  config.ALLOW_LOCAL_WEBHOOKS = false;
});

describe("webhook destination validation", () => {
  it.each(["https://example.com/hooks", { url: "https://example.com/hooks" }])(
    "accepts public webhook configuration %j",
    value => {
      expect(webhookSchema.safeParse(value).success).toBe(true);
    },
  );

  it.each([
    "http://[::1]",
    "http://169.254.169.254",
    "http://localhost.",
    "http://192.168.1.1",
    "file:///etc/passwd",
  ])("rejects %s in both configuration formats", url => {
    expect(webhookSchema.safeParse(url).success).toBe(false);
    expect(webhookSchema.safeParse({ url }).success).toBe(false);
  });

  it("only honors the deployment override, not a request field", () => {
    expect(
      webhookSchema.safeParse({
        url: "http://127.0.0.1",
        ALLOW_LOCAL_WEBHOOKS: true,
      }).success,
    ).toBe(false);
    config.ALLOW_LOCAL_WEBHOOKS = true;
    expect(webhookSchema.safeParse("http://127.0.0.1").success).toBe(true);
    expect(webhookSchema.safeParse("file:///etc/passwd").success).toBe(false);
  });
});
