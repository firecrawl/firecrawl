import { EventEmitter } from "events";
import { ScrapeJobCancelledError } from "../../scraper/scrapeURL/error";
import { oldExtract } from "../v1/extract";

jest.mock("../../services/rate-limiter", () => {
  const { EventEmitter } = require("events");
  const client = new EventEmitter();
  client.status = "ready";
  client.set = jest.fn();
  client.get = jest.fn();
  client.expire = jest.fn();
  client.del = jest.fn();
  client.on = client.addListener.bind(client);
  return { redisRateLimitClient: client };
});

jest.mock("../../services/redis", () => {
  const noop = async () => {};
  return {
    setValue: jest.fn(),
    getValue: jest.fn(),
    deleteKey: jest.fn(),
    redisEvictConnection: {
      set: noop,
      get: async () => null,
      del: noop,
      exists: async () => 0,
      on: () => {},
    },
  };
});

jest.mock("../../services/webhook", () => ({
  WebhookEvent: {
    EXTRACT_STARTED: "EXTRACT_STARTED",
    EXTRACT_COMPLETED: "EXTRACT_COMPLETED",
    EXTRACT_FAILED: "EXTRACT_FAILED",
  },
  createWebhookSender: jest.fn().mockResolvedValue({
    send: jest.fn(),
  }),
}));

jest.mock("../../lib/extract/extraction-service", () => ({
  performExtraction: jest.fn(),
}));

jest.mock("../../lib/extract/fire-0/extraction-service-f0", () => ({
  performExtraction_F0: jest.fn(),
}));

const { performExtraction } = jest.requireMock(
  "../../lib/extract/extraction-service",
);
const { createWebhookSender } = jest.requireMock("../../services/webhook");

class MockResponse {
  public statusCode = 0;
  public body: any = null;
  public headersSent = false;
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  json(payload: any) {
    this.body = payload;
    this.headersSent = true;
    return this;
  }
}

class MockRequest extends EventEmitter {
  body: any;
  auth: any;
  acuc: any;
  account?: any;
}

describe("oldExtract", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 499 when the client disconnects", async () => {
    let triggerCancel: (error?: unknown) => void = () => {};
    (performExtraction as jest.Mock).mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          triggerCancel = reject as (error?: unknown) => void;
        }),
    );

    const req = new MockRequest();
    req.body = {
      urls: ["https://example.com"],
      webhook: { url: "https://example.com/webhook" },
      agent: { model: "fire-1" },
      origin: "api",
    };
    req.auth = { team_id: "team-1" };
    req.acuc = { sub_id: null, api_key_id: 42, flags: null };

    const res = new MockResponse();

    const promise = oldExtract(req as any, res as any, "extract-1");
    await Promise.resolve();
    req.emit("close");
    triggerCancel(new ScrapeJobCancelledError());

    await promise;

    expect(res.statusCode).toBe(499);
    expect(res.body).toEqual({ success: false, error: "Client disconnected" });
    expect(performExtraction).toHaveBeenCalledWith(
      "extract-1",
      expect.objectContaining({
        teamId: "team-1",
        abortSignal: expect.any(AbortSignal),
      }),
    );

    const sender = await createWebhookSender.mock.results[0].value;
    expect(sender.send).toHaveBeenCalledWith("EXTRACT_FAILED", {
      success: false,
      error: "Client disconnected",
    });
  });
});
