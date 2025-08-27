# Install Firecrawl on a Kubernetes Cluster (Simple Version)
# Before installing
1. Set [secret.yaml](secret.yaml) and [configmap.yaml](configmap.yaml) and do not check in secrets
   - **Note**: If `REDIS_PASSWORD` is configured in the secret, please modify the ConfigMap to reflect the following format for `REDIS_URL` and `REDIS_RATE_LIMIT_URL`:
     ```yaml
     REDIS_URL: "redis://:password@host:port"
     REDIS_RATE_LIMIT_URL: "redis://:password@host:port"
     ```
     Replace `password`, `host`, and `port` with the appropriate values.

## Install
```bash
kubectl apply -f configmap.yaml
kubectl apply -f secret.yaml
kubectl apply -f playwright-service.yaml
kubectl apply -f api.yaml
kubectl apply -f worker.yaml
kubectl apply -f redis.yaml
```


# Port Forwarding for Testing
```bash
kubectl port-forward svc/api 3002:3002 -n dev
```

# Delete Firecrawl
```bash
kubectl delete -f configmap.yaml
kubectl delete -f secret.yaml
kubectl delete -f playwright-service.yaml
kubectl delete -f api.yaml
kubectl delete -f worker.yaml
kubectl delete -f redis.yaml
```
