jest.mock("uuid", () => ({
  validate: jest.fn(() => true),
}));

import { authenticateUser } from "../auth";
import { config } from "../../config";
import { RateLimiterMode } from "../../types";

describe("authenticateUser without DB authentication", () => {
  let originalUseDbAuthentication: typeof config.USE_DB_AUTHENTICATION;

  beforeEach(() => {
    originalUseDbAuthentication = config.USE_DB_AUTHENTICATION;
    config.USE_DB_AUTHENTICATION = false;
  });

  afterEach(() => {
    config.USE_DB_AUTHENTICATION = originalUseDbAuthentication;
  });

  it("returns a mock ACUC chunk so shared auth middleware can populate req.acuc", async () => {
    const auth = await authenticateUser(
      { headers: {}, socket: {} },
      {},
      RateLimiterMode.ExtractAgentPreview,
    );

    expect(auth.success).toBe(true);
    if (!auth.success) {
      throw new Error("Expected authentication to succeed");
    }
    expect(auth.team_id).toBe("bypass");
    expect(auth.chunk).toBeDefined();
    expect(auth.chunk?.api_key).toBe("bypass");
    expect(auth.chunk?.api_key_id).toBe(0);
    expect(auth.chunk?.team_id).toBe("bypass");
    expect(auth.chunk?.is_extract).toBe(true);
  });
});
