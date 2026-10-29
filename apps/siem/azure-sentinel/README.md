# SIEM Logging for Microsoft Sentinel

Deployment artifacts for sending Firecrawl scrape activity to Microsoft
Sentinel through the Azure Monitor Logs Ingestion API.

## Files

- `azuredeploy.json` creates the data collection endpoint and rule. This is the
  only artifact needed to make ingestion work, and the only one the dashboard's
  "Deploy to Azure" button uses.
- `DCR.json` contains the CCF data collection rule and ASim transform. It is a
  fragment of a Sentinel solution package — it references variables defined by
  its container, so it is not independently deployable.
- `connectorDefinition.json` and `dataConnector.json` define the CCF Push
  connector, which only affects how the integration appears in Sentinel's data
  connector gallery. Ingestion does not depend on them.
- `sample-event.json` is a valid input-stream event.

The database schema is maintained as a migration in the Firecrawl database
repository, not in this package.

## Customer setup

Three steps, in this order — the credential step needs the rule's resource ID,
which only exists after the deployment.

1. **Deploy the resources.** Use the dashboard's "Deploy to Azure" button, or
   deploy `azuredeploy.json` directly. It asks for the full resource ID of the
   Log Analytics workspace that should receive the events (workspace →
   Properties → Resource ID). It takes an ID rather than a name so the workspace
   does not have to live in the same resource group as the deployment.

2. **Create the identity and grant it access.** One command creates the app
   registration and the role assignment together, scoped to the rule that was
   just deployed:

   ```
   az ad sp create-for-rbac \
     --name firecrawl-siem \
     --role "Monitoring Metrics Publisher" \
     --scopes <dataCollectionRuleResourceId from the deployment outputs>
   ```

   It prints `tenant`, `appId` and `password`, which are the Tenant ID, Client ID
   and Client secret the dashboard asks for. Granting that role is not optional:
   without it the token is valid but ingestion returns 403, which surfaces as
   `invalid_credentials` and looks like a wrong secret.

3. **Paste and verify.** Enter the deployment outputs and the credentials in the
   dashboard, then save. The stream is only enabled after a test event is
   actually accepted.

### Deployment outputs

| Output | Used for |
| --- | --- |
| `dataCollectionEndpoint` | Data collection endpoint URL |
| `dataCollectionRuleImmutableId` | DCR immutable ID |
| `streamName` | Stream name |
| `dataCollectionRuleResourceId` | `--scopes` value in step 2 |

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
