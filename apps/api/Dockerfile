# syntax=docker/dockerfile:1
ARG FDB_VERSION=7.3.63
ARG FDB_SHA256_AMD64=4241d43395d74f229b232e3dd2e71a693013db96d4924010cf403ee93119b423
ARG FDB_SHA256_ARM64=a3c451ddb8242cc2396ba3419e1f3c9b283a64ea2eaff555377f4503bf9c3a64

FROM node:22.23.5-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true

RUN corepack enable && corepack prepare pnpm@11.4.0 --activate

# Build Go shared library
FROM golang:1.26@sha256:6e59e17a20f13c102e49d82dffab66d41cffe6c266b225d82794328aea859ab5 AS go-build
WORKDIR /app
COPY sharedLibs/go-html-to-md ./sharedLibs/go-html-to-md

RUN cd sharedLibs/go-html-to-md && \
    go mod download && \
    go build -o libhtml-to-markdown.so -buildmode=c-shared html-to-markdown.go

FROM base AS build
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
    pkg-config \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# FoundationDB client library (libfdb_c + headers), needed by the
# `foundationdb` npm package at install time on arches without prebuilds
ARG FDB_VERSION
ARG FDB_SHA256_AMD64
ARG FDB_SHA256_ARM64
RUN set -eu; \
    ARCH="$(dpkg --print-architecture)"; \
    case "$ARCH" in \
      amd64) FDB_ARCH=amd64; FDB_SHA256="$FDB_SHA256_AMD64" ;; \
      arm64) FDB_ARCH=aarch64; FDB_SHA256="$FDB_SHA256_ARM64" ;; \
      *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
    esac; \
    curl --proto '=https' --tlsv1.2 -fsSL -o /tmp/fdb-clients.deb \
      "https://github.com/apple/foundationdb/releases/download/${FDB_VERSION}/foundationdb-clients_${FDB_VERSION}-1_${FDB_ARCH}.deb"; \
    echo "${FDB_SHA256}  /tmp/fdb-clients.deb" | sha256sum -c -; \
    dpkg -i /tmp/fdb-clients.deb; \
    rm -f /tmp/fdb-clients.deb

# Install Rust
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH

ARG RUSTUP_VERSION=1.29.3
ARG RUSTUP_SHA256_AMD64=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55
ARG RUSTUP_SHA256_ARM64=9f608c142e0e38a78957d0661ba1dfaf0b6fb37184cfaa4b9a0aa57af6184282
RUN set -eu; \
    ARCH="$(dpkg --print-architecture)"; \
    case "$ARCH" in \
      amd64) RUSTUP_ARCH=x86_64-unknown-linux-gnu; RUSTUP_SHA256="$RUSTUP_SHA256_AMD64" ;; \
      arm64) RUSTUP_ARCH=aarch64-unknown-linux-gnu; RUSTUP_SHA256="$RUSTUP_SHA256_ARM64" ;; \
      *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
    esac; \
    curl --proto '=https' --tlsv1.2 -fsSL -o /tmp/rustup-init \
      "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${RUSTUP_ARCH}/rustup-init"; \
    echo "${RUSTUP_SHA256}  /tmp/rustup-init" | sha256sum -c -; \
    chmod +x /tmp/rustup-init; \
    /tmp/rustup-init -y --no-modify-path --profile minimal; \
    rm -f /tmp/rustup-init; \
    chmod -R a+w "$RUSTUP_HOME" "$CARGO_HOME"

# Copy dependency inputs. The native workspace is included here because its
# install script builds the Rust package; API TypeScript source is copied after
# dependency install so source-only changes do not invalidate this layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY native ./native

# Install dependencies
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/native/target \
    pnpm install --frozen-lockfile

COPY . .

# Build the application from a clean output directory. Skip pnpm's pre-run
# dependency check so refreshing timestamps on a cached install layer does not
# trigger a second pnpm install (and native build) outside the target cache mount.
RUN rm -rf dist && pnpm_config_verify_deps_before_run=false pnpm run build
ARG GIT_SHA=unknown
RUN test -s dist/src/harness.js && \
    test -s dist/src/controllers/v2/crawl-status.js && \
    printf '%s\n' "$GIT_SHA" > BUILD_SHA

# Remove dev dependencies
RUN pnpm prune --prod --ignore-scripts

# Runtime stage
FROM base AS runtime

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    git \
    procps \
    curl \
    && rm -rf /var/lib/apt/lists/*

# FoundationDB client library (libfdb_c + fdbcli)
ARG FDB_VERSION
ARG FDB_SHA256_AMD64
ARG FDB_SHA256_ARM64
RUN set -eu; \
    ARCH="$(dpkg --print-architecture)"; \
    case "$ARCH" in \
      amd64) FDB_ARCH=amd64; FDB_SHA256="$FDB_SHA256_AMD64" ;; \
      arm64) FDB_ARCH=aarch64; FDB_SHA256="$FDB_SHA256_ARM64" ;; \
      *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
    esac; \
    curl --proto '=https' --tlsv1.2 -fsSL -o /tmp/fdb-clients.deb \
      "https://github.com/apple/foundationdb/releases/download/${FDB_VERSION}/foundationdb-clients_${FDB_VERSION}-1_${FDB_ARCH}.deb"; \
    echo "${FDB_SHA256}  /tmp/fdb-clients.deb" | sha256sum -c -; \
    dpkg -i /tmp/fdb-clients.deb; \
    rm -f /tmp/fdb-clients.deb

EXPOSE 8080
WORKDIR /app
ARG GIT_SHA=unknown
ENV FIRECRAWL_BUILD_SHA=$GIT_SHA

# Copy built application
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/native/package.json /app/native/index.js /app/native/index.d.ts /app/native/*.node ./native/
COPY --from=build /app/BUILD_SHA ./BUILD_SHA

# Copy Go shared library
COPY --from=go-build /app/sharedLibs/go-html-to-md/libhtml-to-markdown.so ./sharedLibs/go-html-to-md/

RUN node -e 'const fs = require("fs"); for (const p of ["dist/src/harness.js", "dist/src/controllers/v2/crawl-status.js", "sharedLibs/go-html-to-md/libhtml-to-markdown.so", "BUILD_SHA"]) { if (!fs.statSync(p).size) throw new Error(`${p} missing or empty`); } if (fs.existsSync("native/target")) throw new Error("native/target must not exist in runtime image"); const native = require("@mendable/firecrawl-rs"); if (typeof native.transformHtml !== "function") throw new Error("native binding missing transformHtml");'

CMD ["node", "dist/src/harness.js", "--start-docker"]
