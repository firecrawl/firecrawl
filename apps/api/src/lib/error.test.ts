import { JobCancelledError, TransportableError, UnknownError } from "./error";
import {
  deserializeTransportableError,
  serializeTransportableError,
} from "./error-serde";
import { isExpectedError } from "./otel-tracer";

describe("error classification for tracing", () => {
  it("treats coded errors as expected outcomes", () => {
    expect(
      isExpectedError(new TransportableError("SCRAPE_TIMEOUT", "timed out")),
    ).toBe(true);
    expect(isExpectedError(new JobCancelledError())).toBe(true);
  });

  it("keeps an unknown error's classification across the queue", () => {
    const revive = (error: UnknownError) =>
      deserializeTransportableError(serializeTransportableError(error));

    expect(
      isExpectedError(revive(new UnknownError(new JobCancelledError()))),
    ).toBe(true);
    expect(isExpectedError(revive(new UnknownError(new TypeError("x"))))).toBe(
      false,
    );
  });

  it("treats an unknown error as expected only when what it wraps is", () => {
    expect(isExpectedError(new UnknownError(new TypeError("null deref")))).toBe(
      false,
    );
    expect(isExpectedError(new UnknownError("string failure"))).toBe(false);
    expect(isExpectedError(new UnknownError(new JobCancelledError()))).toBe(
      true,
    );
  });
});
