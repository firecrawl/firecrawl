export type AbortInstance = {
  signal: AbortSignal;
  timesOutAt?: Date;
  tier: "external" | "scrape" | "engine";
  throwable: () => Error;
};

function isAbortInstance(
  value: AbortInstance | undefined | null,
): value is AbortInstance {
  return value !== undefined && value !== null;
}

export class AbortManager {
  private aborts: Array<AbortInstance> = [];
  private mappedController: AbortController | null = null;
  private listeners: Array<{ signal: AbortSignal; handler: () => void }> = [];

  constructor(...instances: Array<AbortInstance | undefined | null>) {
    this.aborts = instances.filter(isAbortInstance);
  }

  dispose() {
    for (const { signal, handler } of this.listeners) {
      signal.removeEventListener("abort", handler);
    }

    this.listeners = [];
    this.aborts = [];
    this.mappedController = null;
  }

  private resolveInner(abort: AbortInstance) {
    try {
      return abort.throwable();
    } catch (error: unknown) {
      return error;
    }
  }

  private register(abort: AbortInstance) {
    if (abort.signal.aborted) {
      if (!this.mappedController || this.mappedController.signal.aborted) {
        return;
      }
      const inner = this.resolveInner(abort);
      this.mappedController.abort(
        new AbortManagerThrownError(abort.tier, inner),
      );
      return;
    }

    const handler = () => {
      if (!this.mappedController) {
        return;
      }

      const inner = this.resolveInner(abort);
      const reason = new AbortManagerThrownError(abort.tier, inner);

      this.mappedController.abort(reason);
    };

    abort.signal.addEventListener("abort", handler);
    this.listeners.push({ signal: abort.signal, handler });
  }

  add(...instances: Array<AbortInstance | undefined | null>) {
    const pureInstances = instances.filter(isAbortInstance);
    this.aborts.push(...pureInstances);

    if (this.mappedController !== null) {
      for (const abort of pureInstances) {
        this.register(abort);
      }
    }
  }

  child(...instances: Array<AbortInstance | undefined | null>): AbortManager {
    const manager = new AbortManager(
      ...this.aborts,
      ...instances.filter(isAbortInstance),
    );
    return manager;
  }

  isAborted(): boolean {
    return this.aborts.some(x => x.signal.aborted);
  }

  throwIfAborted(): void {
    for (const abort of this.aborts) {
      if (abort.signal.aborted) {
        const inner = this.resolveInner(abort);
        throw new AbortManagerThrownError(abort.tier, inner);
      }
    }
  }

  private _mapController(): AbortController {
    const controller = new AbortController();
    this.mappedController = controller;

    for (const abort of this.aborts) {
      this.register(abort);
    }

    return controller;
  }

  asSignal(): AbortSignal {
    const controller = this.mappedController ?? this._mapController();
    return controller.signal;
  }

  scrapeTimeout(): number | undefined {
    const timeouts = this.aborts
      .filter(x => x.tier === "scrape")
      .map(x => x.timesOutAt)
      .filter(x => x !== undefined);
    if (timeouts.length === 0) {
      return undefined;
    }
    return Math.min(...timeouts.map(x => x.getTime())) - Date.now();
  }

  engineNearestTimeout(): number | undefined {
    const timeouts = this.aborts
      .filter(x => x.tier === "engine")
      .map(x => x.timesOutAt)
      .filter(x => x !== undefined);
    if (timeouts.length === 0) {
      return undefined;
    }
    return Math.min(...timeouts.map(x => x.getTime())) - Date.now();
  }
}

export class AbortManagerThrownError extends Error {
  name = "AbortManagerThrownError";
  public tier: AbortInstance["tier"];
  public inner: unknown;
  constructor(tier: AbortInstance["tier"], inner: unknown) {
    super("AbortManagerThrownError: " + tier);
    this.tier = tier;
    this.inner = inner;
  }
}
