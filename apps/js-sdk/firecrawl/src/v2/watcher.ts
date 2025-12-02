import { EventEmitter } from "events";
import type { BatchScrapeJob, CrawlJob, Document } from "./types";
import type { HttpClient } from "./utils/httpClient";
import { getBatchScrapeStatus } from "./methods/batch";
import { getCrawlStatus } from "./methods/crawl";
import { WebSocket as WS } from "ws";

type JobKind = "crawl" | "batch";

export interface WatcherOptions {
  kind?: JobKind;
  pollInterval?: number; // seconds
  timeout?: number; // seconds
}

type Snapshot = CrawlJob | BatchScrapeJob;

export class Watcher extends EventEmitter {
  private readonly http: HttpClient;
  private readonly jobId: string;
  private readonly kind: JobKind;
  private readonly pollInterval: number;
  private readonly timeout?: number;
  private ws?: WebSocket;
  private closed = false;

  constructor(http: HttpClient, jobId: string, opts: WatcherOptions = {}) {
    super();
    this.http = http;
    this.jobId = jobId;
    this.kind = opts.kind ?? "crawl";
    this.pollInterval = opts.pollInterval ?? 2;
    this.timeout = opts.timeout;
  }

  private buildWsUrl(): string {
    // replace http/https with ws/wss
    const apiUrl = this.http.getApiUrl();
    const wsBase = apiUrl.replace(/^http/, "ws");
    const path = this.kind === "crawl" ? `/v2/crawl/${this.jobId}` : `/v2/batch/scrape/${this.jobId}`;
    return `${wsBase}${path}`;
  }

  async start(): Promise<void> {
    try {
      const url = this.buildWsUrl();
      
      if (typeof WebSocket !== 'undefined') {
        this.ws = new WebSocket(url, this.http.getApiKey()) as any;
      } else {
        this.ws = new WS(url, this.http.getApiKey()) as any;
      }
      
      if (this.ws) {
        this.attachWsHandlers(this.ws);
      }
    } catch (err) {
      this.pollLoop();
    }
  }

  private attachWsHandlers(ws: WebSocket) {
    let startTs = Date.now();
    const timeoutMs = this.timeout ? this.timeout * 1000 : undefined;
    ws.onmessage = (ev: MessageEvent) => {
      try {
        const body = typeof ev.data === "string" ? JSON.parse(ev.data) : null;
        if (!body) return;
        const type = body.type as string | undefined;
        if (type === "error") {
          this.emit("error", { status: "failed", data: [], error: body.error, id: this.jobId });
          return;
        }
        if (type === "catchup") {
          const payload = body.data || {};
          this.emitDocuments(payload.data || []);
          this.emitSnapshot(payload);
          return;
        }
        if (type === "document") {
          const doc = body.data;
          if (doc) this.emit("document", doc as Document & { id: string });
          return;
        }
        if (type === "done") {
          const payload = body.data || body;
          const data = (payload.data || []) as Document[];
          this.emit("done", { status: "completed", data, id: this.jobId });
          this.close();
          return;
        }
        const payload = body.data || body;
        if (payload && payload.status) this.emitSnapshot(payload);
      } catch {
        // ignore
      }
      if (timeoutMs && Date.now() - startTs > timeoutMs) this.close();
    };
    ws.onerror = () => {
      this.emit("error", { status: "failed", data: [], error: "WebSocket error", id: this.jobId });
      this.close();
    };
    ws.onclose = () => {
      if (!this.closed) this.pollLoop();
    };
  }

  private emitDocuments(docs: Document[]) {
    for (const doc of docs) this.emit("document", { ...(doc as any), id: this.jobId });
  }

  private emitSnapshot(payload: any) {
    const status = payload.status as Snapshot["status"];
    const data = (payload.data || []) as Document[];
    const snap: Snapshot = this.kind === "crawl"
      ? {
          id: this.jobId,
          status,
          completed: payload.completed ?? 0,
          total: payload.total ?? 0,
          creditsUsed: payload.creditsUsed,
          expiresAt: payload.expiresAt,
          next: payload.next ?? null,
          data,
        }
      : {
          id: this.jobId,
          status,
          completed: payload.completed ?? 0,
          total: payload.total ?? 0,
          creditsUsed: payload.creditsUsed,
          expiresAt: payload.expiresAt,
          next: payload.next ?? null,
          data,
        };
    this.emit("snapshot", snap);
    if (["completed", "failed", "cancelled"].includes(status)) {
      this.emit("done", { status, data, id: this.jobId });
      this.close();
    }
  }

  private async pollLoop() {
    const startTs = Date.now();
    const timeoutMs = this.timeout ? this.timeout * 1000 : undefined;
    while (!this.closed) {
      try {
        const snap = this.kind === "crawl"
          ? await getCrawlStatus(this.http as any, this.jobId)
          : await getBatchScrapeStatus(this.http as any, this.jobId);
        this.emit("snapshot", snap);
        if (["completed", "failed", "cancelled"].includes(snap.status)) {
          this.emit("done", { status: snap.status, data: snap.data, id: this.jobId });
          this.close();
          break;
        }
      } catch {
        // ignore polling errors
      }
      if (timeoutMs && Date.now() - startTs > timeoutMs) break;
      await new Promise((r) => setTimeout(r, Math.max(1000, this.pollInterval * 1000)));
    }
  }

  close() {
    this.closed = true;
    if (this.ws && (this.ws as any).close) (this.ws as any).close();
  }
}

