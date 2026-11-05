FROM node:26.11.1-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true

RUN corepack enable && corepack prepare pnpm@11.4.0 --activate

WORKDIR /usr/src/app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright

# Install Playwright dependencies
RUN pnpm exec playwright install chromium --with-deps

RUN pnpm run build

RUN chown -R node:node /usr/src/app \
  && chmod -R a+rX /usr/local/share/playwright

ARG PORT
ENV PORT=${PORT}

EXPOSE ${PORT}

USER node

CMD [ "pnpm", "start" ]
