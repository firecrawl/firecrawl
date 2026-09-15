# Firecrawl
Helm must be installed to use the charts. Please refer to Helm's documentation to get started.

## Usage

```shell
helm install firecrawl ./ -f values-dev.yaml -n app-firecrawl
```

Port forwarding to local for testing
```shell
kubectl port-forward svc/firecrawl-api 3002:3002 -n app-firecrawl
```