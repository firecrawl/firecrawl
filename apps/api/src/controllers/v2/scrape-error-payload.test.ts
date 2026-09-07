import {
  composeTimeoutProcessing,
  ScrapeJobTimeoutError,
  TransportableError,
} from "../../lib/error";
import {
  deserializeTransportableError,
  serializeTransportableError,
} from "../../lib/error-serde";
import { SiteError } from "../../scraper/scrapeURL/error";
import { scrapeErrorPayload } from "./scrape-error-payload";

const T0 = 1_756_200_000_000;

describe("scrapeErrorPayload SiteError details", () => {
  it("exposes tunnel failures as a retryable provider_proxy cause", () => {
    const e = new SiteError("ERR_TUNNEL_CONNECTION_FAILED");
    expect(scrapeErrorPayload(e)).toEqual({
      success: false,
      code: "SCRAPE_SITE_ERROR",
      error: e.message,
      details: {
        browserErrorCode: "ERR_TUNNEL_CONNECTION_FAILED",
        retryable: true,
        origin: "provider_proxy",
      },
    });
  });

  it("exposes ERR_PROXY_CONNECTION_FAILED the same way as tunnel failures", () => {
    const details = scrapeErrorPayload(
      new SiteError("ERR_PROXY_CONNECTION_FAILED"),
    ).details;
    expect(details).toEqual({
      browserErrorCode: "ERR_PROXY_CONNECTION_FAILED",
      retryable: true,
      origin: "provider_proxy",
    });
  });

  it("marks target-site browser codes as not retryable", () => {
    const details = scrapeErrorPayload(new SiteError("ERR_TIMED_OUT")).details;
    expect(details).toEqual({
      browserErrorCode: "ERR_TIMED_OUT",
      retryable: false,
      origin: "target_site",
    });
  });

  it("keeps unknown Chromium codes as target_site", () => {
    const details = scrapeErrorPayload(
      new SiteError("ERR_CONNECT_REFUSED"),
    ).details;
    expect(details).toEqual({
      browserErrorCode: "ERR_CONNECT_REFUSED",
      retryable: false,
      origin: "target_site",
    });
  });

  it("survives the worker to controller serde round trip", () => {
    const original = new SiteError("ERR_TUNNEL_CONNECTION_FAILED");
    const revived = deserializeTransportableError(
      serializeTransportableError(original),
    );
    expect(revived).toBeInstanceOf(SiteError);
    expect(scrapeErrorPayload(revived as SiteError).details).toEqual({
      browserErrorCode: "ERR_TUNNEL_CONNECTION_FAILED",
      retryable: true,
      origin: "provider_proxy",
    });
  });

  it("does not attach site details to other transportable errors", () => {
    expect(
      scrapeErrorPayload(new TransportableError("UNKNOWN_ERROR", "nope")),
    ).toEqual({
      success: false,
      code: "UNKNOWN_ERROR",
      error: "nope",
    });
  });

  it("still attaches timeout processing details", () => {
    const { message, details } = composeTimeoutProcessing({
      pagesEstimate: 700,
      submittedAtMs: T0,
      lastStatus: "running",
      nowMs: T0 + 60_000,
    });
    const payload = scrapeErrorPayload(
      new ScrapeJobTimeoutError(message, details),
    );
    expect(payload.details).toEqual(details);
    expect(payload.details).not.toHaveProperty("browserErrorCode");
  });
});
