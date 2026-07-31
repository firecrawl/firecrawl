#!/usr/bin/env bash
# Start a real virtual display, then the service.
#
# Camoufox's own `headless="virtual"` mode spawns Xvfb with `-screen 0 1x1x24`
# (daijro/camoufox#458). A 1x1 screen is an obvious automation tell and is the
# leading suspect in the "Camoufox is detected only inside Docker" reports
# (daijro/camoufox#311), so we run our own Xvfb at a normal desktop resolution
# and hand Camoufox the display number instead.
set -euo pipefail

DISPLAY_NUM="${DISPLAY_NUM:-99}"
SCREEN_GEOMETRY="${SCREEN_GEOMETRY:-1920x1080x24}"
export DISPLAY=":${DISPLAY_NUM}"

# Force Mesa software GL. WebGL that returns nothing at all is a stronger
# signal than a spoofed renderer, so the container ships llvmpipe and Camoufox
# spoofs the vendor/renderer strings on top of it.
export __GLX_VENDOR_LIBRARY_NAME=mesa
export LIBGL_ALWAYS_SOFTWARE=1
export GDK_BACKEND=x11
export MOZ_ENABLE_WAYLAND=0
unset WAYLAND_DISPLAY || true

cleanup() {
  if [[ -n "${XVFB_PID:-}" ]] && kill -0 "$XVFB_PID" 2>/dev/null; then
    kill "$XVFB_PID" 2>/dev/null || true
    wait "$XVFB_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" 2>/dev/null || true

Xvfb "$DISPLAY" -screen 0 "$SCREEN_GEOMETRY" \
  -ac -nolisten tcp \
  +extension GLX +extension RANDR +extension RENDER \
  >/dev/null 2>&1 &
XVFB_PID=$!

# Wait for the display socket rather than sleeping a fixed interval.
for _ in $(seq 1 100); do
  if [[ -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ]]; then
    break
  fi
  if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    echo "Xvfb exited before the display was ready" >&2
    exit 1
  fi
  sleep 0.1
done

if [[ ! -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ]]; then
  echo "Timed out waiting for Xvfb display ${DISPLAY}" >&2
  exit 1
fi

echo "Xvfb ready on ${DISPLAY} (${SCREEN_GEOMETRY})"
exec python -u main.py
