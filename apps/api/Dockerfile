FROM node:22-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable
COPY . /app
WORKDIR /app

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

FROM base AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install && pnpm run build

# Install Go
FROM golang:1.24 AS go-base
COPY sharedLibs/go-html-to-md /app/sharedLibs/go-html-to-md

# Install Go dependencies and build parser lib
RUN cd /app/sharedLibs/go-html-to-md && \
    go mod download && \
    go build -o html-to-markdown.so -buildmode=c-shared html-to-markdown.go && \
    chmod +x html-to-markdown.so

# Install Rust
FROM rust:1-slim AS rust-base
COPY sharedLibs/html-transformer /app/sharedLibs/html-transformer
COPY sharedLibs/pdf-parser /app/sharedLibs/pdf-parser
COPY sharedLibs/crawler /app/sharedLibs/crawler

# Install Rust dependencies and build transformer lib
RUN cd /app/sharedLibs/html-transformer && \
    cargo build --release --locked && \
    chmod +x target/release/libhtml_transformer.so

# Install Rust dependencies and build PDF parser lib
RUN cd /app/sharedLibs/pdf-parser && \
    cargo build --release --locked && \
    chmod +x target/release/libpdf_parser.so

# Install Rust dependencies and build crawler lib
RUN cd /app/sharedLibs/crawler && \
    cargo build --release --locked && \
    chmod +x target/release/libcrawler.so

# N-API Go HTML-to-Markdown build stage
FROM node:22-slim AS napi-base
COPY sharedLibs/go-html-to-md-napi /app/sharedLibs/go-html-to-md-napi
WORKDIR /app/sharedLibs/go-html-to-md-napi

# Install build dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install Go
RUN wget https://go.dev/dl/go1.24.5.linux-amd64.tar.gz && \
    tar -C /usr/local -xzf go1.24.5.linux-amd64.tar.gz && \
    rm go1.24.5.linux-amd64.tar.gz
ENV PATH="/usr/local/go/bin:${PATH}"
ENV CGO_ENABLED=1

# Install node-addon-api
RUN npm install node-addon-api

# Build the N-API module
RUN mkdir -p lib && \
    go mod download && \
    go build -buildmode=c-archive -o lib/libhtml_converter.a main.go && \
    cp lib/libhtml_converter.h src/ && \
    npx node-gyp rebuild

FROM base
COPY --from=build /app/dist /app/dist
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=go-base /app/sharedLibs/go-html-to-md/html-to-markdown.so /app/sharedLibs/go-html-to-md/html-to-markdown.so
COPY --from=napi-base /app/sharedLibs/go-html-to-md-napi/build/Release/html_to_markdown.node /app/sharedLibs/go-html-to-md-napi/build/Release/html_to_markdown.node
COPY --from=rust-base /app/sharedLibs/html-transformer/target/release/libhtml_transformer.so /app/sharedLibs/html-transformer/target/release/libhtml_transformer.so
COPY --from=rust-base /app/sharedLibs/pdf-parser/target/release/libpdf_parser.so /app/sharedLibs/pdf-parser/target/release/libpdf_parser.so
COPY --from=rust-base /app/sharedLibs/crawler/target/release/libcrawler.so /app/sharedLibs/crawler/target/release/libcrawler.so

# Install git
RUN apt-get update && apt-get install -y git procps && rm -rf /var/lib/apt/lists/*

# Start the server by default, this can be overwritten at runtime
EXPOSE 8080

# Make sure the entrypoint script has the correct line endings
RUN sed -i 's/\r$//' /app/docker-entrypoint.sh

ENTRYPOINT "/app/docker-entrypoint.sh"
