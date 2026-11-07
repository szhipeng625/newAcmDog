# -*- coding: utf-8 -*-
import socket
import json

LSM_HOST = "127.0.0.1"
LSM_PORT = 6380

SEQ_KEY = "oj:submission:seq"
IDX_KEY = "oj:submissions"
REC_PREFIX = "oj:submission:"

STATUS_MAP = {
    "AC": "correct",
    "WA": "wrong-answer",
    "TLE": "timelimit",
    "CE": "compiler-error",
    "RE": "run-error",
    "SE": "run-error",
}


def _encode(*args):
    payload = ("*%d\r\n" % len(args)).encode()
    for a in args:
        if not isinstance(a, bytes):
            a = str(a).encode()
        payload += b"$%d\r\n" % len(a) + a + b"\r\n"
    return payload


def _recv_all(sock):
    chunks = []
    sock.settimeout(5)
    try:
        while True:
            data = sock.recv(65536)
            if not data:
                break
            chunks.append(data)
            if len(data) < 65536:
                break
    except socket.timeout:
        pass
    return b"".join(chunks)


def cmd(*args):
    s = socket.create_connection((LSM_HOST, LSM_PORT), 5)
    try:
        s.sendall(_encode(*args))
        return _recv_all(s)
    finally:
        s.close()


def parse(raw):
    if not raw:
        return None
    t = raw[0:1]
    if t == b"+":
        return raw[1:].split(b"\r\n")[0].decode("utf-8", "replace")
    if t == b"-":
        return {"__error__": raw[1:].split(b"\r\n")[0].decode("utf-8", "replace")}
    if t == b":":
        return int(raw[1:].split(b"\r\n")[0])
    if t == b"$":
        parts = raw.split(b"\r\n", 2)
        if len(parts) < 3:
            return None
        if parts[0][1:] == b"-1":
            return None
        return parts[1].decode("utf-8", "replace")
    if t == b"*":
        out = []
        idx = raw.find(b"\r\n") + 2
        while idx < len(raw):
            if raw[idx:idx + 1] != b"$":
                break
            nl = raw.find(b"\r\n", idx)
            if nl < 0:
                break
            ln = int(raw[idx + 1:nl])
            start = nl + 2
            out.append(raw[start:start + ln].decode("utf-8", "replace"))
            idx = start + ln + 2
        return out
    return raw.decode("utf-8", "replace")


def next_id():
    v = parse(cmd("INCR", SEQ_KEY))
    return v if isinstance(v, int) else 1


def save_record(rec):
    sid = int(rec["submitid"])
    body = json.dumps(rec, ensure_ascii=False)
    r1 = parse(cmd("SET", REC_PREFIX + str(sid), body))
    r2 = parse(cmd("ZADD", IDX_KEY, str(sid), str(sid)))
    ok = (r1 == "OK") and not (isinstance(r2, dict))
    return ok


def load_record(sid):
    raw = parse(cmd("GET", REC_PREFIX + str(sid)))
    if not raw or isinstance(raw, dict):
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def list_records():
    ids = parse(cmd("ZRANGE", IDX_KEY, "0", "-1"))
    if not isinstance(ids, list):
        return []
    out = []
    for sid in ids:
        rec = load_record(sid)
        if rec:
            out.append(rec)
    return out


def map_status(judge_status):
    return STATUS_MAP.get((judge_status or "").upper(), "run-error")


def save_from_result(result, existing):
    status = result.get("status", "")
    if not status or status in ("judging", "pending"):
        return None
    import time as _t
    rec = {
        "submitid": next_id(),
        "username": result.get("username", "") or existing.get("username", ""),
        "problem_id": result.get("problem_id", 0),
        "problem_name": result.get("problem", "") or existing.get("problem", ""),
        "language": existing.get("language", ""),
        "status": status,
        "result": map_status(status),
        "time_ms": int(result.get("cpu_ns", 0) / 1000000) if result.get("cpu_ns") else 0,
        "mem_bytes": result.get("mem_bytes", 0),
        "submittime": int(existing.get("submittime") or _t.time()),
        "contest_id": existing.get("contest_id", 0),
        "ac_count": result.get("ac_count", 0),
        "total_cases": result.get("total_cases", 0),
        "error": (result.get("error") or "")[:200],
    }
    ok = save_record(rec)
    print("[lsm] saved submitid=" + str(rec["submitid"]) + " status=" + status, flush=True)
    return rec if ok else None
