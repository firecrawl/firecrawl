import type { WebhookQueueMessage } from "./types";
import { WebhookEvent } from "./types";

const { connectMock, channelMock, connectionMock } = vi.hoisted(() => {
  const channelMock = {
    checkQueue: vi.fn(),
    sendToQueue: vi.fn(() => true),
    close: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  const connectionMock = {
    createChannel: vi.fn(() => channelMock),
    on: vi.fn(),
    close: vi.fn(),
  };
  const connectMock = vi.fn(() => connectionMock);
  return { connectMock, channelMock, connectionMock };
});

vi.mock("amqplib", () => ({ default: { connect: connectMock } }));
vi.mock("../../config", () => ({
  config: { NUQ_RABBITMQ_URL: "amqp://test" },
}));
vi.mock("../../lib/logger", () => {
  const mk = (): Record<string, unknown> => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => mk(),
  });
  return { logger: mk() };
});

const message: WebhookQueueMessage = {
  webhook_url: "https://hook.example",
  payload: {
    success: true,
    type: WebhookEvent.CRAWL_PAGE,
    webhookId: "webhook-1",
    id: "crawl-1",
    data: [{ markdown: "page" }],
  },
  headers: {},
  team_id: "team-1",
  job_id: "crawl-1",
  scrape_id: "scrape-1",
  event: WebhookEvent.CRAWL_PAGE,
  timeout_ms: 10000,
};

async function freshQueue() {
  vi.resetModules();
  return (await import("./queue.js")).webhookQueue;
}

describe("webhook queue routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockReturnValue(connectionMock);
    connectionMock.createChannel.mockReturnValue(channelMock);
    channelMock.checkQueue.mockResolvedValue(undefined);
    channelMock.sendToQueue.mockReturnValue(true);
  });

  it("publishes zero data retention webhooks to the expiring ZDR queue with a timestamp", async () => {
    const queue = await freshQueue();
    await queue.publish(message, { zeroDataRetention: true });

    expect(channelMock.sendToQueue).toHaveBeenCalledTimes(1);
    const [name, , options] = channelMock.sendToQueue.mock.calls[0] as any[];
    expect(name).toBe("webhooks.zdr");
    expect(options).toMatchObject({
      persistent: true,
      contentType: "application/json",
    });
    expect(typeof options.timestamp).toBe("number");
  });

  it("publishes other webhooks to the default queue without a timestamp", async () => {
    const queue = await freshQueue();
    await queue.publish(message);

    const [name, , options] = channelMock.sendToQueue.mock.calls[0] as any[];
    expect(name).toBe("webhooks");
    expect(options).toEqual({
      persistent: true,
      contentType: "application/json",
    });
  });

  it("refuses to publish when the ZDR queue has not been declared", async () => {
    channelMock.checkQueue.mockImplementation(async (name: string) => {
      if (name === "webhooks.zdr") throw new Error("NOT_FOUND - no queue");
    });
    const queue = await freshQueue();

    await expect(
      queue.publish(message, { zeroDataRetention: true }),
    ).rejects.toThrow("NOT_FOUND");
    expect(channelMock.sendToQueue).not.toHaveBeenCalled();
  });
});
