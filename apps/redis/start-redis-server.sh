#!/bin/bash

set -e

mkdir -p /data/redis
if [ "$(id -u)" = 0 ]; then
  chown 1001:1001 /data
  chown -R 1001:1001 /data/redis
  exec /usr/bin/setpriv --reuid=1001 --regid=1001 --clear-groups /usr/bin/start-redis-server.sh
fi

PW_ARG=""
if [[ ! -z "${REDIS_PASSWORD}" ]]; then
  PW_ARG="--requirepass $REDIS_PASSWORD"
fi

: ${MAXMEMORY_POLICY:="noeviction"}
: ${APPENDONLY:="no"}
: ${FLY_VM_MEMORY_MB:=$(($(grep MemTotal /proc/meminfo | awk '{print $2}') / 1024))}
if [ "${NOSAVE}" = "" ] ; then
  : ${SAVE:="3600 1 300 100 60 10000"}
fi
# Set maxmemory to 80% of RAM
MAXMEMORY=$(($FLY_VM_MEMORY_MB*80/100))

redis-server $PW_ARG \
  --dir /data/redis \
  --maxmemory "${MAXMEMORY}mb" \
  --maxmemory-policy $MAXMEMORY_POLICY \
  --appendonly $APPENDONLY \
  --save "$SAVE" \
  --protected-mode no
