export type AbortInstance = {
  signal: AbortSignal;
  timesOutAt?: Date;
  tier: "external" | "scrape" | "engine";
  throwable: () => any;
};

export class AbortManager {
  private aborts: AbortInstance[] = [];
  private mappedController: AbortController | null = null;

  constructor(...instances: (AbortInstance | undefined | null)[]) {
    this.aborts = instances.filter(
      x => x !== undefined && x !== null,
    ) as AbortInstance[];
  }

  add(...instances: (AbortInstance | undefined | null)[]) {
    const pureInstances = instances.filter(
      x => x !== undefined && x !== null,
    ) as AbortInstance[];
    this.aborts.push(...pureInstances);

    if (this.mappedController !== null) {
      for (const abort of pureInstances) {
        abort.signal.addEventListener("abort", () => {
          this.mappedController?.abort(
            new AbortManagerThrownError(abort.tier, abort.throwable()),
          );
        });
      }
    }
  }

  child(...instances: (AbortInstance | undefined | null)[]): AbortManager {
    const manager = new AbortManager(
      ...this.aborts,
      ...(instances.filter(
        x => x !== undefined && x !== null,
      ) as AbortInstance[]),
    );
    return manager;
  }

  isAborted(): boolean {
    return this.aborts.some(x => x.signal.aborted);
  }

  throwIfAborted(): void {
    for (const abort of this.aborts) {
      if (abort.signal.aborted) {
        throw new AbortManagerThrownError(abort.tier, abort.throwable());
      }
    }
  }

  private _mapController() {
    this.mappedController = new AbortController();

    for (const abort of this.aborts) {
      abort.signal.addEventListener("abort", () => {
        this.mappedController?.abort(
          new AbortManagerThrownError(abort.tier, abort.throwable()),
        );
      });
    }
  }

  asSignal(): AbortSignal {
    if (this.mappedController === null) {
      this._mapController();
    }

    return this.mappedController!.signal;
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
  public inner: any;
  constructor(tier: AbortInstance["tier"], inner: any) {
    super("AbortManagerThrownError: " + tier);
    this.tier = tier;
    this.inner = inner;
  }
}
