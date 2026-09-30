const mocks = vi.hoisted(() => ({ robustFetch: vi.fn() }));
vi.mock("../lib/fetch", () => ({ robustFetch: mocks.robustFetch }));
vi.mock("../../../config", () => ({
  config: { FIRE_EXCHANGE_URL: "https://exchange.example" },
}));
vi.mock("../../../lib/exchange", () => ({
  getExchangeRequestLogContext: (url: string) => ({ url }),
  getExchangeResponseLogContext: () => ({}),
}));
vi.mock("../../../lib/otel-tracer", () => ({
  withSpan: (_name: string, fn: (span: object) => unknown) => fn({}),
  setSpanAttributes: () => {},
}));
import { DataSourceRateLimitedError, EngineError } from "../error";
import {
  deserializeTransportableError,
  serializeTransportableError,
} from "../../../lib/error-serde";
import { scrapeURLWithExchange } from "./exchange";

const logger = { info: vi.fn(), warn: vi.fn(), child: () => logger };
const meta = {
  id: "scrape-1",
  url: "https://profiles.example/person/a",
  options: {},
  internalOptions: { teamId: "team" },
  logger,
  mock: null,
  abort: { asSignal: () => undefined },
} as any;

const scrapeRejection = (body: unknown) => {
  mocks.robustFetch.mockImplementation(async ({ schema }) =>
    schema.parse(body),
  );
  return scrapeURLWithExchange(meta).catch(error => error);
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scrapeURLWithExchange rate limits", () => {
  it("throws DataSourceRateLimitedError for a nested scrape error", async () => {
    const error = await scrapeRejection({
      success: false,
      requestId: "r",
      error: {
        code: "provider_rate_limited",
        message: "Busy.",
        retryable: true,
        retryAfterSeconds: 7.2,
      },
    });
    expect(error).toBeInstanceOf(DataSourceRateLimitedError);
    expect(error.code).toBe("SCRAPE_DATA_SOURCE_RATE_LIMITED");
    expect(error.retryAfterSeconds).toBe(8);
    expect(error.message).toBe(
      "The data source is rate-limiting requests. Retry after 8 seconds.",
    );
  });

  it("reads a top-level code and retry interval beside a string error", async () => {
    const error = await scrapeRejection({
      code: "rate_limited",
      error: "Busy.",
      retryAfterSeconds: 3,
    });
    expect(error).toBeInstanceOf(DataSourceRateLimitedError);
    expect(error.retryAfterSeconds).toBe(3);
  });

  it("still throws the rate-limit error when no interval is given", async () => {
    const error = await scrapeRejection({
      success: false,
      error: { code: "provider_rate_limited", message: "Busy." },
    });
    expect(error).toBeInstanceOf(DataSourceRateLimitedError);
    expect(error.retryAfterSeconds).toBeUndefined();
    expect(error.message).toBe(
      "The data source is rate-limiting requests. Retry later.",
    );
  });

  it("keeps other failures as an engine error", async () => {
    const error = await scrapeRejection({
      success: false,
      error: { code: "provider_unavailable", message: "Down." },
    });
    expect(error).toBeInstanceOf(EngineError);
  });
});

describe("DataSourceRateLimitedError transport", () => {
  it("survives serialization across the worker boundary", () => {
    const revived = deserializeTransportableError(
      serializeTransportableError(new DataSourceRateLimitedError(12)),
    );
    expect(revived).toBeInstanceOf(DataSourceRateLimitedError);
    expect(revived.retryAfterSeconds).toBe(12);
    expect(revived.message).toBe(
      "The data source is rate-limiting requests. Retry after 12 seconds.",
    );
  });
});
