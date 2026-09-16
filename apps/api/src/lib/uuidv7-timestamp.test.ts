import { uuidv7AgeMs, uuidv7TimestampMs } from "./uuidv7-timestamp";

// UUIDv7 with the timestamp field set to 2025-01-01T00:00:00.000Z.
const V7_ID = "01941f29-7c00-7abc-8def-0123456789ab";

describe("uuidv7TimestampMs", () => {
  it("decodes the millisecond timestamp of a v7 id", () => {
    const ts = uuidv7TimestampMs(V7_ID);
    expect(ts).not.toBeNull();
    expect(new Date(ts!).toISOString()).toBe("2025-01-01T00:00:00.000Z");
  });

  it("is case-insensitive", () => {
    expect(uuidv7TimestampMs(V7_ID.toUpperCase())).toBe(
      uuidv7TimestampMs(V7_ID),
    );
  });

  it("returns null for other UUID versions and non-UUID strings", () => {
    expect(
      uuidv7TimestampMs("452044ef-3d15-4da6-a677-a57a2389fbaf"),
    ).toBeNull(); // v4
    expect(uuidv7TimestampMs("scrape-123")).toBeNull();
    expect(uuidv7TimestampMs("")).toBeNull();
  });
});

describe("uuidv7AgeMs", () => {
  it("returns the elapsed time relative to the given clock", () => {
    const ts = uuidv7TimestampMs(V7_ID)!;
    expect(uuidv7AgeMs(V7_ID, ts + 5_600)).toBe(5_600);
  });

  it("returns null for non-v7 ids", () => {
    expect(uuidv7AgeMs("scrape-123")).toBeNull();
  });
});
