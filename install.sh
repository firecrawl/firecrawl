#!/usr/bin/env bash
#
# One-shot installer for the self-hosted firecrawl stack at theochinomona.tech.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/TheophilusChinomona/firecrawl/release/install.sh | bash
#
# Or to install from a different branch / different fork:
#   BRANCH=main REPO=TheophilusChinomona/firecrawl curl ... | bash
#
# Or to install into a non-default directory:
#   INSTALL_DIR=/srv/firecrawl curl ... | bash

set -euo pipefail

REPO="${REPO:-TheophilusChinomona/firecrawl}"
BRANCH="${BRANCH:-release}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/firecrawl-stack}"
RAW_BASE="https://raw.githubusercontent.com/${REPO}/${BRANCH}"
COMPOSE_URL="${RAW_BASE}/deploy/docker-compose.yaml"
ENV_URL="${RAW_BASE}/deploy/.env.example"

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
info()  { printf "  %s\n" "$*"; }
warn()  { printf "\033[33m  %s\033[0m\n" "$*"; }
fail()  { printf "\033[31mERROR: %s\033[0m\n" "$*" >&2; exit 1; }

# Read from /dev/tty so prompts work under `curl | bash`.
ask() {
  local prompt="$1" default="${2:-}" reply
  if [ -t 0 ]; then
    read -rp "$prompt" reply
  else
    read -rp "$prompt" reply </dev/tty || reply="$default"
  fi
  echo "${reply:-$default}"
}

bold "Firecrawl self-hosted installer"
echo

# 1. Preflight
if ! command -v docker &>/dev/null; then
  fail "docker is required. Install from https://docs.docker.com/get-docker/"
fi
if ! docker compose version &>/dev/null; then
  fail "docker compose v2 plugin is required (you have $(docker --version 2>/dev/null || echo 'no docker'))."
fi
if ! command -v curl &>/dev/null; then
  fail "curl is required."
fi

# 2. Install dir
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Detect whether this is a fresh install or a re-run / update.
IS_UPDATE=0
if [ -f docker-compose.yaml ] && [ -f .env ]; then
  IS_UPDATE=1
  bold "Existing install detected at $INSTALL_DIR — running in update mode"
else
  bold "Install directory: $INSTALL_DIR"
fi

# 3. Refresh config files. Always overwrite docker-compose.yaml + .env.example
#    so users get bug fixes from the release branch. Never overwrite .env
#    (it has the user's secrets).
bold "Downloading config from $REPO@$BRANCH"
curl -fsSL "$COMPOSE_URL" -o docker-compose.yaml
curl -fsSL "$ENV_URL" -o .env.example
info "  ✓ docker-compose.yaml"
info "  ✓ .env.example"

if [ ! -f .env ]; then
  cp .env.example .env
  echo
  bold ".env created at $INSTALL_DIR/.env"
  warn "Edit it before continuing. Required minimums:"
  cat <<'EOF'
    CF_ACCESS_TEAM, CF_ACCESS_AUD_DASHBOARD, CF_ACCESS_AUD_MCP
    OPERATOR_EMAILS
    KEY_ENCRYPTION_KEY, SERVER_PEPPER, ADMIN_COOKIE_SECRET   (openssl rand -base64 32)
    POSTGRES_PASSWORD, BULL_AUTH_KEY
    OPENAI_API_KEY  (or LLM_API_KEY for OpenRouter)
    DASHBOARD_HOST, MCP_HOST  (your domains)

EOF
  ask "Press enter once .env is filled in, or Ctrl-C to abort... " >/dev/null
else
  info "  ✓ .env preserved (your existing secrets are untouched)"
fi

# 4. GHCR auth check (try a public pull to see if we need login)
bold "Checking GHCR access"
if ! docker pull ghcr.io/theophiluschinomona/firecrawl:latest &>/dev/null; then
  warn "Could not pull the API image anonymously."
  warn "Either make the package public on GHCR, or run:"
  warn "  echo \$GHCR_PAT | docker login ghcr.io -u TheophilusChinomona --password-stdin"
  ask "Press enter once you've logged in, or Ctrl-C to abort... " >/dev/null
fi

# 5. Pull all images and roll the stack. `up -d` is naturally idempotent —
#    services with new images are recreated, services already on :latest are
#    left alone. Same script run on a fresh box installs; same script run on
#    an existing box updates.
bold "Pulling images"
docker compose pull

if [ "$IS_UPDATE" -eq 1 ]; then
  bold "Updating services (recreating any with new images)"
else
  bold "Starting services"
fi
docker compose up -d --remove-orphans

# 6. Watchtower — only set up if not already running. Check by container name
#    AND by image, in case the user named theirs differently.
echo
WATCHTOWER_RUNNING=0
if docker ps --filter "name=^watchtower$" --filter "status=running" --format '{{.Names}}' 2>/dev/null | grep -q '^watchtower$'; then
  WATCHTOWER_RUNNING=1
elif docker ps --filter "ancestor=containrrr/watchtower" --filter "status=running" --format '{{.Names}}' 2>/dev/null | grep -q .; then
  WATCHTOWER_RUNNING=1
fi

if [ "$WATCHTOWER_RUNNING" -eq 1 ]; then
  info "  ✓ Watchtower already running — leaving it alone"
else
  WT_REPLY=$(ask "Install Watchtower for auto-updates from GHCR? [Y/n]: " "Y")
  if [[ ! "$WT_REPLY" =~ ^[Nn] ]]; then
    CONFIG_MOUNT=()
    if [ -f "$HOME/.docker/config.json" ]; then
      CONFIG_MOUNT=(-v "$HOME/.docker/config.json:/config.json:ro")
    fi
    docker run -d \
      --name watchtower \
      --restart unless-stopped \
      -v /var/run/docker.sock:/var/run/docker.sock \
      "${CONFIG_MOUNT[@]}" \
      -e WATCHTOWER_POLL_INTERVAL=120 \
      -e WATCHTOWER_CLEANUP=true \
      -e WATCHTOWER_LABEL_ENABLE=true \
      -e WATCHTOWER_INCLUDE_RESTARTING=true \
      containrrr/watchtower
    info "  ✓ Watchtower polling GHCR every 120s, restarting labeled containers when :latest advances"
  fi
fi

echo
bold "Stack status"
docker compose ps

echo
bold "Done"
cat <<EOF

  Next steps:
    1. Configure DNS to point your hostnames at this server's Traefik:
         \$DASHBOARD_HOST -> dashboard
         \$MCP_HOST/mcp   -> MCP server
         \$MCP_HOST       -> API
    2. Verify Cloudflare Access apps gate the dashboard and MCP paths.
    3. Tail logs:    cd $INSTALL_DIR && docker compose logs -f
    4. Update later: just push to the 'release' branch of $REPO; Watchtower
                     pulls and restarts within ~2 minutes. Or rerun this
                     script to refresh docker-compose.yaml itself.

EOF
