# Self-hosting Firecrawl

#### Contributor?

Welcome to [Firecrawl](https://firecrawl.dev) 🔥! Here are some instructions on how to get the project locally so you can run it on your own and contribute.

If you're contributing, note that the process is similar to other open-source repos, i.e., fork Firecrawl, make changes, run tests, PR.

If you have any questions or would like help getting on board, join our Discord community [here](https://discord.gg/gSmWdAkdwd) for more information or submit an issue on Github [here](https://github.com/firecrawl/firecrawl/issues/new/choose)!

## Why?

Self-hosting Firecrawl is particularly beneficial for organizations with stringent security policies that require data to remain within controlled environments. Here are some key reasons to consider self-hosting:

- **Enhanced Security and Compliance:** By self-hosting, you ensure that all data handling and processing complies with internal and external regulations, keeping sensitive information within your secure infrastructure. Note that Firecrawl is a Mendable product and relies on SOC2 Type2 certification, which means that the platform adheres to high industry standards for managing data security.
- **Customizable Services:** Self-hosting allows you to tailor the services, such as the Playwright service, to meet specific needs or handle particular use cases that may not be supported by the standard cloud offering.
- **Learning and Community Contribution:** By setting up and maintaining your own instance, you gain a deeper understanding of how Firecrawl works, which can also lead to more meaningful contributions to the project.

### Considerations

However, there are some limitations and additional responsibilities to be aware of:

1. **Limited Access to Fire-engine:** Currently, self-hosted instances of Firecrawl do not have access to Fire-engine, which includes advanced features for handling IP blocks, robot detection mechanisms, and more. This means that while you can manage basic scraping tasks, more complex scenarios might require additional configuration or might not be supported.
2. **Manual Configuration Required:** If you need to use scraping methods beyond the basic fetch and Playwright options, you will need to manually configure these in the `.env` file. This requires a deeper understanding of the technologies and might involve more setup time.

Self-hosting Firecrawl is ideal for those who need full control over their scraping and data processing environments but comes with the trade-off of additional maintenance and configuration efforts.

## Quick Start

For a quick local setup, follow these minimal steps:

1. **Install Docker** ([instructions](https://docs.docker.com/get-docker/))
2. **Copy and configure environment file:**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and at minimum change `BULL_AUTH_KEY` from `CHANGEME` to a secure value.
3. **Start Firecrawl:**
   ```bash
   docker compose build
   docker compose up
   ```
4. **Access the API:** `http://localhost:3002`
5. **Access the admin UI:** `http://localhost:3002/admin/{YOUR_BULL_AUTH_KEY}/queues`

That's it! Firecrawl should now be running locally. See the detailed steps below for production deployments and advanced configuration.

## Detailed Setup Steps

1. First, start by installing the dependencies

- Docker [instructions](https://docs.docker.com/get-docker/)


2. Set environment variables

Create an `.env` file in the root directory by copying the provided example:

```bash
cp .env.example .env
```

Then edit `.env` and customize the values for your deployment. The `.env.example` file contains:
- **Required settings**: PORT, HOST, and basic configuration
- **Optional settings**: AI features, proxy configuration, performance tuning, and more
- **Detailed comments**: Each setting includes helpful documentation

**Quick start**: For local development, the default values in `.env.example` should work out of the box. You only need to customize:
- `BULL_AUTH_KEY`: Change from `CHANGEME` to a secure value (especially if publicly accessible)
- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`: Use strong credentials in production
- `OPENAI_API_KEY`: If you want to enable AI features

See the `.env.example` file for all available configuration options and detailed explanations.

### Security considerations

- **Use strong PostgreSQL credentials.** The defaults in `.env.example` are for local development only. When deploying to a server, set `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` to secure values and ensure they match the database service configuration in `docker-compose.yaml`.
- **Keep the database port internal.** The provided `docker-compose.yaml` does not expose PostgreSQL to the host or the internet. Avoid adding a `ports` mapping for `nuq-postgres` unless you are restricting access with a firewall. To access the database for maintenance, prefer using `docker compose exec nuq-postgres psql` or a temporary, firewalled tunnel.
- **Protect the admin UI.** Set `BULL_AUTH_KEY` to a strong secret, especially on any deployment reachable from untrusted networks. Never use the default `CHANGEME` value in production.
- **Never commit `.env` files.** The `.env` file is already in `.gitignore`, but always double-check before committing sensitive credentials.

3. Build and run the Docker containers:

    ```bash
    docker compose build
    docker compose up
    ```

    If you encounter an error, make sure you're using `docker compose` and not `docker-compose`.
    
    This will run a local instance of Firecrawl which can be accessed at `http://localhost:3002`.
    
    You should be able to see the Bull Queue Manager UI on `http://localhost:3002/admin/CHANGEME/queues`.

4. *(Optional)* Test the API

If you’d like to test the crawl endpoint, you can run this:

  ```bash
  curl -X POST http://localhost:3002/v1/crawl \
      -H 'Content-Type: application/json' \
      -d '{
        "url": "https://firecrawl.dev"
      }'
  ```   

## Troubleshooting

This section provides solutions to common issues you might encounter while setting up or running your self-hosted instance of Firecrawl.

### API Keys for SDK Usage

**Note:** When using Firecrawl SDKs with a self-hosted instance, API keys are optional. API keys are only required when connecting to the cloud service (api.firecrawl.dev).

### Supabase client is not configured

**Symptom:**
```bash
[YYYY-MM-DDTHH:MM:SS.SSSz]ERROR - Attempted to access Supabase client when it's not configured.
[YYYY-MM-DDTHH:MM:SS.SSSz]ERROR - Error inserting scrape event: Error: Supabase client is not configured.
```

**Explanation:**
This error occurs because the Supabase client setup is not completed. You should be able to scrape and crawl with no problems. Right now it's not possible to configure Supabase in self-hosted instances.

### You're bypassing authentication

**Symptom:**
```bash
[YYYY-MM-DDTHH:MM:SS.SSSz]WARN - You're bypassing authentication
```

**Explanation:**
This error occurs because the Supabase client setup is not completed. You should be able to scrape and crawl with no problems. Right now it's not possible to configure Supabase in self-hosted instances.

### Docker containers fail to start

**Symptom:**
Docker containers exit unexpectedly or fail to start.

**Solution:**
Check the Docker logs for any error messages using the command:
```bash
docker logs [container_name]
```

- Ensure all required environment variables are set correctly in the `.env` file. You can compare your `.env` with `.env.example` to ensure nothing is missing.
- Verify that all Docker services defined in `docker-compose.yaml` are correctly configured and the necessary images are available.
- Check that your `.env` file exists in the root directory and is properly formatted (no syntax errors).

### Connection issues with Redis

**Symptom:**
Errors related to connecting to Redis, such as timeouts or "Connection refused".

**Solution:**
- Ensure that the Redis service is up and running in your Docker environment.
- Verify that the REDIS_URL and REDIS_RATE_LIMIT_URL in your .env file point to the correct Redis instance, ensure that it points to the same URL in the `docker-compose.yaml` file (`redis://redis:6379`)
- Check network settings and firewall rules that may block the connection to the Redis port.

### API endpoint does not respond

**Symptom:**
API requests to the Firecrawl instance timeout or return no response.

**Solution:**
- Ensure that the Firecrawl service is running by checking the Docker container status.
- Verify that the PORT and HOST settings in your .env file are correct and that no other service is using the same port.
- Check the network configuration to ensure that the host is accessible from the client making the API request.

By addressing these common issues, you can ensure a smoother setup and operation of your self-hosted Firecrawl instance.

## Install Firecrawl on a Kubernetes Cluster (Simple Version)

Read the [examples/kubernetes/cluster-install/README.md](https://github.com/firecrawl/firecrawl/blob/main/examples/kubernetes/cluster-install/README.md) for instructions on how to install Firecrawl on a Kubernetes Cluster.

## Install Firecrawl on a Kubernetes Cluster with Helm

Read the [examples/kubernetes/firecrawl-helm/README.md](https://github.com/firecrawl/firecrawl/blob/main/examples/kubernetes/firecrawl-helm/README.md) for instructions on how to install Firecrawl on a Kubernetes Cluster with Helm.
