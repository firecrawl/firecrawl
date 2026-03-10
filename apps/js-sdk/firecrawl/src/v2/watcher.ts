import { EventEmitter } from "events";
import type { BatchScrapeJob, CrawlJob, Document } from "./types";
import type { HttpClient } from "./utils/httpClient";
import { getBatchScrapeStatus } from "./methods/batch";
import { getCrawlStatus } from "./methods/crawl";
// Note: browsers/Deno expose globalThis.WebSocket, but many Node runtimes (<22.4 or without
// experimental flags) do not. We lazily fall back to node:undici.

type WebSocketConstructor = new (url: string, protocols?: string | string[]) => WebSocket;

const hasGlobalWebSocket = (): WebSocketConstructor | undefined => {
  if (typeof globalThis === "undefined") return undefined;
  const candidate = (globalThis as any).WebSocket;
  return typeof candidate === "function" ? (candidate as WebSocketConstructor) : undefined;
};

const isNodeRuntime = () => typeof process !== "undefined" && !!process.versions?.node;

let cachedWebSocket: WebSocketConstructor | undefined;
let loadPromise: Promise<WebSocketConstructor | undefined> | undefined;

const loadNodeWebSocket = async (): Promise<WebSocketConstructor | undefined> => {
  if (!isNodeRuntime()) return undefined;
  try {
    const undici = await import("node:undici");
    const ctor = (undici as any).WebSocket ?? (undici as any).default?.WebSocket;
    return typeof ctor === "function" ? (ctor as WebSocketConstructor) : undefined;
  } catch {
    return undefined;
  }
};

const getWebSocketCtor = async (): Promise<WebSocketConstructor | undefined> => {
  if (cachedWebSocket) return cachedWebSocket;
  const globalWs = hasGlobalWebSocket();
  if (globalWs) {
    cachedWebSocket = globalWs;
    return cachedWebSocket;
  }
  if (!loadPromise) {
    loadPromise = loadNodeWebSocket();
  }
  cachedWebSocket = await loadPromise;
  return cachedWebSocket;
};

const decoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : undefined;

const ensureUtf8String = (data: unknown): string | undefined => {
  if (typeof data === "string") return data;

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  const convertView = (view: ArrayBufferView): string | undefined => {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("utf8");
    }
    return decoder?.decode(view);
  };

  if (ArrayBuffer.isView(data)) {
    return convertView(data);
  }

  if (data instanceof ArrayBuffer) {
    return convertView(new Uint8Array(data));
  }

  return undefined;
};

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
  private readonly emittedDocumentKeys = new Set<string>();

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
      const wsCtor = await getWebSocketCtor();
      if (!wsCtor) {
        this.pollLoop();
        return;
      }
      this.ws = new wsCtor(url, this.http.getApiKey()) as any;
      if (this.ws && "binaryType" in this.ws) {
        (this.ws as any).binaryType = "arraybuffer";
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
        const raw = ensureUtf8String(ev.data);
        if (!raw) return;
        const body = JSON.parse(raw);
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
          if (data.length) this.emitDocuments(data);
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

  private documentKey(doc: Document): string {
    if (doc && typeof doc === "object") {
      const explicitId = (doc as any).id ?? (doc as any).docId ?? (doc as any).url;
      if (typeof explicitId === "string" && explicitId.length) {
        return explicitId;
      }
    }
    try {
      return JSON.stringify(doc);
    } catch {
      return `${Date.now()}-${Math.random()}`;
    }
  }

  private emitDocuments(docs: Document[]) {
    for (const doc of docs) {
      if (!doc) continue;
      const key = this.documentKey(doc);
      if (this.emittedDocumentKeys.has(key)) continue;
      this.emittedDocumentKeys.add(key);
      this.emit("document", { ...(doc as any), id: this.jobId });
    }
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
        this.emitDocuments((snap.data || []) as Document[]);
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

