import { reconstructKnownState, searchStatusToPageStatus } from "./persist";
import { canonicalizeUrl } from "./dedupe";

describe("searchStatusToPageStatus", () => {
  it("maps alert→new, skipped→error, rest→same", () => {
    expect(searchStatusToPageStatus("alert")).toBe("new");
    expect(searchStatusToPageStatus("skipped")).toBe("error");
    expect(searchStatusToPageStatus("already_seen")).toBe("same");
    expect(searchStatusToPageStatus("watching")).toBe("same");
    expect(searchStatusToPageStatus("ignored")).toBe("same");
  });
});

describe("reconstructKnownState", () => {
  it("rebuilds the dedup map keyed by canonical URL", () => {
    const { knownPages } = reconstructKnownState(
      [
        {
          url: "https://www.Example.com/A/",
          metadata: { fingerprint: "fp1", goalVersion: "gv1" },
        },
      ],
      "gv1",
    );
    expect(knownPages.get(canonicalizeUrl("https://example.com/a"))).toEqual({
      fingerprint: "fp1",
      goalVersion: "gv1",
      metadata: { fingerprint: "fp1", goalVersion: "gv1" },
    });
  });

  it("yields the search-internal lastStatus from metadata.searchStatus", () => {
    // last_status on monitor_pages stores the page-status mapping (alert→new),
    // so the search-internal status must come from metadata.searchStatus.
    const { knownPages } = reconstructKnownState(
      [
        {
          url: "https://a.com/1",
          metadata: {
            fingerprint: "f1",
            goalVersion: "gv1",
            searchStatus: "alert",
          },
          updated_at: "2026-06-10T00:00:00Z",
          last_status: "new",
        },
      ],
      "gv1",
    );
    const known = knownPages.get(canonicalizeUrl("https://a.com/1"))!;
    expect(known.lastStatus).toBe("alert");
    expect(known.lastCheckedAt).toBe("2026-06-10T00:00:00Z");
  });

  it("falls back to last_status for legacy rows without metadata.searchStatus", () => {
    const { knownPages } = reconstructKnownState(
      [
        {
          url: "https://a.com/1",
          metadata: { fingerprint: "f1", goalVersion: "gv1" },
          last_status: "same",
        },
      ],
      "gv1",
    );
    expect(knownPages.get(canonicalizeUrl("https://a.com/1"))!.lastStatus).toBe(
      "same",
    );
  });

  it("carries the full stored metadata through to KnownPage (reuse upserts need it)", () => {
    const meta = {
      fingerprint: "f1",
      goalVersion: "gv1",
      searchStatus: "alert",
      eventKey: "evt-1",
      eventLabel: "openai ipo",
      eventSatisfiedAt: "2026-06-01T00:00:00Z",
      eventAlertCount: 2,
    };
    const { knownPages } = reconstructKnownState(
      [{ url: "https://a.com/1", metadata: meta }],
      "gv1",
    );
    expect(
      knownPages.get(canonicalizeUrl("https://a.com/1"))!.metadata,
    ).toEqual(meta);
  });

  it("only includes events from the current goalVersion (goal change starts clean)", () => {
    const { knownEvents } = reconstructKnownState(
      [
        {
          url: "https://a.com",
          metadata: {
            fingerprint: "f1",
            goalVersion: "gv1",
            eventKey: "e1",
            eventLabel: "Event One",
          },
        },
        {
          url: "https://b.com",
          metadata: {
            fingerprint: "f2",
            goalVersion: "gvOLD",
            eventKey: "eOld",
            eventLabel: "Stale",
          },
        },
      ],
      "gv1",
    );
    expect(knownEvents).toEqual([{ key: "e1", label: "Event One" }]);
  });

  it("orders events most-recently-seen first (resolver window holds active stories)", () => {
    const page = (url: string, eventKey: string, updated_at: string) => ({
      url,
      metadata: {
        fingerprint: "f",
        goalVersion: "gv1",
        eventKey,
        eventLabel: eventKey,
      },
      updated_at,
    });
    const { knownEvents } = reconstructKnownState(
      [
        page("https://a.com", "old-story", "2026-01-01T00:00:00Z"),
        page("https://b.com", "active-story", "2026-01-02T00:00:00Z"),
        page("https://c.com", "old-story", "2026-06-01T00:00:00Z"),
      ],
      "gv1",
    );
    expect(knownEvents.map(e => e.key)).toEqual(["old-story", "active-story"]);
  });
});

describe("event state aggregation (jsonb stamps on alerting pages)", () => {
  it("aggregates satisfiedAt (earliest) and alertCount (highest) across pages", () => {
    const { knownEvents } = reconstructKnownState(
      [
        {
          url: "https://a.com/1",
          metadata: {
            fingerprint: "f1",
            goalVersion: "v1",
            eventKey: "evt-1",
            eventLabel: "openai ipo",
            eventSatisfiedAt: "2026-06-10T00:00:00Z",
            eventAlertCount: 1,
          },
          updated_at: "2026-06-10T00:00:00Z",
          last_status: "alert",
        },
        {
          url: "https://b.com/2",
          metadata: {
            fingerprint: "f2",
            goalVersion: "v1",
            eventKey: "evt-1",
            eventLabel: "openai ipo",
            eventSatisfiedAt: "2026-06-10T00:00:00Z",
            eventAlertCount: 3,
          },
          updated_at: "2026-06-11T00:00:00Z",
          last_status: "alert",
        },
      ],
      "v1",
    );
    expect(knownEvents).toHaveLength(1);
    expect(knownEvents[0]).toMatchObject({
      key: "evt-1",
      satisfiedAt: "2026-06-10T00:00:00Z",
      alertCount: 3,
    });
  });

  it("legacy rows without stamps still reconstruct the event (no state fields)", () => {
    const { knownEvents } = reconstructKnownState(
      [
        {
          url: "https://a.com/1",
          metadata: {
            fingerprint: "f1",
            goalVersion: "v1",
            eventKey: "evt-legacy",
            eventLabel: "old event",
          },
          updated_at: "2026-06-09T00:00:00Z",
          last_status: "alert",
        },
      ],
      "v1",
    );
    expect(knownEvents).toEqual([{ key: "evt-legacy", label: "old event" }]);
  });
});
