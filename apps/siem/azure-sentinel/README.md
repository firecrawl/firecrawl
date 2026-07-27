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

## Runtime

`PUT /v2/team/siem` stores an organization destination and its encrypted,
write-only client secret. Scrape activity is placed on a shared BullMQ queue;
index-worker replicas consume that queue and retry transient delivery failures.
Queue jobs contain the organization ID and event, never the destination secret.

Set `SIEM_LOGGING_ENCRYPTION_KEY` in API and index-worker environments. If
partner egress is required, also set `PARTNER_EGRESS_PROXY_URL`.

Use `POST /v2/team/siem/test` to validate credentials and the destination
schema after deploying the Azure artifacts.
