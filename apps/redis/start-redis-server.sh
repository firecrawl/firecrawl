#!/bin/bash

set -e

sysctl vm.overcommit_memory=1 || true
sysctl net.core.somaxconn=1024 || true

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

mkdir -p /data/redis

redis-server $PW_ARG \
  --dir /data/redis \
  --maxmemory "${MAXMEMORY}mb" \
  --maxmemory-policy $MAXMEMORY_POLICY \
  --appendonly $APPENDONLY \
  --save "$SAVE" \
  --protected-mode no
