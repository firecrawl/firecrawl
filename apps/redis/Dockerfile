ARG REDIS_VERSION=8.0.3
FROM bitnami/redis:${REDIS_VERSION}

COPY start-redis-server.sh /usr/bin/start-redis-server.sh

CMD ["/usr/bin/start-redis-server.sh"]
