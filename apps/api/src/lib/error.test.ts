import { JobCancelledError, TransportableError, UnknownError } from "./error";
import { isExpectedError } from "./otel-tracer";

describe("error classification for tracing", () => {
  it("treats coded errors as expected outcomes", () => {
    expect(
      isExpectedError(new TransportableError("SCRAPE_TIMEOUT", "timed out")),
    ).toBe(true);
    expect(isExpectedError(new JobCancelledError())).toBe(true);
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
