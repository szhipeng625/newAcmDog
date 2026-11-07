#!/bin/bash
set -euo pipefail
MYSQL_USER="oj_user"
MYSQL_PASS="${OJ_DB_PASSWORD:?please set OJ_DB_PASSWORD}"
MYSQL_DB="oj"
REDIS_AUTH="${HOT_REDIS_PASSWORD:?please set HOT_REDIS_PASSWORD}"
ZSET_KEY="hot:problems"
LOG_TAG="[hot-refresh]"

results=$(docker exec acmdog-mysql mysql -u "$MYSQL_USER" -p"" "$MYSQL_DB" -N -e "SELECT problem_id, COUNT(*) AS cnt FROM submissions GROUP BY problem_id" 2>/dev/null)

if [ -z "$results" ]; then
    echo "$LOG_TAG no submissions found, skipping"
    exit 0
fi

docker exec hot-redis redis-cli -a "" DEL "$ZSET_KEY" > /dev/null 2>&1

echo "$results" | while read -r pid cnt; do echo "$cnt $pid"; done | xargs -r docker exec hot-redis redis-cli -a "" ZADD "$ZSET_KEY" 2>&1

count=$(docker exec hot-redis redis-cli -a "" ZCARD "$ZSET_KEY" 2>/dev/null)
echo "$LOG_TAG $(date +%F_%T) updated $count problems in $ZSET_KEY"
