import type { BatchScrapeJob, CrawlJob, Document } from "./types";
import type { HttpClient } from "./utils/httpClient";
import { getBatchScrapeStatus } from "./methods/batch";
import { getCrawlStatus } from "./methods/crawl";

type WebSocketConstructor = new (url: string, protocols?: string | string[]) => WebSocket;

// Runtimes without a global WebSocket (Node before 22) poll instead.
const getWebSocketCtor = (): WebSocketConstructor | undefined => {
  const candidate = (globalThis as any).WebSocket;
  return typeof candidate === "function" ? (candidate as WebSocketConstructor) : undefined;
};

type Listener = ((...args: any[]) => void) & { listener?: Listener };

/** Node's EventEmitter API for the watcher, with no import of "events", so browser bundles load it. */
class Emitter {
  private readonly listenersByEvent = new Map<string | symbol, Listener[]>();
  private maxListeners = 10;

  on(event: string | symbol, listener: Listener): this {
    this.listenersByEvent.set(event, [...(this.listenersByEvent.get(event) ?? []), listener]);
    return this;
  }

  prependListener(event: string | symbol, listener: Listener): this {
    this.listenersByEvent.set(event, [listener, ...(this.listenersByEvent.get(event) ?? [])]);
    return this;
  }

  prependOnceListener(event: string | symbol, listener: Listener): this {
    return this.prependListener(event, this.onceWrapper(event, listener));
  }

  listeners(event: string | symbol): Listener[] {
    return (this.listenersByEvent.get(event) ?? []).map((entry) => entry.listener ?? entry);
  }

  rawListeners(event: string | symbol): Listener[] {
    return [...(this.listenersByEvent.get(event) ?? [])];
  }

  eventNames(): (string | symbol)[] {
    return [...this.listenersByEvent.keys()].filter((event) => this.listenerCount(event) > 0);
  }

  setMaxListeners(n: number): this {
    this.maxListeners = n;
    return this;
  }

  getMaxListeners(): number {
    return this.maxListeners;
  }

  addListener(event: string | symbol, listener: Listener): this {
    return this.on(event, listener);
  }

  once(event: string | symbol, listener: Listener): this {
    return this.on(event, this.onceWrapper(event, listener));
  }

  private onceWrapper(event: string | symbol, listener: Listener): Listener {
    const wrapped: Listener = (...args) => {
      this.off(event, wrapped);
      listener.apply(this, args);
    };
    wrapped.listener = listener;
    return wrapped;
  }

  off(event: string | symbol, listener: Listener): this {
    const current = this.listenersByEvent.get(event);
    if (!current) return this;
    for (let index = current.length - 1; index >= 0; index--) {
      if (current[index] !== listener && current[index]!.listener !== listener) continue;
      this.listenersByEvent.set(event, current.filter((_, i) => i !== index));
      break;
    }
    return this;
  }

  removeListener(event: string | symbol, listener: Listener): this {
    return this.off(event, listener);
  }

  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) this.listenersByEvent.clear();
    else this.listenersByEvent.delete(event);
    return this;
  }

  listenerCount(event: string | symbol): number {
    return this.listenersByEvent.get(event)?.length ?? 0;
  }

  emit(event: string | symbol, ...args: any[]): boolean {
    const current = this.listenersByEvent.get(event);
    if (!current?.length) {
      if (event === "error") throw args[0] instanceof Error ? args[0] : new Error(String(args[0]));
      return false;
    }
    for (const listener of [...current]) listener.apply(this, args);
    return true;
  }
}

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

export class Watcher extends Emitter {
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
    return new Promise<void>((resolve, reject) => {
      const onDone = () => { cleanup(); resolve(); };
      const onError = (err: any) => { cleanup(); resolve(); };
      const cleanup = () => {
        this.removeListener("done", onDone);
        this.removeListener("error", onError);
      };
      this.on("done", onDone);
      this.on("error", onError);

      (async () => {
        try {
          const url = this.buildWsUrl();
          const wsCtor = getWebSocketCtor();
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
      })();
    });
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
          if (doc) this.emitDocuments([doc]);
          return;
        }
        if (type === "done") {
          const payload = body.data || body;
          const data = (payload.data || []) as Document[];
          if (data.length) this.emitDocuments(data);
          this.emit("done", { status: "completed", data, id: this.jobId, total: payload.total, completed: payload.completed, creditsUsed: payload.creditsUsed });
          this.close();
          return;
        }
        const payload = body.data || body;
        if (payload && payload.status) this.emitSnapshot(payload);
      } catch {
        // ignore
      }
      if (timeoutMs && Date.now() - startTs > timeoutMs) {
        this.emit("error", { status: "failed", data: [], error: "Watcher timeout", id: this.jobId });
        this.close();
      }
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
      this.emit("done", { status, data, id: this.jobId, total: payload.total ?? 0, completed: payload.completed ?? 0, creditsUsed: payload.creditsUsed });
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
          this.emit("done", { status: snap.status, data: snap.data, id: this.jobId, total: (snap as any).total ?? 0, completed: (snap as any).completed ?? 0, creditsUsed: (snap as any).creditsUsed });
          this.close();
          break;
        }
      } catch {
        // ignore polling errors
      }
      if (timeoutMs && Date.now() - startTs > timeoutMs) {
        this.emit("error", { status: "failed", data: [], error: "Watcher timeout", id: this.jobId });
        this.close();
        break;
      }
      await new Promise((r) => setTimeout(r, Math.max(1000, this.pollInterval * 1000)));
    }
  }

  close() {
    this.closed = true;
    if (this.ws && (this.ws as any).close) (this.ws as any).close();
  }
}

