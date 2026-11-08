#!/bin/bash
set -euo pipefail
MYSQL_USER="oj_user"
MYSQL_PASS="${OJ_DB_PASSWORD:?please set OJ_DB_PASSWORD}"
MYSQL_DB="oj"
REDIS_AUTH="${HOT_REDIS_PASSWORD:?please set HOT_REDIS_PASSWORD}"
ZSET_KEY="hot:problems"
LOG_TAG="[hot-refresh]"

# 用 MYSQL_PWD / REDISCLI_AUTH 传密码：
#   - 不出现在命令行里（ps 可见 / redis-cli 会打印 -a 的告警）
#   - docker exec 不继承宿主环境变量，必须用 -e 显式注入
results=$(docker exec -e MYSQL_PWD="$MYSQL_PASS" acmdog-mysql \
    mysql -u "$MYSQL_USER" "$MYSQL_DB" -N \
    -e "SELECT problem_id, COUNT(*) AS cnt FROM submissions GROUP BY problem_id" 2>/dev/null)

if [ -z "$results" ]; then
    echo "$LOG_TAG no submissions found, skipping"
    exit 0
fi

docker exec -e REDISCLI_AUTH="$REDIS_AUTH" hot-redis redis-cli DEL "$ZSET_KEY" > /dev/null 2>&1

echo "$results" | while read -r pid cnt; do echo "$cnt $pid"; done \
    | xargs -r docker exec -e REDISCLI_AUTH="$REDIS_AUTH" hot-redis redis-cli ZADD "$ZSET_KEY" 2>&1

count=$(docker exec -e REDISCLI_AUTH="$REDIS_AUTH" hot-redis redis-cli ZCARD "$ZSET_KEY" 2>/dev/null)
echo "$LOG_TAG $(date +%F_%T) updated $count problems in $ZSET_KEY"
