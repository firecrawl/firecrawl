import { Histogram } from "prom-client";

export const jobDurationSeconds = new Histogram({
  name: "job_duration_seconds",
  help: "Duration of background jobs in seconds",
  labelNames: ["type", "status"],
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 900, 1800, 3600],
});
