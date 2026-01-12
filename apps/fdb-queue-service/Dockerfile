# Build stage
FROM rust:1.85-slim-bookworm as builder

# Install build dependencies including FDB client libraries
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    curl \
    clang \
    libclang-dev \
    && rm -rf /var/lib/apt/lists/*

# Install FoundationDB client library
ARG FDB_VERSION=7.3.69
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then \
      FDB_ARCH="amd64"; \
    elif [ "$ARCH" = "arm64" ]; then \
      FDB_ARCH="aarch64"; \
    else \
      echo "Unsupported architecture: $ARCH" && exit 1; \
    fi && \
    curl -LO https://github.com/apple/foundationdb/releases/download/${FDB_VERSION}/foundationdb-clients_${FDB_VERSION}-1_${FDB_ARCH}.deb && \
    dpkg -i foundationdb-clients_${FDB_VERSION}-1_${FDB_ARCH}.deb && \
    rm foundationdb-clients_${FDB_VERSION}-1_${FDB_ARCH}.deb

WORKDIR /app

# Copy Cargo files first for better caching
COPY Cargo.toml Cargo.lock* ./

# Create a dummy src/main.rs to build dependencies
RUN mkdir src && echo "fn main() {}" > src/main.rs

# Build dependencies only (this layer will be cached)
RUN cargo build --release && rm -rf src target/release/deps/fdb_queue_service*

# Copy the actual source code
COPY src ./src

# Build the actual application
RUN cargo build --release

# Runtime stage
FROM debian:bookworm-slim

# Install runtime dependencies including FDB client libraries
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install FoundationDB client library
ARG FDB_VERSION=7.3.69
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then \
      FDB_ARCH="amd64"; \
    elif [ "$ARCH" = "arm64" ]; then \
      FDB_ARCH="aarch64"; \
    else \
      echo "Unsupported architecture: $ARCH" && exit 1; \
    fi && \
    curl -LO https://github.com/apple/foundationdb/releases/download/${FDB_VERSION}/foundationdb-clients_${FDB_VERSION}-1_${FDB_ARCH}.deb && \
    dpkg -i foundationdb-clients_${FDB_VERSION}-1_${FDB_ARCH}.deb && \
    rm foundationdb-clients_${FDB_VERSION}-1_${FDB_ARCH}.deb

WORKDIR /app

# Copy the built binary from the builder stage
COPY --from=builder /app/target/release/fdb-queue-service /app/fdb-queue-service

# Set environment variables
ENV PORT=3100
ENV RUST_LOG=info

# Expose the port
EXPOSE 3100

# Run the binary
CMD ["/app/fdb-queue-service"]
