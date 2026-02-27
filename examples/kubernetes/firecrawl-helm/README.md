# Firecrawl Helm Chart

This chart deploys Firecrawl on Kubernetes with:
- `api`
- `worker` (queue-worker)
- `extract-worker`
- `nuq-worker`
- `nuq-prefetch-worker`
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
- `rabbitmq.enabled`, `extractWorker.enabled`, `nuqPrefetchWorker.enabled` to toggle components.

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
HELM_NO_PLUGINS=1 helm push /tmp/helm-packages/firecrawl-0.2.0.tgz oci://registry-1.docker.io/winkkgmbh
```

Install from OCI:

```bash
HELM_NO_PLUGINS=1 helm upgrade --install firecrawl oci://registry-1.docker.io/winkkgmbh/firecrawl \
  --version 0.2.0 \
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
