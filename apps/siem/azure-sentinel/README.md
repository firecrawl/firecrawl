# SIEM Logging for Microsoft Sentinel

Deployment artifacts for sending Firecrawl scrape activity to Microsoft
Sentinel through the Azure Monitor Logs Ingestion API.

## Files

- `azuredeploy.json` creates the data collection endpoint and rule.
- `DCR.json` contains the CCF data collection rule and ASIM transform.
- `connectorDefinition.json` and `dataConnector.json` define the CCF Push
  connector.
- `sample-event.json` is a valid input-stream event.

The database schema is maintained as a migration in the Firecrawl database
repository, not in this package.

## Severity

The DCR transform derives ASim `EventSeverity` from how a block was decided,
not from whether a category happens to be present:

- `High` — denied by `risk-score` with a classifier verdict, i.e. a
  provider-confirmed threat.
- `Low` — denied by any other rule (local blacklist, blocked TLD, classifier
  unavailable under a closed failure policy).
- `Informational` — everything else, including scrapes that simply failed.

`Medium` is left unused so a workspace can claim it without colliding.

## Runtime

`PUT /v2/team/siem` stores an organization destination and its encrypted,
write-only client secret. Scrape activity is published to the RabbitMQ queue
`siem.logging.events`; index-worker replicas consume it, group events by
organization, and deliver one gzip batch per org. Messages carry the
organization ID and event, never the destination secret — the destination and
its secret are read fresh at delivery time, so disabling logging or rotating a
secret takes effect on events already in flight.

Operational shape of that queue:

- Bounded at 100k messages with `drop-head`, so a destination outage sheds the
  oldest events instead of growing without limit. The retry queues carry the
  same cap, and `siem.logging.dlq` is capped at 50k with a 7-day TTL — it exists
  for an operator to read, not as indefinite storage.
- Transient failures ride a fixed-delay retry ladder (5s, 30s, 5m, 30m) built
  from TTL queues that dead-letter back onto the main queue; a destination's
  `Retry-After` rounds up to the smallest rung that satisfies it.
- Bad credentials or a rejected DCR schema dead-letter straight to
  `siem.logging.dlq` rather than burning the ladder. An event too large to
  compress under 1 MB on its own is dropped and counted, not dead-lettered —
  failing its batch would lose up to 199 deliverable events alongside it.
- Retries are at-least-once: a batch that fails partway through its ≤1 MB
  sub-batches will resend the sub-batches that already landed.
- Publishes are confirmed and `mandatory`, and at most 10k may await a confirm
  at once. Beyond that the producer sheds events rather than accumulating them
  in the API process, which is the same bound the queue has, applied upstream.

Queue depth comes from `rabbitmq_prometheus`.
`firecrawl_siem_logging_events_total` breaks out per-event outcomes: `queued`,
`delivered`, `retried`, `dead_lettered`, `skipped_disabled`, `enqueue_failed`,
`delivery_failed`, `unparseable`, `unroutable`, `dropped_oversized` and
`dropped_producer_full`. The last three should normally be flat at zero; any of
them moving means events are being lost rather than delayed.

Set `SIEM_LOGGING_ENCRYPTION_KEY` in API and index-worker environments. If
partner egress is required, also set `PARTNER_EGRESS_PROXY_URL` and allowlist
`login.microsoftonline.com` plus `*.ingest.monitor.azure.com` on the proxy.

Use `POST /v2/team/siem/test` to validate credentials and the destination
schema after deploying the Azure artifacts.
