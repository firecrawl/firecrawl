# Build context = the fire-enrich monorepo root (NOT apps/web).
# Compose: build: { context: ../fire-enrich, dockerfile: apps/web/Dockerfile }
#
# Two-stage: deps + build, then a minimal Node alpine runtime that runs
# Next's standalone server bundle (next.config.ts sets output: 'standalone').

FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /repo

# Manifests only first, for cacheable installs.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/mcp/package.json packages/mcp/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts


FROM deps AS build
WORKDIR /repo

# Now bring the source.
COPY packages/db packages/db
COPY packages/core packages/core
COPY apps/web apps/web

# Build deps in dep-order, then the web app (Next standalone output).
RUN pnpm --filter @fire-enrich/db build
RUN pnpm --filter @fire-enrich/core build
RUN pnpm --filter web build


FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Standalone bundle layout (with outputFileTracingRoot=../..):
#   apps/web/server.js  + node_modules + workspace traces
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public

EXPOSE 3000
CMD ["node", "apps/web/server.js"]
