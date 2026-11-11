#!/bin/bash
# Prints the summed memory of the named containers in KB (docker stats).
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/.work/env.sh" ] && . "$HERE/.work/env.sh"
docker stats --no-stream --format '{{.MemUsage}}' "$@" 2>/dev/null | awk '{
  v=$1; n=v; gsub(/[A-Za-z]/,"",n);
  if (v ~ /GiB/) kb=n*1048576; else if (v ~ /MiB/) kb=n*1024; else if (v ~ /KiB/) kb=n; else kb=n/1024;
  s+=kb } END { printf "%d\n", s }'
