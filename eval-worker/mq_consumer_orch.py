#!/usr/bin/env python3
"""
ACMDOG Cloud Judge - RabbitMQ Consumer via C++ Orchestrator
Full pipeline: MQ receive → middleware fetch (limits/generators/testcases)
→ generate data → sandbox judge → LRU cleanup by problem
"""
import json, os, subprocess, tempfile, time, uuid, signal, sys, threading
import shutil
import base64
from urllib.request import urlopen
import pika
import heapq

# ==================== Cgroup Preemption for Data Prep ====================
def _detect_data_prep_cg():
    """Detect the data_prep cgroup path created by orchestrator."""
    candidates = [
        "/sys/fs/cgroup/system.slice/cloud_judge.service/data_prep",
        "/sys/fs/cgroup/data_prep",
    ]
    # Also try reading orchestrator's own cgroup to find sibling
    try:
        with open("/proc/self/cgroup") as f:
            for line in f:
                if "::" in line:
                    rel = line.strip().split("::")[-1]
                    parent = "/sys/fs/cgroup" + rel
                    candidate = parent + "/data_prep"
                    candidates.insert(0, candidate)
    except Exception:
        pass
    for c in candidates:
        if os.path.exists(c + "/cgroup.procs"):
            return c
    return None

_data_prep_cg_path = None
_original_cg_path = None

def _enter_data_prep_cg():
    """Move current process into data_prep cgroup (low CPU weight)."""
    global _data_prep_cg_path, _original_cg_path
    if _data_prep_cg_path is None:
        _data_prep_cg_path = _detect_data_prep_cg()
    if _data_prep_cg_path and os.path.exists(_data_prep_cg_path + "/cgroup.procs"):
        try:
            # Save original cgroup for restoration
            if _original_cg_path is None:
                with open("/proc/self/cgroup") as f:
                    for line in f:
                        if "::" in line:
                            rel = line.strip().split("::")[-1]
                            _original_cg_path = "/sys/fs/cgroup" + rel
                            break
            with open(_data_prep_cg_path + "/cgroup.procs", "w") as f:
                f.write(str(os.getpid()))
            return True
        except Exception as e:
            print(f"[preempt] enter data_prep failed: {e}", flush=True)
    return False

def _leave_data_prep_cg():
    """Move current process back to original cgroup."""
    global _original_cg_path
    if _original_cg_path and os.path.exists(_original_cg_path + "/cgroup.procs"):
        try:
            with open(_original_cg_path + "/cgroup.procs", "w") as f:
                f.write(str(os.getpid()))
            return True
        except Exception:
            pass
    return False

class DataPrepPreempt:
    """Context manager: enter data_prep cgroup on __enter__, leave on __exit__."""
    def __enter__(self):
        self._entered = _enter_data_prep_cg()
        if self._entered:
            print(f"[preempt] pid={os.getpid()} entered data_prep (low priority)", flush=True)
        return self
    def __exit__(self, *args):
        if self._entered:
            _leave_data_prep_cg()
            print(f"[preempt] pid={os.getpid()} left data_prep (normal priority)", flush=True)


ORCHESTRATOR_BIN = "/home/admin/eval-worker/build/orchestrator"
ORCH_HTTP_PORT = 8890
COMPILE_TIMEOUT = 30
MQ_HOST = "127.0.0.1"
MQ_PORT = 5672
TASK_QUEUE = "oj.judge"
RESULT_QUEUE = "oj.judge.result"
MIDDLEWARE_URL = "https://127.0.0.1:8899"

# ==================== Generator exe 预编译产物回写（方向1）====================
# 复刻 middleware crypto.h 的 encrypt_blob：AES-256-CBC + base64，密钥/IV 与其硬编码一致
_GEN_AES_KEY = bytes([
    0x6f,0x6a,0x5f,0x63,0x6f,0x72,0x65,0x5f,0x32,0x30,0x32,0x36,0x6b,0x65,0x79,0x21,
    0x4f,0x4a,0x2d,0x45,0x4e,0x43,0x52,0x59,0x50,0x54,0x2d,0x4b,0x45,0x59,0x00,0x31
])
_GEN_AES_IV = bytes([
    0x6f,0x6a,0x2d,0x69,0x76,0x2d,0x31,0x36,0x62,0x79,0x74,0x65,0x73,0x21,0x21,0x21
])

def _gen_exe_encrypt(data):
    """用 openssl 复刻 AES-256-CBC 加密并 base64 输出（与 middleware encrypt_blob 互通）。"""
    r = subprocess.run(
        ["openssl", "enc", "-aes-256-cbc", "-K", _GEN_AES_KEY.hex(), "-iv", _GEN_AES_IV.hex(), "-base64", "-A"],
        input=data, capture_output=True, timeout=15
    )
    if r.returncode != 0:
        raise RuntimeError("openssl encrypt failed: " + r.stderr.decode(errors="replace")[:200])
    return r.stdout.decode().strip()

def _db_write_gen_exe(gen_id, bin_path):
    """把编译好的生成器二进制加密后回写到 oj.generators.exe（供后续判题免编译复用）。"""
    try:
        import pymysql
        with open(bin_path, "rb") as f:
            blob = f.read()
        enc = _gen_exe_encrypt(blob)
        conn = pymysql.connect(host="127.0.0.1", port=3306, user="oj_user", password=os.environ.get("OJ_DB_PASSWORD", ""),
                               database="oj", charset="utf8mb4", autocommit=True,
                               connect_timeout=5, read_timeout=10, write_timeout=15)
        with conn:
            with conn.cursor() as cur:
                cur.execute("UPDATE generators SET exe=%s WHERE id=%s", (enc, gen_id))
        print(f"[fetch] gen {gen_id} exe written back to db ({len(blob)} bytes)", flush=True)
    except Exception as e:
        print(f"[fetch] gen {gen_id} exe writeback failed (non-fatal): {e}", flush=True)

# ==================== 直连数据库读题目数据（去 mid 层）====================
# 复刻 middleware decrypt_blob：AES-256-CBC 解密（与 encrypt_blob 互通）
def _gen_blob_decrypt(enc_b64):
    """解密数据库中的加密字段（generators.code/exe、problems.std_code 等）。"""
    if not enc_b64:
        return ""
    r = subprocess.run(
        ["openssl", "enc", "-d", "-aes-256-cbc", "-K", _GEN_AES_KEY.hex(), "-iv", _GEN_AES_IV.hex()],
        input=base64.b64decode(enc_b64), capture_output=True, timeout=15
    )
    if r.returncode != 0:
        raise RuntimeError("openssl decrypt failed")
    return r.stdout.decode("utf-8", errors="replace")

def _db_conn_ro():
    """只读直连 oj 库。"""
    import pymysql
    return pymysql.connect(host="127.0.0.1", port=3306, user="oj_user", password=os.environ.get("OJ_DB_PASSWORD", ""),
                           database="oj", charset="utf8mb4", autocommit=True,
                           connect_timeout=5, read_timeout=10, write_timeout=10)

FILER_BASE = "http://43.157.53.29:8888"

# ==================== Redis 20 题 LRU 测试数据缓存 ====================
_REDIS_HOST = "127.0.0.1"
_REDIS_PORT = 6382
# 密码只从环境变量读，不要写死在源码里（_pd_redis 会取 HOT_REDIS_PASSWORD）
_PD_MAX = 20                       # 最多缓存 20 道题
_PD_KEY = "pdata:%s"               # 每题一个 key：文件名 -> base64 内容 的 JSON
_PD_LRU = "pdata:lru"              # zset：member=pid, score=最后访问时间戳


def _pd_redis():
    import redis as _r
    return _r.Redis(host=_REDIS_HOST, port=_REDIS_PORT, password=os.environ.get("HOT_REDIS_PASSWORD", ""),
                    socket_connect_timeout=3, socket_timeout=5)


def _pd_lru_get(problem_id):
    """命中返回 {文件名: bytes内容}；未命中或 Redis 异常返回 None。"""
    try:
        r = _pd_redis()
        raw = r.get(_PD_KEY % problem_id)
        if not raw:
            return None
        obj = json.loads(raw.decode("utf-8"))
        files = {k: base64.b64decode(v) for k, v in obj.items()}
        r.zadd(_PD_LRU, {str(problem_id): time.time()})   # 命中即刷新 LRU
        print(f"[pd-lru] problem {problem_id} HIT ({len(files)} files)", flush=True)
        return files
    except Exception as e:
        print(f"[pd-lru] get {problem_id} failed: {e}", flush=True)
        return None


def _pd_lru_put(problem_id, files):
    """把 {文件名: bytes内容} 写入 Redis 并维护 20 题 LRU 淘汰。"""
    try:
        r = _pd_redis()
        obj = {k: base64.b64encode(v).decode("utf-8") for k, v in files.items()}
        r.set(_PD_KEY % problem_id, json.dumps(obj))
        r.zadd(_PD_LRU, {str(problem_id): time.time()})
        # 先提交再加入后按真实数量淘汰，避免 pipeline 未执行导致 zcard 滞后一拍
        n = r.zcard(_PD_LRU)
        if n > _PD_MAX:
            old = r.zrange(_PD_LRU, 0, n - _PD_MAX - 1)   # 最久未用的若干题
            for m in old:
                pid = m.decode("utf-8")
                r.delete(_PD_KEY % pid)
                r.zrem(_PD_LRU, pid)
                print(f"[pd-lru] evict problem {pid}", flush=True)
        print(f"[pd-lru] problem {problem_id} cached ({len(files)} files)", flush=True)
    except Exception as e:
        print(f"[pd-lru] put {problem_id} failed: {e}", flush=True)


def _pd_write_dir(data_dir, files):
    """清空目录里旧的 in/out，把 {文件名: bytes} 落盘。"""
    for _old in os.listdir(data_dir):
        if _old.endswith(".in") or _old.endswith(".out"):
            try:
                os.remove(os.path.join(data_dir, _old))
            except Exception:
                pass
    for name, content in files.items():
        with open(os.path.join(data_dir, name), "wb") as f:
            f.write(content)


def _filer_get_problem(problem_id):
    """从 txy2 对象存储读取题目 JSON；失败返回 {}。"""
    try:
        from urllib.request import urlopen as _uopen
        with _uopen(FILER_BASE + "/problems/%s.json" % problem_id, timeout=10) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        print(f"[filer] problem {problem_id} read failed: {e}", flush=True)
        return {}


def _db_fetch_testcases(problem_id):
    """测试点优先读对象存储 testcases 字段，回退 problem_testcases 表。"""
    fp = _filer_get_problem(problem_id)
    ftcs = fp.get("testcases") if isinstance(fp, dict) else None
    if isinstance(ftcs, list) and ftcs:
        return [{"input": t.get("input", "") or "", "output": t.get("output", "") or ""} for t in ftcs]
    with _db_conn_ro() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT input, output FROM problem_testcases WHERE problem_id=%s ORDER BY sort, id",
                (problem_id,))
            rows = cur.fetchall()
    return [{"input": r[0] or "", "output": r[1] or ""} for r in rows]

def _db_fetch_problem(problem_id):
    """题目元数据优先从对象存储读取，回退数据库 problems 表。"""
    fp = _filer_get_problem(problem_id)
    if fp:
        return fp
    with _db_conn_ro() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, title, time_ms, mem_mb, std_code, std_exe, spj_code, spj_exe, "
                "entry_code, entry_exe, itf_template, judge_mode, is_public "
                "FROM problems WHERE id=%s", (problem_id,))
            prow = cur.fetchone()
            if not prow:
                return {}
            pdata = {
                "id": prow[0], "title": prow[1], "timeMs": prow[2], "memMb": prow[3],
                "stdCode": _gen_blob_decrypt(prow[4]) if prow[4] else "",
                "stdExe": base64.b64encode(_gen_blob_decrypt_raw(prow[5])).decode() if prow[5] else "",
                "spjCode": _gen_blob_decrypt(prow[6]) if prow[6] else "",
                "spjExe": base64.b64encode(_gen_blob_decrypt_raw(prow[7])).decode() if prow[7] else "",
                "entryCode": _gen_blob_decrypt(prow[8]) if prow[8] else "",
                "entryExe": base64.b64encode(_gen_blob_decrypt_raw(prow[9])).decode() if prow[9] else "",
                "itfTemplate": _gen_blob_decrypt(prow[10]) if prow[10] else "",
                "judgeMode": prow[11], "isPublic": bool(prow[12]),
                "generators": [],
            }
            # 关联生成器（code/exe 解密）
            cur.execute(
                "SELECT g.id, g.name, g.description, g.code, g.exe, pg.gen_count "
                "FROM problem_generators pg JOIN generators g ON g.id=pg.generator_id "
                "WHERE pg.problem_id=%s ORDER BY g.name", (problem_id,))
            gens = []
            for gr in cur.fetchall():
                gens.append({
                    "id": gr[0], "name": gr[1], "description": gr[2] or "",
                    "code": _gen_blob_decrypt(gr[3]) if gr[3] else "",
                    "exe": base64.b64encode(_gen_blob_decrypt_raw(gr[4])).decode() if gr[4] else "",
                    "genCount": gr[5],
                })
            pdata["generators"] = gens
    return pdata

def _gen_blob_decrypt_raw(enc_b64):
    """解密返回原始字节（用于 exe 二进制）。"""
    if not enc_b64:
        return b""
    r = subprocess.run(
        ["openssl", "enc", "-d", "-aes-256-cbc", "-K", _GEN_AES_KEY.hex(), "-iv", _GEN_AES_IV.hex()],
        input=base64.b64decode(enc_b64), capture_output=True, timeout=15
    )
    if r.returncode != 0:
        raise RuntimeError("openssl decrypt failed")
    return r.stdout


# ==================== Status Push ====================
def _publish_status(task_id, phase, extra=None):
    """Push task phase change to result queue so SSE can relay to frontend."""
    try:
        evt = {"task_id": task_id, "status": "judging", "phase": phase}
        if extra:
            evt.update(extra)
        conn = pika.BlockingConnection(pika.ConnectionParameters(MQ_HOST, MQ_PORT))
        ch = conn.channel()
        ch.basic_publish(exchange="", routing_key=RESULT_QUEUE,
                         body=json.dumps(evt),
                         properties=pika.BasicProperties(delivery_mode=2))
        conn.close()
    except Exception as e:
        print(f"[consumer] status push error: {e}", flush=True)

DATA_ROOT = "/tmp/cloud_judge_data"
CONTEST_DATA_ROOT = "/tmp/cloud_judge_contest"
_contest_data_lock = threading.Lock()
_contest_data_ready = set()

# 竞赛判题优先队列：最小堆维护竞赛任务，按用户提交次数排序（次数少在堆顶）
_pq_lock = threading.Lock()
_contest_pq = []            # 堆元素: (submit_count, seq, body)
_contest_seq = 0            # 入堆序号，保证次数相同按到达先后
_submit_count = {}          # Map: 用户 ID -> 提交次数
_pq_cv = threading.Condition(_pq_lock)

running = True
orch_proc = None

def stop(sig, frame):
    global running, orch_proc
    running = False
    print("[consumer] shutting down...", flush=True)
    if orch_proc:
        try:
            orch_proc.stdin.close()
            orch_proc.terminate()
            orch_proc.wait(timeout=5)
        except Exception:
            orch_proc.kill()

signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)

# ==================== SSL context ====================
import ssl as _ssl
_ssl_ctx = _ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = _ssl.CERT_NONE

def _mw_get(path):
    """GET from middleware."""
    url = MIDDLEWARE_URL + path
    resp = urlopen(url, context=_ssl_ctx, timeout=10)
    return json.loads(resp.read().decode("utf-8"))

# ==================== Problem data helpers ====================
def _safe_rmdir(path):
    try:
        if path and os.path.isdir(path):
            shutil.rmtree(path)
    except Exception as e:
        print(f"[lru] rmdir error {path}: {e}", flush=True)

def _case_key(filename):
    """Numeric sort key for testcase files: 1.in, 2.in, ..., 10.in, 11.in."""
    base = filename[:-3] if filename.endswith(".in") else filename
    try:
        return (0, int(base), base)
    except ValueError:
        return (1, 0, base)

def sorted_case_files(data_dir):
    """Return .in files under data_dir in natural numeric order."""
    files = [f for f in os.listdir(data_dir) if f.endswith(".in")]
    files.sort(key=_case_key)
    return files

# ==================== Contest Data Management ====================
def _prepare_contest_data(contest_id):
    """Download all problem data for a contest into a dedicated directory."""
    print(f"[contest] preparing data for contest {contest_id}...", flush=True)
    try:
        contests_raw = _mw_get("/api/contests")
        target = None
        for item in contests_raw:
            try:
                c = json.loads(item.get("content", "{}"))
            except Exception:
                continue
            if str(c.get("id")) == str(contest_id):
                target = c
                break
        if not target:
            print(f"[contest] contest {contest_id} not found", flush=True)
            return
        problem_ids = target.get("problems", [])
        if not problem_ids:
            print(f"[contest] contest {contest_id} has no problems", flush=True)
            return
        contest_dir = os.path.join(CONTEST_DATA_ROOT, f"c{contest_id}")
        os.makedirs(contest_dir, exist_ok=True)
        with _contest_data_lock:
            _contest_data_ready.clear()
        for pid in problem_ids:
            try:
                time_ms, mem_mb, data_dir = _fetch_problem_data_inner(pid)
                dest = os.path.join(contest_dir, f"p{pid}")
                if os.path.exists(dest):
                    _safe_rmdir(dest)
                shutil.copytree(data_dir, dest)
                with _contest_data_lock:
                    _contest_data_ready.add(pid)
                print(f"[contest] contest {contest_id} problem {pid} data ready", flush=True)
            except Exception as e:
                print(f"[contest] contest {contest_id} problem {pid} fetch failed: {e}", flush=True)
        print(f"[contest] contest {contest_id} data preparation complete ({len(_contest_data_ready)} problems)", flush=True)
    except Exception as e:
        print(f"[contest] contest {contest_id} preparation error: {e}", flush=True)


def _cleanup_contest_data(contest_id):
    """Remove all contest-specific data directories and clear protection flags.
    比赛结束自动释放沙箱：清空优先队列中待判任务、重置全部用户提交计数。"""
    print(f"[contest] cleaning up data for contest {contest_id}...", flush=True)
    contest_dir = os.path.join(CONTEST_DATA_ROOT, f"c{contest_id}")
    _safe_rmdir(contest_dir)
    with _contest_data_lock:
        _contest_data_ready.clear()
    with _pq_cv:
        dropped = len(_contest_pq)
        _contest_pq.clear()
        _submit_count.clear()
        _pq_cv.notify_all()
    print(f"[contest] contest {contest_id} data cleaned up, priority queue released ({dropped} pending dropped)", flush=True)


def _enqueue_contest_task(body):
    """竞赛任务入堆：该用户提交次数 +1，连同判题信息一起压入最小堆（次数少在堆顶）。"""
    global _contest_seq
    try:
        req = json.loads(body)
    except Exception:
        req = {}
    uid = req.get("username") or "anonymous"
    with _pq_cv:
        _submit_count[uid] = _submit_count.get(uid, 0) + 1
        cnt = _submit_count[uid]
        _contest_seq += 1
        heapq.heappush(_contest_pq, (cnt, _contest_seq, body))
        print(f"[pq] enqueue user={uid} count={cnt} heap_size={len(_contest_pq)}", flush=True)
        _pq_cv.notify()


def _contest_worker():
    """竞赛判题工作线程：从堆顶弹出提交次数最少的任务执行判题，结果回传结果队列。"""
    while True:
        with _pq_cv:
            while not _contest_pq:
                _pq_cv.wait()
            cnt, seq, body = heapq.heappop(_contest_pq)
        try:
            req = json.loads(body)
            print(f"[pq] pop task={req.get('task_id','')} user={req.get('username','')} count={cnt}", flush=True)
            result = process_task(body)
        except Exception as e:
            result = {"task_id": "unknown", "status": "SE", "error": str(e)}
        try:
            conn = pika.BlockingConnection(pika.ConnectionParameters(MQ_HOST, MQ_PORT))
            ch = conn.channel()
            ch.queue_declare(queue=RESULT_QUEUE, durable=True)
            ch.basic_publish(exchange="", routing_key=RESULT_QUEUE,
                             body=json.dumps(result),
                             properties=pika.BasicProperties(delivery_mode=2))
            conn.close()
        except Exception as e:
            print(f"[pq] result publish error: {e}", flush=True)


def _get_contest_data_dir(problem_id):
    """Return contest data dir for a problem if contest data is ready, else None."""
    with _contest_data_lock:
        if problem_id not in _contest_data_ready:
            return None
    for entry in os.listdir(CONTEST_DATA_ROOT):
        contest_dir = os.path.join(CONTEST_DATA_ROOT, entry)
        if not os.path.isdir(contest_dir):
            continue
        candidate = os.path.join(contest_dir, f"p{problem_id}")
        if os.path.isdir(candidate):
            return candidate
    return None

# ==================== Problem Data Fetcher ====================
def fetch_problem_data(problem_id):
    """
    Fetch problem limits + testcases/generators (DB direct, fallback middleware).
    Returns (time_ms, mem_mb, data_dir) where data_dir contains:
      - N.in / N.out pairs (testcases)
      - or compiled generator binaries
    Uses LRU cache to avoid re-fetching.
    Enters data_prep cgroup (low CPU weight) during data preparation
    so that active judge processes can preempt CPU resources.
    """
    with DataPrepPreempt():
        return _fetch_problem_data_inner(problem_id)

def _fetch_problem_data_inner(problem_id):
    """Inner implementation of fetch_problem_data (runs inside data_prep cgroup)."""
    # 取题链路：Redis 20 题 LRU → 对象存储兜底并回填 Redis；本地磁盘目录每次重建
    # DB direct first; on failure fallback to middleware
    try:
        pdata = _db_fetch_problem(problem_id)
        if not pdata:
            raise RuntimeError("problem not found in db")
        print(f"[fetch] problem {problem_id} meta from db", flush=True)
    except Exception as e:
        print(f"[fetch] db meta error, fallback middleware: {e}", flush=True)
        pdata = _mw_get(f"/api/problem?id={problem_id}")
    time_ms = pdata.get("timeMs", 1000)
    mem_mb = pdata.get("memMb", 256)

    data_dir = os.path.join(DATA_ROOT, f"p{problem_id}")
    os.makedirs(data_dir, exist_ok=True)

    # 0a. 先查 Redis 20 题 LRU 缓存，命中即落盘返回
    _cached = _pd_lru_get(problem_id)
    if _cached:
        _pd_write_dir(data_dir, _cached)
        return time_ms, mem_mb, data_dir
    # 0b. 未命中：从对象存储 /problem_data/{pid}/ 下载，落盘并回种 Redis
    try:
        from urllib.request import Request as _Req
        _lst = _Req(FILER_BASE + "/problem_data/%s/?limit=500" % problem_id,
                    headers={"Accept": "application/json"})
        with urlopen(_lst, timeout=20) as _lr:
            _entries = json.loads(_lr.read().decode("utf-8")).get("Entries") or []
        _names = [str(e.get("FullPath", "")).rsplit("/", 1)[-1] for e in _entries]
        _names = [n for n in _names if n.endswith(".in") or n.endswith(".out")]
        _pairs = [n for n in _names if n.endswith(".in") and (n[:-3] + ".out") in _names]
        if _pairs:
            _files = {}
            for n in _names:
                with urlopen(FILER_BASE + "/problem_data/%s/%s" % (problem_id, n), timeout=20) as _fr:
                    _files[n] = _fr.read()
            _pd_write_dir(data_dir, _files)
            _pd_lru_put(problem_id, _files)   # 回种 Redis 并维护 LRU
            print(f"[fetch] problem {problem_id} data from object storage ({len(_pairs)} pairs) -> Redis", flush=True)
            return time_ms, mem_mb, data_dir
    except Exception as e:
        print(f"[fetch] object storage data unavailable for {problem_id}: {e}, fallback", flush=True)

    # 1. Try testcases: DB direct first, fallback middleware
    try:
        tcs = _db_fetch_testcases(problem_id)
        print(f"[fetch] problem {problem_id} testcases from db ({len(tcs)})", flush=True)
    except Exception as e:
        print(f"[fetch] db testcases error, fallback middleware: {e}", flush=True)
        tcs = _mw_get(f"/api/testcases?problemId={problem_id}")
        if isinstance(tcs, list) and len(tcs) > 0:
            for i, tc in enumerate(tcs, 1):
                inp = tc.get("input", "")
                out = tc.get("output", "")
                with open(os.path.join(data_dir, f"{i}.in"), "w") as f:
                    f.write(inp)
                with open(os.path.join(data_dir, f"{i}.out"), "w") as f:
                    f.write(out)
            print(f"[fetch] problem {problem_id}: {len(tcs)} testcases loaded", flush=True)
            return time_ms, mem_mb, data_dir
    except Exception as e:
        print(f"[fetch] testcases API error: {e}", flush=True)

    # 2. Try generators: compile and run to produce test data
    generators = pdata.get("generators", [])
    tc_idx = 1
    if generators:
        for gen in generators:
            gen_code = gen.get("code", "")
            gen_exe = gen.get("exe", "")
            gen_count = gen.get("genCount", 1)
            if not gen_code and not gen_exe:
                continue
            gen_bin = os.path.join(data_dir, f"gen_{gen['id']}")
            if gen_exe:
                # 优先使用预编译产物：解 base64 写到 tmpfs(/dev/shm)，不落盘、免编译，避免权限类失败
                gen_bin = os.path.join("/dev/shm", f"gen_{gen['id']}")
                try:
                    with open(gen_bin, "wb") as f:
                        f.write(base64.b64decode(gen_exe))
                    os.chmod(gen_bin, 0o755)
                    print(f"[fetch] gen {gen['id']} using prebuilt exe from db", flush=True)
                except Exception as e:
                    print(f"[fetch] gen {gen['id']} exe decode failed: {e}, fallback to compile", flush=True)
                    gen_exe = ""
            if not gen_exe:
                # 无预编译产物：按原路径编译源码，成功后回写 exe 到数据库
                gen_src = os.path.join(data_dir, f"gen_{gen['id']}.cpp")
                gen_bin = os.path.join(data_dir, f"gen_{gen['id']}")
                with open(gen_src, "w") as f:
                    f.write(gen_code)
                try:
                    r = subprocess.run(
                        ["g++", "-O2", "-std=c++17", "-o", gen_bin, gen_src],
                        capture_output=True, timeout=30
                    )
                    if r.returncode != 0:
                        print(f"[fetch] gen {gen['id']} compile failed: {r.stderr.decode()[:200]}", flush=True)
                        continue
                    _db_write_gen_exe(gen['id'], gen_bin)
                except Exception as e:
                    print(f"[fetch] gen {gen['id']} compile error: {e}", flush=True)
                    continue
            # Run generator: capture stdout → .in files
            for seed in range(1, gen_count + 1):
                out_name = f"{tc_idx}.in"
                out_path = os.path.join(data_dir, out_name)
                try:
                    with open(out_path, "wb") as outf:
                        r = subprocess.run(
                            [gen_bin, data_dir, str(seed)],
                            stdout=outf, stderr=subprocess.PIPE,
                            timeout=10, cwd=data_dir
                        )
                    if r.returncode != 0:
                        print(f"[fetch] gen {gen['id']} seed={seed} exit={r.returncode}", flush=True)
                        os.remove(out_path)
                    else:
                        tc_idx += 1
                except Exception as e:
                    print(f"[fetch] gen {gen['id']} seed={seed} error: {e}", flush=True)
            print(f"[fetch] gen {gen['id']} produced {gen_count} datasets", flush=True)

        # Count generated .in files
        in_files = sorted_case_files(data_dir)
        if in_files:
            # Compile stdCode to generate .out answer files
            std_code = pdata.get("stdCode", "")
            if std_code:
                std_src = os.path.join(data_dir, "std.cpp")
                std_bin = os.path.join(data_dir, "std_bin")
                with open(std_src, "w") as f:
                    f.write(std_code)
                try:
                    r = subprocess.run(
                        ["g++", "-O2", "-std=c++17", "-o", std_bin, std_src],
                        capture_output=True, timeout=30
                    )
                    if r.returncode == 0:
                        for inf in in_files:
                            out_name = inf.replace(".in", ".out")
                            out_path = os.path.join(data_dir, out_name)
                            in_path = os.path.join(data_dir, inf)
                            try:
                                with open(in_path, "rb") as inf_f, open(out_path, "wb") as outf_f:
                                    subprocess.run(
                                        [std_bin], stdin=inf_f, stdout=outf_f,
                                        stderr=subprocess.PIPE, timeout=30
                                    )
                            except Exception as e:
                                print(f"[fetch] std run {inf} error: {e}", flush=True)
                        print(f"[fetch] problem {problem_id}: {len(in_files)} answers generated via stdCode", flush=True)
                    else:
                        print(f"[fetch] stdCode compile failed: {r.stderr.decode()[:200]}", flush=True)
                except Exception as e:
                    print(f"[fetch] stdCode compile error: {e}", flush=True)
            print(f"[fetch] problem {problem_id}: {len(in_files)} generated test inputs", flush=True)
            return time_ms, mem_mb, data_dir

    # 3. Fallback: use sampleIn/sampleOut as single testcase
    sample_in = pdata.get("sampleIn", "")
    sample_out = pdata.get("sampleOut", "")
    if sample_in:
        with open(os.path.join(data_dir, "1.in"), "w") as f:
            f.write(sample_in.replace("\r\n", "\n"))
        if sample_out:
            with open(os.path.join(data_dir, "1.out"), "w") as f:
                f.write(sample_out.replace("\r\n", "\n"))
        print(f"[fetch] problem {problem_id}: using sample as testcase", flush=True)

    return time_ms, mem_mb, data_dir

# ==================== Orchestrator Management ====================
def start_orchestrator():
    global orch_proc
    print(f"[consumer] starting orchestrator on port {ORCH_HTTP_PORT}...", flush=True)
    orch_proc = subprocess.Popen(
        ["/home/admin/eval-worker/build/orchestrator", str(ORCH_HTTP_PORT)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
    )
    def drain():
        for line in orch_proc.stdout:
            print(f"[orch] {line.rstrip()}", flush=True)
    threading.Thread(target=drain, daemon=True).start()
    time.sleep(0.5)
    print(f"[consumer] orchestrator PID={orch_proc.pid}", flush=True)

def submit_to_orchestrator(task_json):
    global orch_proc
    if not orch_proc or orch_proc.poll() is not None:
        start_orchestrator()
    try:
        orch_proc.stdin.write(task_json + "\n")
        orch_proc.stdin.flush()
        return True
    except Exception as e:
        print(f"[consumer] orchestrator stdin error: {e}, restarting...", flush=True)
        start_orchestrator()
        try:
            orch_proc.stdin.write(task_json + "\n")
            orch_proc.stdin.flush()
            return True
        except Exception as e2:
            print(f"[consumer] orchestrator restart failed: {e2}", flush=True)
            return False

def poll_result(task_id, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            url = f"http://127.0.0.1:{ORCH_HTTP_PORT}/task/{task_id}"
            resp = urlopen(url, timeout=2)
            data = json.loads(resp.read())
            status = data.get("status", "")
            if status == "finished":
                result = data.get("result", {})
                if isinstance(result, str):
                    result = json.loads(result)
                return result
            elif status == "error":
                result = data.get("result", {})
                if isinstance(result, str):
                    try: result = json.loads(result)
                    except: result = {"task_id": task_id, "status": "SE", "error": result}
                return result
        except Exception:
            pass
        time.sleep(0.3)
    return {"task_id": task_id, "status": "SE", "error": "orchestrator poll timeout"}

def _pids_for(lang):
    """JVM 要开 GC/JIT/编译线程，进程配额必须比 C/C++ 高一大截。"""
    if lang == "java":
        return 96
    if lang in ("py", "python", "python3"):
        return 16
    return 32


# ==================== Compile User Code ====================
def compile_code(code, lang, work_dir, mem_bytes=0):
    """Compile user code inside data_prep cgroup to yield CPU to judges."""
    with DataPrepPreempt():
        return _compile_code_inner(code, lang, work_dir, mem_bytes)

def _compile_code_inner(code, lang, work_dir, mem_bytes=0):
    src_map = {"c": "main.c", "cpp": "main.cpp", "cc": "main.cpp",
               "go": "main.go", "py": "main.py", "python": "main.py",
               "python3": "main.py", "java": "Main.java"}
    cmd_map = {
        "c":   ["gcc", "-O2", "-std=c17", "-o", "user_bin", "main.c", "-lm"],
        "cpp": ["g++", "-O2", "-std=c++17", "-o", "user_bin", "main.cpp", "-lm"],
        "cc":  ["g++", "-O2", "-std=c++17", "-o", "user_bin", "main.cpp", "-lm"],
        "go":  ["go", "build", "-o", "user_bin", "main.go"],
        "java": ["javac", "Main.java"],
    }
    ext = src_map.get(lang)
    if not ext:
        return None, f"Unsupported language: {lang}"
    with open(os.path.join(work_dir, ext), "w") as f:
        f.write(code)
    # Python：解释执行，生成统一入口 wrapper
    if lang in ("py", "python", "python3"):
        # -B 不写 __pycache__（nobody 写不进 work_dir），-u 不缓冲，超时被杀也能拿到已输出内容
        wrapper = os.path.join(work_dir, "user_bin")
        with open(wrapper, "w") as f:
            f.write("#!/bin/sh\nexec python3 -B -u "
                    + os.path.join(work_dir, "main.py") + "\n")
        os.chmod(wrapper, 0o755)
        return wrapper, None
    try:
        env = os.environ.copy()
        if lang == "go":
            env["GOCACHE"] = os.path.join(work_dir, ".gocache")
            env["GOPATH"] = os.path.join(work_dir, ".gopath")
            env["GOTOOLCHAIN"] = "local"
            env["CGO_ENABLED"] = "0"
        r = subprocess.run(cmd_map[lang], cwd=work_dir, capture_output=True,
                           timeout=COMPILE_TIMEOUT, env=env)
        if r.returncode != 0:
            return None, r.stderr.decode("utf-8", errors="replace")[:4096]
        # Java：编译产出 Main.class，生成统一入口 wrapper
        if lang == "java":
            # JVM 默认按宿主物理内存挑堆，会直接撞穿 cgroup memory.max 被 OOM kill，
            # 必须显式 -Xmx；同时压掉 hsperfdata 写入和多余的 GC/JIT 线程。
            heap_mb = 128
            if mem_bytes > 0:
                heap_mb = max(32, int(mem_bytes * 0.5) // (1024 * 1024))
            wrapper = os.path.join(work_dir, "user_bin")
            with open(wrapper, "w") as f:
                f.write("#!/bin/sh\nexec java "
                        "-XX:-UsePerfData -XX:+UseSerialGC -XX:ActiveProcessorCount=2 "
                        "-Dfile.encoding=UTF-8 -Xss16m -Xmx%dm -cp %s Main\n"
                        % (heap_mb, work_dir))
            os.chmod(wrapper, 0o755)
            return wrapper, None
        return os.path.join(work_dir, "user_bin"), None
    except subprocess.TimeoutExpired:
        return None, f"Compilation timed out ({COMPILE_TIMEOUT}s)"
    except Exception as e:
        return None, str(e)

# ==================== 函数式判题（编译用户代码为共享库）====================
def compile_shared(code, lang, work_dir):
    """Compile user code to shared library (functional judging: solve interface)."""
    with DataPrepPreempt():
        return _compile_shared_inner(code, lang, work_dir)

def _compile_shared_inner(code, lang, work_dir):
    src_map = {"c": "solve.c", "cpp": "solve.cpp", "cc": "solve.cpp"}
    cmd_map = {
        "c":   ["gcc", "-O2", "-std=c17", "-shared", "-fPIC", "-o", "user.so", "solve.c", "-lm"],
        "cpp": ["g++", "-O2", "-std=c++17", "-shared", "-fPIC", "-o", "user.so", "solve.cpp", "-lm"],
        "cc":  ["g++", "-O2", "-std=c++17", "-shared", "-fPIC", "-o", "user.so", "solve.cpp", "-lm"],
    }
    ext = src_map.get(lang)
    if not ext:
        return None, f"函数式判题仅支持 C/C++，当前语言: {lang}"
    with open(os.path.join(work_dir, ext), "w") as f:
        f.write(code)
    try:
        r = subprocess.run(cmd_map[lang], cwd=work_dir, capture_output=True, timeout=COMPILE_TIMEOUT)
        if r.returncode != 0:
            return None, r.stderr.decode("utf-8", errors="replace")[:4096]
        return os.path.join(work_dir, "user.so"), None
    except subprocess.TimeoutExpired:
        return None, f"Compilation timed out ({COMPILE_TIMEOUT}s)"
    except Exception as e:
        return None, str(e)

# ==================== 判题辅助 ====================
def _b64decode(s):
    try:
        return base64.b64decode(s)
    except Exception:
        return b""

def _normalize(raw):
    """与客户端 judge.cpp normalize 一致：去 BOM、去 \r、去行尾空白、去末尾空行。"""
    s = raw
    if isinstance(s, bytes):
        s = s.decode("utf-8", errors="replace")
    if s.startswith("\ufeff"):
        s = s[1:]
    s = s.replace("\r", "")
    lines = s.split("\n")
    lines = [l.rstrip(" \t") for l in lines]
    while lines and lines[-1] == "":
        lines.pop()
    return "\n".join(lines)

def _get_problem_meta(problem_id):
    """拉取题目完整元数据（含 spj/entry/judgeMode），DB 直连优先，失败回退 middleware，仍失败返回空 dict。"""
    try:
        return _db_fetch_problem(problem_id)
    except Exception as e:
        print(f"[consumer] db problem meta error, fallback middleware: {e}", flush=True)
    try:
        return _mw_get(f"/api/problem?id={problem_id}")
    except Exception as e:
        print(f"[consumer] problem meta error: {e}", flush=True)
        return {}

def _prepare_checker(pdata, data_dir):
    """
    准备特殊判题器 spj 与函数式判题入口 entry 的二进制。
    返回 (spj_binary, entry_binary, judge_mode)；二进制为空表示不存在/编译失败。
    """
    judge_mode = 1 if pdata.get("judgeMode") else 0
    spj_binary = ""
    spj_code = pdata.get("spjCode", "") or ""
    spj_exe = pdata.get("spjExe", "") or ""
    if spj_exe:
        spj_binary = os.path.join(data_dir, "spj_bin")
        with open(spj_binary, "wb") as f:
            f.write(_b64decode(spj_exe))
        os.chmod(spj_binary, 0o755)
    elif spj_code:
        spj_src = os.path.join(data_dir, "spj.cpp")
        spj_binary = os.path.join(data_dir, "spj_bin")
        with open(spj_src, "w") as f:
            f.write(spj_code)
        r = subprocess.run(["g++", "-O2", "-std=c++17", "-o", spj_binary, spj_src],
                           capture_output=True, timeout=30)
        if r.returncode != 0:
            print(f"[consumer] spj compile failed: {r.stderr.decode()[:200]}", flush=True)
            spj_binary = ""

    entry_binary = ""
    if judge_mode:
        entry_code = pdata.get("entryCode", "") or ""
        entry_exe = pdata.get("entryExe", "") or ""
        if entry_exe:
            entry_binary = os.path.join(data_dir, "entry_bin")
            with open(entry_binary, "wb") as f:
                f.write(_b64decode(entry_exe))
            os.chmod(entry_binary, 0o755)
        elif entry_code:
            entry_src = os.path.join(data_dir, "entry.cpp")
            entry_binary = os.path.join(data_dir, "entry_bin")
            with open(entry_src, "w") as f:
                f.write(entry_code)
            r = subprocess.run(["g++", "-O2", "-std=c++17", "-o", entry_binary, entry_src],
                               capture_output=True, timeout=30)
            if r.returncode != 0:
                print(f"[consumer] entry compile failed: {r.stderr.decode()[:200]}", flush=True)
                entry_binary = ""
    return spj_binary, entry_binary, judge_mode

def _run_orch(orch_task, sub_task_id, timeout):
    """提交任务到 orchestrator 并等待结果，返回 result dict（status/cpu_ns/mem_bytes/...）。"""
    if not submit_to_orchestrator(json.dumps(orch_task)):
        return {"task_id": sub_task_id, "status": "SE", "error": "orchestrator submit failed"}
    return poll_result(sub_task_id, timeout=timeout)

# ==================== Core: Process Task ====================
def process_task(body):
    req = json.loads(body)
    task_id = req.get("task_id", f"mq_{uuid.uuid4().hex[:10]}")
    code = req.get("code", "")
    lang = req.get("language", "cpp").lower()
    problem_id = req.get("problem_id", 0)

    print(f"[consumer] task={task_id} problem={problem_id} lang={lang}", flush=True)

    _publish_status(task_id, "pending")
    # 1. Fetch problem data (limits + testcases) via middleware, with LRU cache
    #    Contest data takes priority if pre-downloaded
    try:
        contest_dir = _get_contest_data_dir(problem_id)
        if contest_dir:
            try:
                pdata = _db_fetch_problem(problem_id)
                if not pdata:
                    raise RuntimeError("problem not found in db")
            except Exception as e:
                print(f"[consumer] db limits error, fallback middleware: {e}", flush=True)
                pdata = _mw_get(f"/api/problem?id={problem_id}")
            time_ms = pdata.get("timeMs", 1000)
            mem_mb = pdata.get("memMb", 256)
            data_dir = contest_dir
            print(f"[consumer] task={task_id} using contest data for problem {problem_id}", flush=True)
        else:
            time_ms, mem_mb, data_dir = fetch_problem_data(problem_id)
        _publish_status(task_id, "fetched")
    except Exception as e:
        print(f"[consumer] {task_id} fetch error: {e}", flush=True)
        return {"task_id": task_id, "status": "SE", "error": f"fetch problem data: {e}"}

    # 1b. 拉取题目元数据（judgeMode / spj / entry），准备判定器与入口
    pdata = _get_problem_meta(problem_id)
    spj_binary, entry_binary, judge_mode = _prepare_checker(pdata, data_dir)

    # 运行时启动的固定开销不占题目时限：JVM 启动+类加载约 150~400ms CPU，
    # 直接计入的话 1s 的题 Java 只剩一半。补贴是固定值，不按倍数放大。
    startup_ms = {"java": 300, "py": 60, "python": 60, "python3": 60,
                  "go": 20}.get(lang, 0)
    cpu_ms = min(time_ms, 10000) + startup_ms
    mem_bytes = min(mem_mb * 1024 * 1024, 536870912)

    # 2. Compile user code（函数式判题编译为共享库 user.so）
    work_dir = os.path.join(tempfile.gettempdir(), f"judge_{task_id}")
    os.makedirs(work_dir, exist_ok=True)
    _publish_status(task_id, "compiling")
    if judge_mode:
        if not entry_binary:
            shutil.rmtree(work_dir, ignore_errors=True)
            return {"task_id": task_id, "status": "SE", "error": "题目入口缺失（entry 不存在或编译失败）"}
        binary, err = compile_shared(code, lang, work_dir)
    else:
        binary, err = compile_code(code, lang, work_dir, mem_bytes)
    if err:
        print(f"[consumer] {task_id} -> CE", flush=True)
        shutil.rmtree(work_dir, ignore_errors=True)
        return {"task_id": task_id, "status": "CE", "error": err}

    # 3. Find testcase pairs
    in_files = sorted_case_files(data_dir)
    if not in_files:
        print(f"[consumer] {task_id} no testcases found", flush=True)
        shutil.rmtree(work_dir, ignore_errors=True)
        return {"task_id": task_id, "status": "SE", "error": "no testcases"}

    _publish_status(task_id, "running", {"total_cases": len(in_files)})
    # 4. Judge each testcase through orchestrator → eval_worker
    total_cpu_ns = 0
    max_mem = 0
    worst_status = "AC"
    first_error = ""
    ac_count = 0
    cases_out = []   # 逐测试点结果（客户端按点展示）

    for in_file in in_files:
        tc_name = in_file.replace(".in", "")
        out_file = os.path.join(data_dir, tc_name + ".out")
        expected_file = out_file if os.path.exists(out_file) else ""
        stdin_file = os.path.join(data_dir, in_file)
        sub_task_id = f"{task_id}_{tc_name}"

        st = "SE"
        case_err = ""
        case_cpu = 0
        case_mem = 0

        if judge_mode:
            # 函数式判题：entry <user.so> <输入> <输出> <时间>
            # 输出/时间文件放 /tmp（世界可写）：沙箱以 nobody 身份运行 entry，需能写这些文件。
            out_tmp = f"/tmp/judge_{task_id}_{tc_name}.out"
            time_tmp = f"/tmp/judge_{task_id}_{tc_name}.time"
            orch_task = {
                "task_id": sub_task_id,
                "user_binary": entry_binary,
                "args": [binary, stdin_file, out_tmp, time_tmp],
                "stdin_file": "",
                "expected_output_file": "",
                "cpu_limit_ms": cpu_ms,
                "mem_limit_bytes": mem_bytes,
                "max_pids": 32,
            }
            result = _run_orch(orch_task, sub_task_id, timeout=cpu_ms // 1000 * 3 + 10)
            st = result.get("status", "SE")
            case_cpu = result.get("cpu_ns", 0)
            case_mem = result.get("mem_bytes", 0)
            if st == "AC":
                try:
                    with open(out_tmp, "rb") as f:
                        user_out = f.read()
                except Exception:
                    user_out = b""
                if expected_file:
                    try:
                        with open(expected_file, "rb") as f:
                            exp_out = f.read()
                    except Exception:
                        exp_out = b""
                    if _normalize(user_out) == _normalize(exp_out):
                        st = "AC"
                    else:
                        st = "WA"
                        case_err = "输出与标准答案不一致"
                else:
                    st = "WA"
                    case_err = "输出与标准答案不一致"
            elif st == "TLE":
                case_err = "运行超时"
            elif st == "MLE":
                case_err = "内存超限"
            elif st == "RE":
                case_err = result.get("error", "") or result.get("stderr", "") or "运行时错误"
            elif st == "SE":
                case_err = result.get("error", "") or "系统错误"

        elif spj_binary:
            # 特殊判题：先跑用户程序（stdin → stdout），再跑 spj <用户输出> <标准输出> <输入>
            user_out_path = f"/tmp/eval_{sub_task_id}/stdout.txt"
            orch_task = {
                "task_id": sub_task_id,
                "user_binary": binary,
                "stdin_file": stdin_file,
                "expected_output_file": "",
                "cpu_limit_ms": cpu_ms,
                "mem_limit_bytes": mem_bytes,
                "max_pids": _pids_for(lang),
            }
            result = _run_orch(orch_task, sub_task_id, timeout=cpu_ms // 1000 * 3 + 10)
            st = result.get("status", "SE")
            case_cpu = result.get("cpu_ns", 0)
            case_mem = result.get("mem_bytes", 0)
            if st == "AC":
                spj_task_id = f"{sub_task_id}_spj"
                spj_task = {
                    "task_id": spj_task_id,
                    "user_binary": spj_binary,
                    "args": [user_out_path, expected_file, stdin_file],
                    "stdin_file": "",
                    "expected_output_file": "",
                    "checker": "exitcode",
                    "cpu_limit_ms": 5000,
                    "mem_limit_bytes": mem_bytes,
                    "max_pids": 32,
                }
                spj_result = _run_orch(spj_task, spj_task_id, timeout=15)
                case_cpu += spj_result.get("cpu_ns", 0)
                case_mem = max(case_mem, spj_result.get("mem_bytes", 0))
                sst = spj_result.get("status", "SE")
                if sst == "AC":
                    st = "AC"
                elif sst == "WA":
                    st = "WA"
                    case_err = spj_result.get("error", "") or "special judge 未通过"
                else:
                    st = "SE"
                    case_err = "special judge 运行失败"
            elif st == "TLE":
                case_err = "运行超时"
            elif st == "MLE":
                case_err = "内存超限"
            elif st == "RE":
                case_err = result.get("error", "") or result.get("stderr", "") or "运行时错误"
            elif st == "SE":
                case_err = result.get("error", "") or "系统错误"

        else:
            # 普通判题：eval_worker 直接比对 stdout 与期望输出
            orch_task = {
                "task_id": sub_task_id,
                "user_binary": binary,
                "stdin_file": stdin_file,
                "expected_output_file": expected_file,
                "cpu_limit_ms": cpu_ms,
                "mem_limit_bytes": mem_bytes,
                "max_pids": _pids_for(lang),
            }
            result = _run_orch(orch_task, sub_task_id, timeout=cpu_ms // 1000 * 3 + 10)
            st = result.get("status", "SE")
            case_cpu = result.get("cpu_ns", 0)
            case_mem = result.get("mem_bytes", 0)
            if st == "WA":
                case_err = "输出与标准答案不一致"
            elif st == "TLE":
                case_err = "运行超时"
            elif st == "MLE":
                case_err = "内存超限"
            elif st == "RE":
                case_err = result.get("error", "") or result.get("stderr", "") or "运行时错误"
            elif st == "SE":
                case_err = result.get("error", "") or "系统错误"

        total_cpu_ns += case_cpu
        max_mem = max(max_mem, case_mem)
        if st == "AC":
            ac_count += 1
        else:
            if worst_status == "AC":
                worst_status = st
            if not first_error:
                first_error = case_err or st
        cases_out.append({"name": tc_name, "status": st,
                          "cpu_ms": int(case_cpu // 1000000), "error": case_err})

        print(f"[consumer] {task_id} tc={tc_name} -> {st}", flush=True)
        _publish_status(task_id, "running", {"ac_count": ac_count, "done_cases": in_files.index(in_file)+1, "total_cases": len(in_files)})

    # 5. Cleanup work dir (keep problem data in LRU cache)
    shutil.rmtree(work_dir, ignore_errors=True)

    final = {
        "task_id": task_id,
        "problem_id": problem_id,
        "status": worst_status,
        "ac_count": ac_count,
        "total_cases": len(in_files),
        "cpu_ns": total_cpu_ns,
        "cpu_ms": int(total_cpu_ns // 1000000),
        "mem_bytes": max_mem,
        "mem_mb": round(max_mem / (1024 * 1024), 1),
        "cases": cases_out,
    }
    if first_error and worst_status != "AC":
        final["error"] = first_error[:500]

    print(f"[consumer] {task_id} -> {worst_status} ({ac_count}/{len(in_files)} AC)", flush=True)
    return final

# ==================== Main ====================
def main():
    os.makedirs(DATA_ROOT, exist_ok=True)
    start_orchestrator()

    # Start contest priority-queue judge worker
    threading.Thread(target=_contest_worker, daemon=True).start()
    print(f"[pq] contest judge worker started (min-heap by submit count)", flush=True)

    print(f"[consumer] connecting to {MQ_HOST}:{MQ_PORT}...", flush=True)
    conn = pika.BlockingConnection(pika.ConnectionParameters(MQ_HOST, MQ_PORT))
    ch = conn.channel()
    ch.queue_declare(queue=TASK_QUEUE, durable=True)
    ch.queue_declare(queue=RESULT_QUEUE, durable=True)
    ch.basic_qos(prefetch_count=20)

    def callback(ch, method, properties, body):
        try:
            raw = body.decode("utf-8")
            req = json.loads(raw)
            msg_type = req.get("type", "")
            if msg_type == "contest_data_prepare":
                cid = req.get("contest_id", "")
                print(f"[consumer] contest_data_prepare contest={cid}", flush=True)
                threading.Thread(target=_prepare_contest_data, args=(cid,), daemon=True).start()
            elif msg_type == "contest_data_cleanup":
                cid = req.get("contest_id", "")
                print(f"[consumer] contest_data_cleanup contest={cid}", flush=True)
                threading.Thread(target=_cleanup_contest_data, args=(cid,), daemon=True).start()
            else:
                if req.get("contest_id", 0):
                    _enqueue_contest_task(raw)
                else:
                    result = process_task(raw)
                    ch.basic_publish(exchange="", routing_key=RESULT_QUEUE,
                                     body=json.dumps(result),
                                     properties=pika.BasicProperties(delivery_mode=2))
        except Exception as e:
            err_result = {"task_id": "unknown", "status": "SE", "error": str(e)}
            ch.basic_publish(exchange="", routing_key=RESULT_QUEUE,
                             body=json.dumps(err_result),
                             properties=pika.BasicProperties(delivery_mode=2))
        finally:
            ch.basic_ack(delivery_tag=method.delivery_tag)

    ch.basic_consume(queue=TASK_QUEUE, on_message_callback=callback)
    print(f"[consumer] listening on '{TASK_QUEUE}' → orchestrator → eval_worker", flush=True)
    print(f"[consumer] data pipeline: middleware fetch → LRU cache → generate → judge → cleanup", flush=True)

    while running:
        try:
            conn.process_data_events(time_limit=1)
        except Exception:
            break

    conn.close()
    if orch_proc:
        try:
            orch_proc.stdin.close()
            orch_proc.terminate()
            orch_proc.wait(timeout=5)
        except Exception:
            orch_proc.kill()
    print("[consumer] stopped.", flush=True)

if __name__ == "__main__":
    main()
