# Deploy Firecrawl with Kubernetes manifests

Use these manifests when you want to inspect and adapt each Kubernetes resource directly. They are a source-aligned starting point, not a production architecture or a supported replacement for making your own security, persistence, availability, and upgrade decisions.

> [!WARNING]
> The example disables database authentication and references a `docker-registry-secret` for image pulls. Keep the API private while evaluating, review every image, and create or replace the pull secret before applying the workloads.

## Choose this path when

- **Use these manifests** when you want direct control over each Deployment, Service, ConfigMap, and Secret.
- **Use the [Helm chart](../firecrawl-helm/)** when you want a values-driven render and upgrade workflow.
- **Use the [Docker Compose self-hosting guide](https://docs.firecrawl.dev/contributing/self-host)** when you are still proving the first scrape and do not need Kubernetes yet.

## Review the deployment decisions

Before applying anything:

1. Review [`configmap.yaml`](./configmap.yaml) and [`secret.yaml`](./secret.yaml).
2. Replace every placeholder secret and keep the populated file out of Git.
3. Point image references at registries and immutable tags you trust.
4. Create `docker-registry-secret`, or remove the `imagePullSecrets` entries after confirming the images are public.
5. Decide how PostgreSQL data, Redis state, and other required data survive pod replacement.
6. Keep `USE_DB_AUTHENTICATION=false` reachable only from a trusted network.

If `REDIS_PASSWORD` is set in the Secret, update `REDIS_URL` and `REDIS_RATE_LIMIT_URL` in the ConfigMap:

```yaml
REDIS_URL: "redis://:password@host:port"
REDIS_RATE_LIMIT_URL: "redis://:password@host:port"
```

Replace `password`, `host`, and `port` with values that resolve from inside the cluster.

## Apply the manifests

Create one namespace for the evaluation deployment:

```bash
kubectl create namespace firecrawl
```

From this directory, apply the configuration and workloads:

```bash
kubectl apply -n firecrawl \
  -f configmap.yaml \
  -f secret.yaml \
  -f playwright-service.yaml \
  -f api.yaml \
  -f worker.yaml \
  -f nuq-worker.yaml \
  -f nuq-postgres.yaml \
  -f redis.yaml
```

Inspect the rollout before testing:

```bash
kubectl get pods -n firecrawl
kubectl rollout status deployment/api -n firecrawl
```

If a pod does not become ready, inspect its events and logs before changing configuration:

```bash
kubectl describe pod -n firecrawl POD_NAME
kubectl logs -n firecrawl POD_NAME --all-containers --tail=200
```

## Verify one scrape

Forward the API service to your machine:

```bash
kubectl port-forward svc/api 3002:3002 -n firecrawl
```

In another terminal, check API reachability:

```bash
curl --fail --silent --show-error \
  http://localhost:3002/v0/health/readiness
```

Then test the end-to-end scraping path:

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

A successful response includes `success: true`, Markdown, and an HTTP status in the response metadata.

## Prepare your own production design

Before exposing the API, define:

- authentication, TLS, ingress, and network policy;
- persistent storage, backups, and tested recovery;
- resource requests, limits, autoscaling, and disruption budgets;
- monitoring, alerts, capacity targets, and incident ownership;
- image provenance, immutable versioning, and rollback; and
- secret management and provider data flows.

The example manifests do not make those decisions for you.

## Remove the evaluation deployment

Delete only the resources applied from this directory:

```bash
kubectl delete -n firecrawl \
  -f configmap.yaml \
  -f secret.yaml \
  -f playwright-service.yaml \
  -f api.yaml \
  -f worker.yaml \
  -f nuq-worker.yaml \
  -f nuq-postgres.yaml \
  -f redis.yaml
```
