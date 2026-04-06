# syntax=docker/dockerfile:1.5
FROM node:18-slim

WORKDIR /usr/src/app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install

ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright

# Install Playwright dependencies
RUN --mount=type=cache,target=/root/.cache/ms-playwright \
    npx playwright install chromium --with-deps

COPY . .

RUN npm run build

ARG PORT
ENV PORT=${PORT}

EXPOSE ${PORT}

CMD [ "npm", "start" ]
