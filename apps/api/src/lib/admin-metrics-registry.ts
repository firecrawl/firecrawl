export type AdminMetricsCollector = () => string | Promise<string>;

const extraMetricsCollectors: AdminMetricsCollector[] = [];

/** Registers an additional Prometheus text collector appended to /metrics. */
export function registerAdminMetricsCollector(
  collector: AdminMetricsCollector,
): void {
  if (!extraMetricsCollectors.includes(collector)) {
    extraMetricsCollectors.push(collector);
  }
}

/** Returns registered admin metrics collectors. */
export function getAdminMetricsCollectors(): readonly AdminMetricsCollector[] {
  return extraMetricsCollectors;
}
