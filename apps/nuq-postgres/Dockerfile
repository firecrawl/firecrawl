# Build a Postgres image that runs nuq.sql during initdb

ARG PG_MAJOR=17
FROM postgres:${PG_MAJOR}

# Install pg_cron for the specified Postgres major version
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        postgresql-${PG_MAJOR}-cron; \
    rm -rf /var/lib/apt/lists/*

# Ensure pg_cron is preloaded on first startup by modifying the initdb template
# This must be set before the first server start (init scripts run after start)
RUN set -eux; \
    conf_sample="/usr/share/postgresql/${PG_MAJOR}/postgresql.conf.sample"; \
    sed -ri "s/^#?shared_preload_libraries\s*=.*/shared_preload_libraries = 'pg_cron'/" "$conf_sample"; \
    printf "\n# Added for pg_cron\ncron.database_name = 'postgres'\n" >> "$conf_sample"

# Copy nuq.sql so it is executed as part of the initdb sequence.
# --chmod=0644 ensures world-readable permissions: the postgres Docker image
# re-executes itself via `gosu postgres`, so init scripts run as the postgres
# user, not root.  Without explicit permissions the file may be unreadable,
# causing: "psql: error: /docker-entrypoint-initdb.d/010-nuq.sql: Permission denied"
COPY --chmod=0644 nuq.sql /docker-entrypoint-initdb.d/010-nuq.sql