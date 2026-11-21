# Flare guest for the API's deterministic JSON extractors: node plus jsdom, with the VM as the jail.
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

COPY package.json package-lock.json /opt/
RUN npm ci --prefix /opt --omit=dev --no-fund --no-audit \
    && npm cache clean --force \
    && mkdir /work && chown node:node /work

WORKDIR /work
# Boots idle under Flare's `cmd: []`; the node image's entrypoint would exit at once.
ENTRYPOINT []
