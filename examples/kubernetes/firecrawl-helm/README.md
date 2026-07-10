# Firecrawl Helm Chart

This chart deploys Firecrawl on Kubernetes with:

- `api`
- `worker` (queue-worker)
- `extract-worker`
- PG and/or FoundationDB NuQ scrape workers (selected by `nuq.mode`)
- `nuq-prefetch-worker` and `nuq-reconciler-worker` in PG-capable modes
- dedicated FDB maintenance and crawl-finished workers in FDB-capable modes
- `cclog-worker`
- `playwright-service`
- `redis`
- `nuq-postgres`
- `rabbitmq`

## Image Strategy

- **x86-only cluster**: use official Firecrawl images from GHCR (`ghcr.io/firecrawl/...`).
- **ARM or mixed ARM+x86 cluster**: use your multi-arch `winkkgmbh` images.

Official Firecrawl images are fine for x86. Use winkk images only when ARM support is needed.

## Configure Values

Use `values.yaml` plus one overlay.

Important fields:

- `secret.*` for API keys and sensitive values.
- `config.extra` / `secret.extra` for custom env vars.
- `image.dockerSecretEnabled` and `imagePullSecrets` for private registries.
- `resources.enabled` enables/disables all container resource requests/limits.
  Default: `false`.
- `rabbitmq.enabled`, `extractWorker.enabled`, `nuqPrefetchWorker.enabled`, `cclogWorker.enabled` to toggle components.

## NuQ queue topology and safe rollout

`nuq.mode` selects the worker topology:

| Mode    | PG scrape / prefetch / reconciler | FDB scrape / maintenance / completion | Typical use                            |
| ------- | --------------------------------- | ------------------------------------- | -------------------------------------- |
| `pg`    | yes                               | no                                    | Default PG-only deployment             |
| `mixed` | yes                               | yes                                   | Gradual team-flag rollout and PG drain |
| `fdb`   | no                                | yes                                   | Forced FDB after PG work is drained    |

For `mixed` or `fdb`, create a Secret containing the FoundationDB cluster
file, then reference its name. Keep the cluster file out of values files and
source control:

```bash
kubectl create secret generic firecrawl-fdb-cluster \
  --from-file=fdb.cluster=/secure/path/fdb.cluster \
  -n firecrawl

HELM_NO_PLUGINS=1 helm upgrade firecrawl . \
  --reuse-values \
  --set nuq.mode=mixed \
  --set nuqFdb.clusterFile.existingSecret=firecrawl-fdb-cluster \
  -n firecrawl
```

A safe migration is:

1. Deploy release A in `mixed` mode with
   `NUQ_FDB_METRICS_V2_ACTIVATE=false` (the default). Freeze new FDB admission
   and migration expansion, retain the current FDB replica floor, and verify
   the three FDB deployments are healthy.
2. Drain every pre-compatible API, queue writer, group completer, and sweeper.
   Before activation, maintenance `/metrics` intentionally exposes only
   `firecrawl_nuq_fdb_metrics_ready 0`; queue/HPA series are absent so scaling
   holds its existing replica count.
3. Deploy release B with
   `--set config.extra.NUQ_FDB_METRICS_V2_ACTIVATE=true`. Maintenance performs
   bounded generation backfill. Keep admission expansion and HPA changes frozen
   until `/metrics` reports `firecrawl_nuq_fdb_metrics_ready 1` and includes
   both `nuq_fdb_queue_scrape_job_count` and
   `nuq_fdb_queue_crawl_finished_job_count`.
4. Enable FDB routing gradually for selected teams while both consumer sets
   remain available. Existing crawls stay pinned to their original backend.
5. Stop new PG routing and wait for PG active, delayed, and crawl-finished work
   to drain before switching to `fdb`. Persistent PG queue volumes are retained
   across this switch as a rollback safeguard and must be deleted manually only
   after they are no longer needed.
6. Keep `nuqFdb.maintenanceWorker.replicaCount` and
   `nuqFdb.crawlFinishedWorker.replicaCount` at one or more. The chart rejects
   zero for these control loops. `nuqFdb.scrapeWorker.replicaCount=0` is safe
   during a deliberate scrape-consumer drain because maintenance and crawl
   completion remain independently available.

To roll back routing, first disable activation and let the compatible release
invalidate metric readiness, then return to `mixed` before deploying older
code. Never run a pre-compatible writer against an active metric generation,
and do not switch directly to `pg` while FDB-pinned work remains.

## Deploy

Render:

```bash
HELM_NO_PLUGINS=1 helm template firecrawl . \
  -f values.yaml \
  -f overlays/prod/values.yaml \
  -n firecrawl
```

Install/upgrade:

```bash
HELM_NO_PLUGINS=1 helm upgrade firecrawl . \
  -f values.yaml \
  -f overlays/prod/values.yaml \
  -n firecrawl \
  --install \
  --create-namespace
```

### Use Official Firecrawl Images (x86-only)

If your cluster is x86-only and you want official images, override repositories:

```bash
HELM_NO_PLUGINS=1 helm upgrade firecrawl . \
  -f values.yaml \
  -f overlays/prod/values.yaml \
  --set image.repository=ghcr.io/firecrawl/firecrawl \
  --set playwright.repository=ghcr.io/firecrawl/playwright-service \
  --set nuqPostgres.image.repository=ghcr.io/firecrawl/nuq-postgres \
  -n firecrawl \
  --install \
  --create-namespace
```

## Build and Push Multi-Arch Containers (ARM+x86)

Run from `examples/kubernetes/firecrawl-helm`:

```bash
docker buildx create --name multiarch --use --bootstrap
```

```bash
docker buildx build --platform linux/amd64,linux/arm64 --push \
  -t docker.io/winkkgmbh/firecrawl:latest \
  ../../../apps/api

docker buildx build --platform linux/amd64,linux/arm64 --push \
  -t docker.io/winkkgmbh/firecrawl-playwright:latest \
  ../../../apps/playwright-service-ts

docker buildx build --platform linux/amd64,linux/arm64 --push \
  -t docker.io/winkkgmbh/nuq-postgres:latest \
  ../../../apps/nuq-postgres
```

## Package and Push Helm Chart (OCI)

```bash
HELM_NO_PLUGINS=1 helm package . --destination /tmp/helm-packages
HELM_NO_PLUGINS=1 helm push /tmp/helm-packages/firecrawl-0.3.0.tgz oci://registry-1.docker.io/winkkgmbh
```

Install from OCI:

```bash
HELM_NO_PLUGINS=1 helm upgrade --install firecrawl oci://registry-1.docker.io/winkkgmbh/firecrawl \
  --version 0.3.0 \
  -n firecrawl --create-namespace \
  -f values.yaml \
  -f overlays/prod/values.yaml
```

## Test

```bash
kubectl port-forward svc/firecrawl-firecrawl-api 3002:3002 -n firecrawl
```

## Cleanup

```bash
helm uninstall firecrawl -n firecrawl
```
