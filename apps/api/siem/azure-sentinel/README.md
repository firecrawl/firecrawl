# Azure Sentinel scrape activity connector

This package delivers native Firecrawl `ScrapeActivityEvent` records through
the Azure Monitor Logs Ingestion API and normalizes them into the standard
`ASimWebSessionLogs` table in the customer-owned DCR.

## Package contents

- `connectorDefinition.json`: Microsoft Sentinel CCF Push connector UI.
- `dataConnector.json`: CCF Push connector instance contract.
- `DCR.json`: CCF-packaging DCR with the ASIM transform.
- `azuredeploy.json`: standalone DCE and DCR deployment for validation.
- `sample-event.json`: payload accepted by the declared input stream.
- `schema.sql`: Firecrawl-side organization configuration table.

The CCF artifacts follow the current preview contract: connector definitions
use `2022-09-01-preview`, push connector instances use `2024-09-01` with
`kind: Push`, and the stream name begins with `Custom-`.
The DCR targets the built-in `ASimWebSessionLogs` table directly, so this
package intentionally has no custom-table artifact.

## Deploy and configure

1. Package `connectorDefinition.json`, `dataConnector.json`, and `DCR.json`
   with the Microsoft Sentinel CCF Push solution tooling. The
   `DeployPushConnectorButton` provisions the DCE, DCR, Entra application,
   client secret, and role assignment.
2. For an isolated DCR validation before CCF packaging, deploy
   `azuredeploy.json` to the Sentinel workspace resource group:

   ```sh
   az deployment group create \
     --resource-group <resource-group> \
     --template-file azuredeploy.json \
     --parameters workspaceName=<workspace>
   ```

   The deployment outputs include the DCE ingestion URL and DCR immutable ID.

3. Give the generated service principal `Monitoring Metrics Publisher` on the
   DCR.
4. Add `login.microsoftonline.com` and
   `*.ingest.monitor.azure.com` to the partner-egress destination allowlist.
5. Set `PARTNER_EGRESS_PROXY_URL` and a random 32-byte
   `SIEM_AUDIT_ENCRYPTION_KEY` in the API and scrape-worker environments.
6. Apply `schema.sql`, enable the `siemAudit` team flag, and configure the
   organization with `PUT /v2/team/siem`.
7. Run `POST /v2/team/siem/test`. The response differentiates invalid Entra
   credentials from a DCR schema rejection.

The client secret is write-only through the API and stored as org-bound
AES-256-GCM ciphertext. Access tokens exist only in process memory. Event
payloads are held only in a bounded in-memory buffer and are never written to
Firecrawl storage.

## ASIM mapping

The DCR maps scrape and request IDs to `EventOriginalUid` and
`NetworkSessionId`, `audit_metadata.username` to `SrcUsername`, the full URL
to `Url`, and the normalized hostname to `DstDomain`, `DstFQDN`, and
`HttpHost`. API-key attribution, organization identifiers, the complete
audit metadata object, and normalized threat details remain in
`AdditionalFields`.

Allowed activity is `Informational`. A local policy denial is `Low`, and a
denial with a security category is `High`; `Medium` is intentionally unused.
The ASIM schema version is `0.2.7`, event type is `HTTPsession`, and the DCR
sets vendor and product to Firecrawl.

## Validation queries

```kusto
ASimWebSessionLogs
| where EventVendor == "Firecrawl"
| sort by TimeGenerated desc
```

```kusto
_Im_WebSession()
| where EventVendor == "Firecrawl"
| summarize Events=count(), Users=dcount(SrcUsername) by DvcAction, EventSeverity
```

Before handoff, send `sample-event.json`, verify the standard
`_Im_WebSession` parser and workbooks, confirm the expected
`EventResultDetails` vocabulary, and size the destination from the
organization's current scrape volume.

## References

- [Microsoft Sentinel CCF Push connector guide](https://learn.microsoft.com/en-us/azure/sentinel/isv/create-push-codeless-connector)
- [Azure Monitor Logs Ingestion API](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/logs-ingestion-api-overview)
- [ASIM Web Session schema](https://learn.microsoft.com/en-us/azure/sentinel/normalization-schema-web)
- [ASimWebSessionLogs table reference](https://learn.microsoft.com/en-us/azure/azure-monitor/reference/tables/asimwebsessionlogs)
