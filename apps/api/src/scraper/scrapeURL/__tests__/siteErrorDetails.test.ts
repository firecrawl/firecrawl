import { ScrapeJobTimeoutError, TransportableError } from "../../../lib/error";
import {
  deserializeTransportableError,
  serializeTransportableError,
} from "../../../lib/error-serde";
import { getSiteErrorDetails, SiteError } from "../error";

describe("getSiteErrorDetails", () => {
  it("exposes tunnel failures as a retryable provider_proxy cause", () => {
    expect(
      getSiteErrorDetails(new SiteError("ERR_TUNNEL_CONNECTION_FAILED")),
    ).toEqual({
      browserErrorCode: "ERR_TUNNEL_CONNECTION_FAILED",
      retryable: true,
      origin: "provider_proxy",
    });
  });

  it("exposes ERR_PROXY_CONNECTION_FAILED the same way as tunnel failures", () => {
    expect(
      getSiteErrorDetails(new SiteError("ERR_PROXY_CONNECTION_FAILED")),
    ).toEqual({
      browserErrorCode: "ERR_PROXY_CONNECTION_FAILED",
      retryable: true,
      origin: "provider_proxy",
    });
  });

  it("marks target-site browser codes as origin target_site", () => {
    expect(getSiteErrorDetails(new SiteError("ERR_TIMED_OUT"))).toEqual({
      browserErrorCode: "ERR_TIMED_OUT",
      retryable: false,
      origin: "target_site",
    });
  });

  it("keeps unknown Chromium codes as target_site", () => {
    expect(getSiteErrorDetails(new SiteError("ERR_CONNECT_REFUSED"))).toEqual({
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
    expect(getSiteErrorDetails(revived)).toEqual({
      browserErrorCode: "ERR_TUNNEL_CONNECTION_FAILED",
      retryable: true,
      origin: "provider_proxy",
    });
  });

  it("ignores non-SiteError values", () => {
    expect(
      getSiteErrorDetails(new TransportableError("UNKNOWN_ERROR", "nope")),
    ).toBeUndefined();
    expect(getSiteErrorDetails(new ScrapeJobTimeoutError())).toBeUndefined();
    expect(getSiteErrorDetails(new Error("nope"))).toBeUndefined();
  });
});
