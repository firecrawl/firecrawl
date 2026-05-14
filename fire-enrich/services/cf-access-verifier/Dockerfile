FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN corepack enable && npm install --no-audit --no-fund
COPY src ./src
RUN npx tsc

FROM node:22-alpine AS runtime
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist/index.js"]
