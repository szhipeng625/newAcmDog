# -*- coding: utf-8 -*-
"""Write cloud judge results into the DOMjudge database.

Only the first accepted submission of a given user on a given problem is
recorded, so the scoreboard grows at most once per problem and team.
All other verdicts stay in the acmdog-lsm store only.
"""
import os
import time
import uuid

import pymysql
import subprocess

DB_HOST = "10.255.1.2"
DB_PORT = 3306
DB_NAME = "domjudge"
DB_USER = "domjudge"
PASS_FILE = "/root/dj_db_pass"


def _password():
    try:
        with open(PASS_FILE, "r") as f:
            return f.read().strip()
    except Exception:
        return ""


def _connect():
    return pymysql.connect(
        host=DB_HOST,
        port=DB_PORT,
        user=DB_USER,
        password=_password(),
        database=DB_NAME,
        charset="utf8mb4",
        autocommit=False,
        connect_timeout=5,
        read_timeout=10,
        write_timeout=10,
    )


def _pick_contest(cur, rec):
    cid = int(rec.get("contest_id") or 0)
    if cid:
        cur.execute("SELECT cid FROM contest WHERE cid=%s", (cid,))
        if cur.fetchone():
            return cid
    now = int(time.time())
    cur.execute(
        "SELECT cid FROM contest WHERE starttime <= %s AND endtime >= %s "
        "ORDER BY cid DESC LIMIT 1",
        (now, now),
    )
    row = cur.fetchone()
    return int(row[0]) if row else 0


def _pick_problem(cur, cid, probid, problem_name):
    cur.execute(
        "SELECT probid FROM contestproblem WHERE cid=%s AND probid=%s",
        (cid, probid),
    )
    if cur.fetchone():
        return int(probid)
    if problem_name:
        cur.execute(
            "SELECT cp.probid FROM contestproblem cp "
            "JOIN problem p ON p.probid = cp.probid "
            "WHERE cp.cid=%s AND p.name=%s LIMIT 1",
            (cid, problem_name),
        )
        row = cur.fetchone()
        if row:
            return int(row[0])
    return 0


def _team_of_user(cur, username):
    cur.execute(
        "SELECT userid, teamid FROM user WHERE username=%s", (username,)
    )
    row = cur.fetchone()
    if not row:
        return 0, 0
    return int(row[0] or 0), int(row[1] or 0)


def _already_accepted(cur, teamid, probid):
    cur.execute(
        "SELECT COUNT(*) FROM submission s "
        "JOIN judging j ON j.submitid = s.submitid "
        "WHERE s.teamid=%s AND s.probid=%s AND s.valid=1 AND j.valid=1 "
        "AND j.result='correct'",
        (teamid, probid),
    )
    row = cur.fetchone()
    return bool(row and int(row[0]) > 0)


def record_first_accept(rec):
    """Insert every AC submission into MySQL so the scoreboard reflects
    all accepted results; penalty time is derived from submittime.

    Returns a short string describing what happened, for logging only.
    """
    status = (rec.get("status") or "").upper()
    if status != "AC":
        return "skip:not-ac"

    username = (rec.get("username") or "").strip()
    if not username:
        return "skip:no-user"

    probid_raw = int(rec.get("problem_id") or 0)
    if not probid_raw:
        return "skip:no-problem"

    conn = _connect()
    try:
        cur = conn.cursor()
        cid = _pick_contest(cur, rec)
        if not cid:
            return "skip:no-contest"

        userid, teamid = _team_of_user(cur, username)
        if not teamid:
            return "skip:no-team"

        probid = _pick_problem(cur, cid, probid_raw, rec.get("problem_name") or "")
        if not probid:
            return "skip:no-problem-in-contest"

        # 所有 AC 均入库（含罚时），不再跳过已 AC 的后续提交

        langid = (rec.get("language") or "cpp").strip() or "cpp"
        submittime = int(rec.get("submittime") or time.time())

        cur.execute(
            "INSERT INTO submission "
            "(cid, teamid, userid, probid, langid, submittime, valid, source, externalid) "
            "VALUES (%s, %s, %s, %s, %s, %s, 1, %s, %s)",
            (cid, teamid, userid, probid, langid, submittime, "API",
             str(rec.get("submitid") or "")),
        )
        submitid = cur.lastrowid

        cur.execute(
            "INSERT INTO judging "
            "(cid, submitid, starttime, endtime, result, verified, valid, seen, "
            "judge_completely, uuid, max_runtime_for_verdict) "
            "VALUES (%s, %s, %s, %s, 'correct', 1, 1, 0, 1, %s, %s)",
            (cid, submitid, submittime, submittime, str(uuid.uuid4()),
             float(rec.get("time_ms") or 0) / 1000.0),
        )

        conn.commit()
        # 成绩已入库，异步触发榜单缓存重算，避免排行榜不更新
        try:
            subprocess.Popen(
                ["/home/admin/eval-worker/refresh_scoreboard.sh"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except Exception:
            pass
        return "inserted:submitid=%d cid=%d probid=%d teamid=%d" % (
            submitid, cid, probid, teamid)
    except Exception as exc:
        try:
            conn.rollback()
        except Exception:
            pass
        return "error:%s" % exc
    finally:
        try:
            conn.close()
        except Exception:
            pass
