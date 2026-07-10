import Express, {
  type Express as ExpressApplication,
  type Request,
  type Response,
} from "express";

export type NuqWorkerHttpOptions = {
  isDraining: () => boolean;
  dependencyReady: () => Promise<boolean>;
  requiredLoopsReady?: () => boolean;
  metrics: () => string | Promise<string>;
  readinessTimeoutMs?: number;
  onReadinessError?: (error: unknown) => void;
  onMetricsError?: (error: unknown) => void;
};

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Creates the shared worker HTTP surface. Liveness intentionally has no
 * dependency checks: Kubernetes must not restart a healthy process merely
 * because FoundationDB (or another queue backend) is temporarily unavailable.
 */
export function createNuqWorkerHttpApp(
  options: NuqWorkerHttpOptions,
): ExpressApplication {
  const app = Express();

  app.get("/live", (_req, res) => {
    res.status(200).send("OK");
  });

  const readiness = async (_req: Request, res: Response) => {
    try {
      if (options.isDraining() || options.requiredLoopsReady?.() === false) {
        res.status(503).send("Not Ready");
        return;
      }

      const ready = await withTimeout(
        options.dependencyReady(),
        options.readinessTimeoutMs ?? 1_000,
        "NuQ dependency readiness check",
      );
      res.status(ready ? 200 : 503).send(ready ? "OK" : "Not Ready");
    } catch (error) {
      options.onReadinessError?.(error);
      res.status(503).send("Not Ready");
    }
  };

  app.get("/ready", readiness);
  // Compatibility for existing probes and operators. New deployments use the
  // explicit live/ready endpoints.
  app.get("/health", readiness);

  app.get("/metrics", async (_req, res) => {
    try {
      res.contentType("text/plain").send(await options.metrics());
    } catch (error) {
      options.onMetricsError?.(error);
      res.status(500).send("Metrics unavailable");
    }
  });

  return app;
}
