import { describe, test, expect, jest } from "@jest/globals";
import { getCrawlStatus } from "../../../v2/methods/crawl";
import { getBatchScrapeStatus } from "../../../v2/methods/batch";
import { getMonitorCheck } from "../../../v2/methods/monitor";

describe("JS SDK v2 pagination", () => {
  function makeHttp(getImpl: (url: string) => any) {
    return { get: jest.fn(async (u: string) => getImpl(u)) } as any;
  }

  test("crawl: autoPaginate=false returns next", async () => {
    const first = { status: 200, data: { success: true, status: "completed", completed: 1, total: 2, next: "https://api/next", data: [{ markdown: "a" }] } };
    const http = makeHttp(() => first);
    const res = await getCrawlStatus(http, "job1", { autoPaginate: false });
    expect(res.data.length).toBe(1);
    expect(res.next).toBe("https://api/next");
  });

  test("crawl: default autoPaginate aggregates and nulls next", async () => {
    const first = { status: 200, data: { success: true, status: "completed", completed: 1, total: 3, next: "https://api/n1", data: [{ markdown: "a" }] } };
    const second = { status: 200, data: { success: true, next: "https://api/n2", data: [{ markdown: "b" }] } };
    const third = { status: 200, data: { success: true, next: null, data: [{ markdown: "c" }] } };
    const http = makeHttp((url) => {
      if (url.includes("/v2/crawl/")) return first;
      if (url.endsWith("n1")) return second;
      return third;
    });
    const res = await getCrawlStatus(http, "job1");
    expect(res.data.length).toBe(3);
    expect(res.next).toBeNull();
  });

  test("crawl: respects maxPages and maxResults", async () => {
    const first = { status: 200, data: { success: true, status: "completed", completed: 1, total: 10, next: "https://api/n1", data: [{ markdown: "a" }] } };
    const page = (n: number) => ({ status: 200, data: { success: true, next: n < 3 ? `https://api/n${n + 1}` : null, data: [{ markdown: `p${n}` }] } });
    const http = makeHttp((url) => {
      if (url.includes("/v2/crawl/")) return first;
      if (url.endsWith("n1")) return page(1);
      if (url.endsWith("n2")) return page(2);
      return page(3);
    });
    const res = await getCrawlStatus(http, "job1", { autoPaginate: true, maxPages: 2, maxResults: 2 });
    expect(res.data.length).toBe(2);
  });

  test("batch: default autoPaginate aggregates and nulls next", async () => {
    const first = { status: 200, data: { success: true, status: "completed", completed: 1, total: 3, next: "https://api/b1", data: [{ markdown: "a" }] } };
    const second = { status: 200, data: { success: true, next: "https://api/b2", data: [{ markdown: "b" }] } };
    const third = { status: 200, data: { success: true, next: null, data: [{ markdown: "c" }] } };
    const http = makeHttp((url) => {
      if (url.includes("/v2/batch/scrape/")) return first;
      if (url.endsWith("b1")) return second;
      return third;
    });
    const res = await getBatchScrapeStatus(http, "jobB");
    expect(res.data.length).toBe(3);
    expect(res.next).toBeNull();
  });

  test("batch: autoPaginate=false returns next", async () => {
    const first = { status: 200, data: { success: true, status: "completed", completed: 1, total: 2, next: "https://api/nextBatch", data: [{ markdown: "a" }] } };
    const http = makeHttp(() => first);
    const res = await getBatchScrapeStatus(http, "jobB", { autoPaginate: false });
    expect(res.data.length).toBe(1);
    expect(res.next).toBe("https://api/nextBatch");
  });

  test("monitor check: default autoPaginate aggregates pages and nulls next", async () => {
    const first = { status: 200, data: { success: true, next: "https://api/m1", data: { id: "check1", monitorId: "mon1", status: "completed", trigger: "manual", billingStatus: "confirmed", summary: {}, createdAt: "now", updatedAt: "now", pages: [{ url: "a", status: "changed" }], next: "https://api/m1" } } };
    const second = { status: 200, data: { success: true, next: null, data: { pages: [{ url: "b", status: "same" }], next: null } } };
    const http = makeHttp((url) => {
      if (url.includes("/v2/monitor/")) return first;
      return second;
    });
    const res = await getMonitorCheck(http, "mon1", "check1");
    expect(res.pages.length).toBe(2);
    expect(res.next).toBeNull();
  });

  test("monitor check: autoPaginate=false returns next", async () => {
    const first = { status: 200, data: { success: true, next: "https://api/m1", data: { id: "check1", monitorId: "mon1", status: "completed", trigger: "manual", billingStatus: "confirmed", summary: {}, createdAt: "now", updatedAt: "now", pages: [{ url: "a", status: "changed" }], next: "https://api/m1" } } };
    const http = makeHttp(() => first);
    const res = await getMonitorCheck(http, "mon1", "check1", { autoPaginate: false });
    expect(res.pages.length).toBe(1);
    expect(res.next).toBe("https://api/m1");
  });

  test("crawl: maxWaitTime stops pagination after first page", async () => {
    const first = { status: 200, data: { success: true, status: "completed", completed: 1, total: 5, next: "https://api/n1", data: [{ markdown: "a" }] } };
    const p1 = { status: 200, data: { success: true, next: "https://api/n2", data: [{ markdown: "b" }] } };
    const http: any = makeHttp((url: string) => {
      if (url.includes("/v2/crawl/")) return first;
      if (url.endsWith("n1")) return p1;
      return { status: 200, data: { success: true, next: null, data: [{ markdown: "c" }] } };
    });
    const nowSpy = jest.spyOn(Date, "now");
    try {
      nowSpy
        .mockImplementationOnce(() => 0)   // started
        .mockImplementationOnce(() => 0)   // first loop check
        .mockImplementationOnce(() => 3000); // second loop check > maxWaitTime
      const res = await getCrawlStatus(http, "jobC", { autoPaginate: true, maxWaitTime: 1 });
      expect(res.data.length).toBe(2); // initial + first page
      expect((http.get as jest.Mock).mock.calls.length).toBe(2); // initial + n1 only
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("batch: maxWaitTime stops pagination after first page", async () => {
    const first = { status: 200, data: { success: true, status: "completed", completed: 1, total: 5, next: "https://api/b1", data: [{ markdown: "a" }] } };
    const p1 = { status: 200, data: { success: true, next: "https://api/b2", data: [{ markdown: "b" }] } };
    const http: any = makeHttp((url: string) => {
      if (url.includes("/v2/batch/scrape/")) return first;
      if (url.endsWith("b1")) return p1;
      return { status: 200, data: { success: true, next: null, data: [{ markdown: "c" }] } };
    });
    const nowSpy = jest.spyOn(Date, "now");
    try {
      nowSpy
        .mockImplementationOnce(() => 0)   // started
        .mockImplementationOnce(() => 0)   // first loop check
        .mockImplementationOnce(() => 3000); // second loop check > maxWaitTime
      const res = await getBatchScrapeStatus(http, "jobB", { autoPaginate: true, maxWaitTime: 1 });
      expect(res.data.length).toBe(2);
      expect((http.get as jest.Mock).mock.calls.length).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
  });
});


