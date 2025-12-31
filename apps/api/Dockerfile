# syntax=docker/dockerfile:1
FROM node:22-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true

RUN corepack enable

# Build Go shared library
FROM golang:1.24 AS go-build
WORKDIR /app
COPY sharedLibs/go-html-to-md ./sharedLibs/go-html-to-md

RUN cd sharedLibs/go-html-to-md && \
    go mod download && \
    go build -o libhtml-to-markdown.so -buildmode=c-shared html-to-markdown.go

FROM base AS build
WORKDIR /app

# Build arguments
ARG COMMIT_SHA

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
    pkg-config \
    python3 \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Rust
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path \
    && chmod -R a+w $RUSTUP_HOME $CARGO_HOME

# Copy source files
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY . .

# Install dependencies
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/native/target \
    pnpm install --frozen-lockfile

# Get commit SHA from build arg, or generate from git if not provided
RUN if [ -z "$COMMIT_SHA" ]; then \
      COMMIT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown"); \
    fi && \
    echo "$COMMIT_SHA" > /tmp/commit_sha.txt && \
    echo "COMMIT_SHA=$COMMIT_SHA"

# Build the application
RUN pnpm run build

# Inject Debug IDs and upload sourcemaps to Sentry
# Using BuildKit secrets to avoid storing sensitive tokens in image layers
RUN --mount=type=secret,id=SENTRY_AUTH_TOKEN \
    --mount=type=secret,id=SENTRY_ORG \
    --mount=type=secret,id=SENTRY_PROJECT \
    COMMIT_SHA=$(cat /tmp/commit_sha.txt) && \
    SENTRY_AUTH_TOKEN=$(cat /run/secrets/SENTRY_AUTH_TOKEN 2>/dev/null || echo "") && \
    SENTRY_ORG=$(cat /run/secrets/SENTRY_ORG 2>/dev/null || echo "") && \
    SENTRY_PROJECT=$(cat /run/secrets/SENTRY_PROJECT 2>/dev/null || echo "") && \
    if [ -n "$SENTRY_AUTH_TOKEN" ] && [ "$COMMIT_SHA" != "unknown" ]; then \
      export SENTRY_AUTH_TOKEN="$SENTRY_AUTH_TOKEN" && \
      [ -n "$SENTRY_ORG" ] && export SENTRY_ORG="$SENTRY_ORG" || true && \
      [ -n "$SENTRY_PROJECT" ] && export SENTRY_PROJECT="$SENTRY_PROJECT" || true && \
      export SENTRY_RELEASE="$COMMIT_SHA" && \
      pnpm exec sentry-cli sourcemaps inject ./dist && \
      pnpm exec sentry-cli sourcemaps upload --release "$COMMIT_SHA" ./dist || echo "Warning: Sentry sourcemap upload failed"; \
    else \
      echo "Skipping Sentry sourcemap upload (SENTRY_AUTH_TOKEN not provided or COMMIT_SHA is unknown)"; \
      pnpm exec sentry-cli sourcemaps inject ./dist || echo "Warning: Sentry sourcemap injection failed (non-fatal)"; \
    fi

# Remove dev dependencies
RUN pnpm prune --prod --ignore-scripts

# Runtime stage
FROM base AS runtime

# Build arguments for runtime
ARG COMMIT_SHA

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    procps \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 8080
WORKDIR /app

# Copy built application
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/native ./native

# Copy Go shared library
COPY --from=go-build /app/sharedLibs/go-html-to-md/libhtml-to-markdown.so ./sharedLibs/go-html-to-md/

# Copy commit SHA file from build stage
COPY --from=build /tmp/commit_sha.txt /tmp/commit_sha.txt

# Copy entrypoint script from build stage
COPY --from=build /app/scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Set SENTRY_RELEASE from build arg if provided
# If not set, entrypoint will read from /tmp/commit_sha.txt
ENV SENTRY_RELEASE=${COMMIT_SHA}

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/src/harness.js", "--start-docker"]
