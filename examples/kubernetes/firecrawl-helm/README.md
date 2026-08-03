# Deploy Firecrawl with Helm

Use this chart when you want a repeatable, values-driven Kubernetes render and upgrade workflow. The chart deploys the Firecrawl API, workers, Playwright, Redis, NuQ PostgreSQL, and RabbitMQ, with optional worker types controlled by values.

> [!WARNING]
> This chart is a source-aligned starting point, not a production guarantee. Its default values use third-party `winkkgmbh` images tagged `latest`, disable resource requests and limits, and do not complete your authentication, persistence, availability, or secret-management design.

## Choose Helm or another path

- **Use this chart** when you want values, overlays, rendered diffs, and Helm-managed upgrades.
- **Use the [raw manifests](../cluster-install/)** when you want to inspect and own every Kubernetes resource directly.
- **Use the [Docker Compose self-hosting guide](https://docs.firecrawl.dev/contributing/self-host)** when you are still proving the first scrape.

## Choose and trust the container images

- **x86-only cluster:** use official Firecrawl images from `ghcr.io/firecrawl/...`.
- **ARM or mixed ARM+x86 cluster:** build and publish your own multi-architecture images, or explicitly review and accept another publisher's images.

Pin immutable image tags or digests before production. Do not rely on `latest` for a controlled upgrade or rollback.

## Configure the release

Use [`values.yaml`](./values.yaml) plus one environment overlay.

Review these fields first:

- `secret.*` for API keys and sensitive values;
- `config.extra` and `secret.extra` for custom environment variables;
- `image.dockerSecretEnabled` and `imagePullSecrets` for private registries;
- `resources.enabled` and each component's resource values;
- `rabbitmq.enabled`, `extractWorker.enabled`, `nuqPrefetchWorker.enabled`, and `cclogWorker.enabled`; and
- storage, authentication, ingress, and provider settings required by your environment.

Keep populated secret values outside Git.

## Render before installing

From this directory, render the production overlay:

```bash
HELM_NO_PLUGINS=1 helm template firecrawl . \
  -f values.yaml \
  -f overlays/prod/values.yaml \
  -n firecrawl
```

Inspect the rendered images, Secrets, Services, environment variables, storage, and resource settings before applying them.

## Install or upgrade Firecrawl

```bash
HELM_NO_PLUGINS=1 helm upgrade firecrawl . \
  -f values.yaml \
  -f overlays/prod/values.yaml \
  -n firecrawl \
  --install \
  --create-namespace
```

### Use official Firecrawl images on x86

Override the default repositories:

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

Add reviewed version tags or digests to the override instead of inheriting `latest`.

## Verify the release

Check the workloads:

```bash
kubectl get pods -n firecrawl
kubectl rollout status deployment/firecrawl-firecrawl-api -n firecrawl
```

Forward the API service:

```bash
kubectl port-forward svc/firecrawl-firecrawl-api 3002:3002 -n firecrawl
```

In another terminal, check reachability and one scrape:

```bash
curl --fail --silent --show-error \
  http://localhost:3002/v0/health/readiness
```

```bash
curl \
  --fail-with-body \
  --silent \
  --show-error \
  --max-time 75 \
  -X POST \
  http://localhost:3002/v2/scrape \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://example.com",
    "formats": ["markdown"],
    "timeout": 60000
  }'
```

Treat API reachability as a heartbeat. The scrape is the end-to-end check for the API, workers, scraping path, and outbound access.

## Prepare the production design

Before exposing the API, define and test:

- authentication, TLS, ingress, and network policy;
- persistent volumes, backups, and recovery;
- resource requests, limits, autoscaling, and disruption budgets;
- monitoring, capacity targets, alerts, and incident ownership;
- image provenance, version pinning, upgrades, and rollback; and
- secret management and every optional provider data flow.

No values overlay makes these decisions automatically.

## Build multi-architecture images

Run from `examples/kubernetes/firecrawl-helm` only when you need ARM and x86 images that you control:

```bash
docker buildx create --name multiarch --use --bootstrap
```

```bash
docker buildx build --platform linux/amd64,linux/arm64 --push \
  -t YOUR_REGISTRY/firecrawl:YOUR_TAG \
  ../../../apps/api

docker buildx build --platform linux/amd64,linux/arm64 --push \
  -t YOUR_REGISTRY/firecrawl-playwright:YOUR_TAG \
  ../../../apps/playwright-service-ts

docker buildx build --platform linux/amd64,linux/arm64 --push \
  -t YOUR_REGISTRY/nuq-postgres:YOUR_TAG \
  ../../../apps/nuq-postgres
```

Update the chart values to those exact repositories and tags before rendering again.

## Package the chart as OCI

```bash
HELM_NO_PLUGINS=1 helm package . --destination /tmp/helm-packages
HELM_NO_PLUGINS=1 helm push /tmp/helm-packages/firecrawl-0.2.0.tgz YOUR_OCI_REGISTRY
```

Install the reviewed package:

```bash
HELM_NO_PLUGINS=1 helm upgrade --install firecrawl YOUR_OCI_CHART \
  --version 0.2.0 \
  -n firecrawl \
  --create-namespace \
  -f values.yaml \
  -f overlays/prod/values.yaml
```

## Remove the release

```bash
helm uninstall firecrawl -n firecrawl
```

Review retained persistent volumes and external services separately before deleting any data.
