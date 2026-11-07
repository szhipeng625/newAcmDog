#!/bin/bash
# Refresh DOMjudge scoreboard caches after the middleware writes results
# directly into MySQL, which bypasses DOMjudge own score update.
# Serialized via flock; bursts within 3s are coalesced.
LOCK=/var/lock/dj_refresh.lock
STAMP=/var/lock/dj_refresh.stamp
LOG=/var/log/dj_refresh.log
mkdir -p /var/lock
exec 9>$LOCK
flock -w 60 9 || exit 0
now=$(date +%s)
last=$(cat $STAMP 2>/dev/null)
last=${last:-0}
case $last in ''|*[!0-9]*) last=0;; esac
gap=$((now-last))
if [ $gap -ge 0 ] && [ $gap -lt 3 ]; then sleep $((3-gap)); fi
date +%s > $STAMP
docker exec dj-domserver php /opt/domjudge/domserver/webapp/bin/console domjudge:refresh-cache >> $LOG 2>&1
rc=$?
echo "$(date '+%F %T') refresh rc=$rc" >> $LOG
exit 0
