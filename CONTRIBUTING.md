# Contributors guide:

Welcome to [Firecrawl](https://firecrawl.dev) 🔥! Here are some instructions on how to get the project locally, so you can run it on your own (and contribute)

If you're contributing, note that the process is similar to other open source repos i.e. (fork firecrawl, make changes, run tests, PR). If you have any questions, and would like help getting on board, reach out to help@firecrawl.com for more or submit an issue!

## Running the project locally

First, start by installing dependencies:

1. node.js [instructions](https://nodejs.org/en/learn/getting-started/how-to-install-nodejs)
2. rust [instructions](https://www.rust-lang.org/tools/install)
3. pnpm [instructions](https://pnpm.io/installation)
4. redis [instructions](https://redis.io/docs/latest/operate/oss_and_stack/install/install-redis/)
5. postgresql
6. Docker (optional) (for running postgres)

You need to set up the PostgreSQL database by running the SQL file at `apps/nuq-postgres/nuq.sql`. Easiest way is to use the docker image inside `apps/nuq-postgres`. With Docker running, build the image:

```bash
docker build -t nuq-postgres .
```

and then run:

```bash
docker run --name nuqdb \          
  -e POSTGRES_PASSWORD=postgres \
  -p 5433:5432 \
  -v nuq-data:/var/lib/postgresql/data \
  -d nuq-postgres
```

Set environment variables in a .env in the /apps/api/ directory you can copy over the template in .env.example.

To start, we won't set up authentication, or any optional sub services (pdf parsing, JS blocking support, AI features)

.env:

```
# ===== Required ENVS ======
NUM_WORKERS_PER_QUEUE=8
PORT=3002
HOST=0.0.0.0
REDIS_URL=redis://localhost:6379
REDIS_RATE_LIMIT_URL=redis://localhost:6379

## To turn on DB authentication, you need to set up supabase.
USE_DB_AUTHENTICATION=false

## Using the PostgreSQL for queuing -- change if credentials, host, or DB is different
NUQ_DATABASE_URL=postgres://postgres:postgres@localhost:5433/postgres

# ===== Optional ENVS ======

# Supabase Setup (used to support DB authentication, advanced logging, etc.)
SUPABASE_ANON_TOKEN=
SUPABASE_URL=
SUPABASE_SERVICE_TOKEN=

# Other Optionals
TEST_API_KEY= # use if you've set up authentication and want to test with a real API key
OPENAI_API_KEY= # add for LLM dependent features (image alt generation, etc.)
BULL_AUTH_KEY= @
PLAYWRIGHT_MICROSERVICE_URL=  # set if you'd like to run a playwright fallback
LLAMAPARSE_API_KEY= #Set if you have a llamaparse key you'd like to use to parse pdfs
SLACK_WEBHOOK_URL= # set if you'd like to send slack server health status messages


```

### Installing dependencies

First, install the dependencies using pnpm.

```bash
# cd apps/api # to make sure you're in the right folder
pnpm install # make sure you have pnpm version 9+!
```

### Running the project

You're going to need to open 3 terminals.

### Terminal 1 - setting up redis

Run the command anywhere within your project

```bash
redis-server
```

### Terminal 2 - setting up the service

Now, navigate to the apps/api/ directory and run:

```bash
pnpm start
# if you are going to use the [llm-extract feature](https://github.com/firecrawl/firecrawl/pull/586/), you should also export OPENAI_API_KEY=sk-______
```

This will start the workers who are responsible for processing crawl jobs.

### Terminal 3 - sending our first request.

Alright: now let’s send our first request.

```curl
curl -X GET http://localhost:3002/test
```

This should return the response Hello, world!

If you’d like to test the crawl endpoint, you can run this

```curl
curl -X POST http://localhost:3002/v1/crawl \
    -H 'Content-Type: application/json' \
    -d '{
      "url": "https://mendable.ai"
    }'
```

### Alternative: Using Docker Compose

For a simpler setup, you can use Docker Compose to run all services:

1. Prerequisites: Make sure you have Docker and Docker Compose installed
2. Copy the `.env.example` file to `.env` in the `/apps/api/` directory and configure as needed
3. From the root directory, run:

```bash
docker compose up
```

This will start Redis, the API server, and workers automatically in the correct configuration.

## Tests

The best way to do this locally is run `pnpm test:snips` from `apps/api`.

### Non-self-hosted CI (k3s on PRs)

PRs against `main` trigger a non-self-hosted job that provisions an ephemeral k3s
cluster and deploys firecrawl, fire-engine, and idmux from the infra charts.
The job is skipped for forked PRs.

Required GitHub Actions secrets:

Infra access:
- FIRECRAWL_INFRA_REPO
- FIRECRAWL_INFRA_REF
- FIRECRAWL_INFRA_READ_TOKEN
- FIRECRAWL_INFRA_VALUES
  (Helm values YAML for CI overrides; stored only in Actions secrets.)

Firecrawl staging envs:
- TEST_API_KEY
- TEST_TEAM_ID
- TEST_API_KEY_CONCURRENCY
- TEST_TEAM_ID_CONCURRENCY
- TEST_API_KEY_ZDR
- TEST_TEAM_ID_ZDR
- TEST_SUITE_WEBSITE
- SUPABASE_URL
- SUPABASE_SERVICE_TOKEN
- SUPABASE_ANON_TOKEN
- SUPABASE_REPLICA_URL
- INDEX_SUPABASE_URL
- INDEX_SUPABASE_SERVICE_TOKEN
- INDEX_SUPABASE_ANON_TOKEN
- OPENAI_API_KEY
- ANTHROPIC_API_KEY
- GOOGLE_GENERATIVE_AI_API_KEY
- GROQ_API_KEY
- VERTEX_CREDENTIALS
- RUNPOD_MU_API_KEY
- RUNPOD_MU_POD_ID
- RUNPOD_MUV2_POD_ID
- GCS_CREDENTIALS
- GCS_BUCKET_NAME
- GCS_FIRE_ENGINE_BUCKET_NAME
- GCS_INDEX_BUCKET_NAME
- GCS_MEDIA_BUCKET_NAME
- FIRE_ENGINE_BETA_URL
- FIRE_ENGINE_STAGING_URL
- IDMUX_URL
- PROXY_SERVER
- PROXY_USERNAME
- PROXY_PASSWORD
- BULL_AUTH_KEY
- LOG_ENCRYPTION_KEY

Fire-engine secret env file:
- FIRE_ENGINE_SECRET_ENV_FILE
  (Env file contents used to create the fire-engine `secret` in CI.)

Idmux staging DB creds:
- IDMUX_SUPABASE_URL
- IDMUX_SUPABASE_SERVICE_TOKEN
- IDMUX_SUPABASE_ANON_TOKEN

Notes:
- FIRE_ENGINE_BETA_URL and IDMUX_URL are still required for the snips runner, but the Helm chart overrides them to in-cluster service DNS for the deployed API.

Local reproduction (internal only):
1. Check out `firecrawl` and `firecrawl-infra` in separate directories.
2. Create a k3d cluster with a local registry and namespaces `firecrawl`, `fire-engine`, `idmux`.
3. Install the RabbitMQ cluster operator CRDs/controllers.
4. Create GHCR pull secrets in each namespace.
5. Build and push the firecrawl image to the local registry.
6. Create a `secret` in each namespace with the same env values used in CI.
7. Deploy fire-engine, idmux, and firecrawl via the infra Helm charts with the same overrides used in CI.
8. Wait for rollouts, port-forward `app-service` in `firecrawl`, and run `pnpm test:snips` with `TEST_API_URL` pointing at the port-forward.
