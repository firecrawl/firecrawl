import { AxiosError } from "axios";
import { classifySearxngError, tbsToSearxngTimeRange } from "./searxng";

function httpError(status: number, code = "ERR_BAD_REQUEST"): AxiosError {
  return new AxiosError(
    `Request failed with status code ${status}`,
    code,
    undefined,
    undefined,
    { status, statusText: "", data: {}, headers: {}, config: {} as any } as any,
  );
}

describe("classifySearxngError", () => {
  it("classifies an axios abort (ERR_CANCELED) as a retryable timeout", () => {
    const info = classifySearxngError(new AxiosError("canceled", "ERR_CANCELED"));
    expect(info.kind).toBe("timeout");
    expect(info.retryable).toBe(true);
  });

  it("classifies ERR_NETWORK as a retryable network error", () => {
    const info = classifySearxngError(
      new AxiosError("connect ECONNREFUSED", "ERR_NETWORK"),
    );
    expect(info.kind).toBe("network");
    expect(info.retryable).toBe(true);
  });

  it("classifies a 5xx as a retryable http_server error with status", () => {
    const info = classifySearxngError(httpError(503, "ERR_BAD_RESPONSE"));
    expect(info.kind).toBe("http_server");
    expect(info.status).toBe(503);
    expect(info.retryable).toBe(true);
  });

  it("classifies 429 as http_client but still retryable (rate limit)", () => {
    const info = classifySearxngError(httpError(429));
    expect(info.kind).toBe("http_client");
    expect(info.status).toBe(429);
    expect(info.retryable).toBe(true);
  });

  it("classifies 404 as http_client and NOT retryable", () => {
    const info = classifySearxngError(httpError(404));
    expect(info.kind).toBe("http_client");
    expect(info.status).toBe(404);
    expect(info.retryable).toBe(false);
  });

  it("classifies 400 as http_client and NOT retryable", () => {
    const info = classifySearxngError(httpError(400));
    expect(info.kind).toBe("http_client");
    expect(info.retryable).toBe(false);
  });

  it("classifies a SyntaxError as a non-retryable parse error", () => {
    const info = classifySearxngError(new SyntaxError("Unexpected token <"));
    expect(info.kind).toBe("parse");
    expect(info.retryable).toBe(false);
  });

  it("classifies a generic Error as unknown and not retryable", () => {
    const info = classifySearxngError(new Error("boom"));
    expect(info.kind).toBe("unknown");
    expect(info.retryable).toBe(false);
  });

  it("is defensive against non-Error values", () => {
    const info = classifySearxngError(null);
    expect(info.kind).toBe("unknown");
    expect(info.retryable).toBe(false);
  });
});

describe("tbsToSearxngTimeRange", () => {
  it("maps qdr:d to day", () => {
    expect(tbsToSearxngTimeRange("qdr:d")).toBe("day");
  });
  it("maps qdr:w to week", () => {
    expect(tbsToSearxngTimeRange("qdr:w")).toBe("week");
  });
  it("maps qdr:m to month", () => {
    expect(tbsToSearxngTimeRange("qdr:m")).toBe("month");
  });
  it("maps qdr:y to year", () => {
    expect(tbsToSearxngTimeRange("qdr:y")).toBe("year");
  });
  it("maps qdr:h to day (SearXNG has no hour granularity)", () => {
    expect(tbsToSearxngTimeRange("qdr:h")).toBe("day");
  });
  it("is case-insensitive", () => {
    expect(tbsToSearxngTimeRange("QDR:W")).toBe("week");
  });
  it("trims surrounding whitespace", () => {
    expect(tbsToSearxngTimeRange(" qdr:d ")).toBe("day");
  });
  it("accepts a bare granularity letter", () => {
    expect(tbsToSearxngTimeRange("w")).toBe("week");
  });
  it("returns undefined for an unknown granularity", () => {
    expect(tbsToSearxngTimeRange("qdr:x")).toBeUndefined();
  });
  it("returns undefined for a custom date range", () => {
    expect(
      tbsToSearxngTimeRange("cdr:1,cd_min:1/1/2020,cd_max:1/1/2021"),
    ).toBeUndefined();
  });
  it("returns undefined for undefined input", () => {
    expect(tbsToSearxngTimeRange(undefined)).toBeUndefined();
  });
  it("returns undefined for empty string", () => {
    expect(tbsToSearxngTimeRange("")).toBeUndefined();
  });
});
