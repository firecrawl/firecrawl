FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DEBIAN_FRONTEND=noninteractive

# Firefox runtime libraries, Xvfb for the virtual display, Mesa for software
# WebGL, and a real font set. Fonts matter for the cloak: Camoufox picks a font
# list matching the spoofed OS, and a container with almost no fonts installed
# produces a measurably odd fingerprint.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      x11-utils \
      libgtk-3-0 \
      libx11-xcb1 \
      libxt6 \
      libxtst6 \
      libxrandr2 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxcursor1 \
      libxi6 \
      libasound2 \
      libdbus-glib-1-2 \
      libpci3 \
      libegl1 \
      libgl1 \
      libglx-mesa0 \
      libgl1-mesa-dri \
      libgbm1 \
      libnss3 \
      libnspr4 \
      libpangocairo-1.0-0 \
      fonts-liberation \
      fonts-dejavu-core \
      fonts-noto-core \
      fonts-noto-color-emoji \
      ca-certificates \
      tzdata \
      curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Pin the browser build too, not just the Python package. `camoufox fetch`
# without a version follows a channel and would silently change the browser
# (and its fingerprint) on any rebuild.
ARG CAMOUFOX_BROWSER_VERSION=152.0.4-beta.28
ENV CAMOUFOX_BROWSER_VERSION=${CAMOUFOX_BROWSER_VERSION}
# `fetch` also pulls the MaxMind GeoLite2 databases that geoip=True needs, so
# no separate download step is required.
RUN python -m camoufox fetch "official/${CAMOUFOX_BROWSER_VERSION}" \
    && python -m camoufox path

COPY ssrf.py browser.py main.py entrypoint.sh ./
COPY tests ./tests
RUN chmod +x entrypoint.sh

ENV PORT=3000 \
    DISPLAY_NUM=99 \
    SCREEN_GEOMETRY=1920x1080x24
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["./entrypoint.sh"]
