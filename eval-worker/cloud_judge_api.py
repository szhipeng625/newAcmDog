import os
#!/usr/bin/env python3
"""ACMDOG Cloud Judge API - Lightweight HTTP bridge"""
import json, uuid, time, threading, ssl as _ssl, hashlib
import redis as _redis
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.request import urlopen, Request
from urllib.error import HTTPError
import pika, re
from datetime import datetime

MQ_HOST = "127.0.0.1"
MQ_PORT = 5672
# txy2 对象存储（SeaweedFS filer）：题面 JSON 存放于 /problems/{id}.json
FILER_BASE = "http://43.157.53.29:8888"

# ---- 题目数据统一从 txy2 对象存储读取（DB problems 表已清空，仅保留提交记录）----
_filer_list_cache = {"ts": 0.0, "data": []}
_filer_list_lock = threading.Lock()


def _filer_get_problem(pid):
    """读取单题 JSON；失败返回 {}。"""
    try:
        with urlopen(FILER_BASE + "/problems/" + str(pid) + ".json", timeout=10) as _fr:
            return json.loads(_fr.read().decode("utf-8"))
    except Exception as e:
        print(f"[api] filer get problem {pid} failed: {e}", flush=True)
        return {}


def _filer_list_problems(ttl=15):
    """列出对象存储 /problems 下全部题目 JSON（短 TTL 缓存）。"""
    now = time.time()
    with _filer_list_lock:
        if now - _filer_list_cache["ts"] < ttl and _filer_list_cache["data"]:
            return _filer_list_cache["data"]
    ids = []
    try:
        req = Request(FILER_BASE + "/problems/?limit=2000", headers={"Accept": "application/json"})
        with urlopen(req, timeout=20) as _fr:
            listing = json.loads(_fr.read().decode("utf-8"))
        for ent in listing.get("Entries") or []:
            name = str(ent.get("FullPath", "")).rsplit("/", 1)[-1]
            if name.endswith(".json") and name[:-5].isdigit():
                ids.append(int(name[:-5]))
    except Exception as e:
        print(f"[api] filer list failed: {e}", flush=True)
    data = []
    for pid in sorted(ids):
        p = _filer_get_problem(pid)
        if not p:
            continue
        p.setdefault("id", pid)
        data.append(p)
    with _filer_list_lock:
        _filer_list_cache["ts"] = time.time()
        _filer_list_cache["data"] = data
    return data


def _nav_list_problems():
    """从 DB problems 导航表读取题目列表，并统计每题的通过率与难度。

    返回字段：id/title/tags/isPublic/timeMs/memMb/difficulty/accepted/submissions
    - difficulty: 1=简单 2=中等 3=困难 0=未标记
    - accepted: 该题 AC 提交数（去重按 task_id 计判题结果）
    - submissions: 该题总提交数（judge 表中的最终评测条数）
    """
    try:
        with _db_conn() as c:
            with c.cursor() as cur:
                cur.execute(
                    "SELECT id, title, tags, is_public, time_ms, mem_mb, difficulty FROM problems ORDER BY id")
                rows = cur.fetchall()
        out = []
        for r in rows:
            try:
                tags = json.loads(r[2]) if r[2] else []
            except Exception:
                tags = [t.strip() for t in str(r[2] or "").split(",") if t.strip()]
            out.append({"id": r[0], "title": r[1] or "", "tags": tags,
                        "isPublic": bool(r[3]), "timeMs": r[4] or 1000, "memMb": r[5] or 256,
                        "difficulty": r[6] or 0, "accepted": 0, "submissions": 0})
        # 统计每题通过率（从 judge 表聚合；judge 与 submit 一一对应）
        try:
            with _db_conn() as c:
                with c.cursor() as cur:
                    cur.execute(
                        "SELECT problem_id, "
                        "SUM(CASE WHEN status='AC' THEN 1 ELSE 0 END) AS ac, "
                        "COUNT(*) AS total "
                        "FROM judge GROUP BY problem_id")
                    for pid, ac, total in cur.fetchall():
                        for p in out:
                            if p["id"] == pid:
                                p["accepted"] = int(ac or 0)
                                p["submissions"] = int(total or 0)
                                break
        except Exception as e:
            print(f"[api] nav stat pass rate failed: {e}", flush=True)
        return out
    except Exception as e:
        print(f"[api] nav list problems failed: {e}", flush=True)
        return []


def _nav_get_problem(pid):
    """从 DB 导航表读取单题题名与限制；失败返回空字典。"""
    try:
        with _db_conn() as c:
            with c.cursor() as cur:
                cur.execute("SELECT title, time_ms, mem_mb FROM problems WHERE id=%s", (pid,))
                row = cur.fetchone()
        if row:
            return {"title": row[0] or "", "timeMs": row[1] or 1000, "memMb": row[2] or 256}
    except Exception as e:
        print(f"[api] nav get problem {pid} failed: {e}", flush=True)
    return {}


TASK_QUEUE = "oj.judge"
RESULT_QUEUE = "oj.judge.result"
MIDDLEWARE_URL = "https://127.0.0.1:8899"
LISTEN_PORT = 18081
TIMEOUT_SEC = 30

# ---- 判题三表落库：直连本机 acmdog-mysql 的 oj 库 ----
import pymysql as _pymysql
_DB = dict(host="127.0.0.1", port=3306, user="oj_user", password=os.environ.get("OJ_DB_PASSWORD", ""),
           database="oj", charset="utf8mb4", autocommit=True,
           connect_timeout=5, read_timeout=10, write_timeout=10)

def _db_conn():
    return _pymysql.connect(**_DB)

def _db_submit(task_id, username, problem_id, problem_name, contest_id, language, code=""):
    """提交时写入 submit 表（含源码），返回 submit_id。"""
    try:
        with _db_conn() as c:
            with c.cursor() as cur:
                cur.execute(
                    "INSERT INTO submit (task_id, username, problem_id, problem_name, contest_id, language, status, code) "
                    "VALUES (%s,%s,%s,%s,%s,%s,'pending',%s)",
                    (task_id, username, problem_id, problem_name, contest_id, language, code))
                return cur.lastrowid
    except Exception as e:
        print(f'[api] db submit insert failed: {e}', flush=True)
        return 0

def _db_judge(submit_id, task_id, problem_id, status, ac_count, total_cases, cpu_ms, mem_mb, error):
    """判题完成时写入 judge 表，返回 judge_id。"""
    try:
        with _db_conn() as c:
            with c.cursor() as cur:
                cur.execute(
                    "INSERT INTO judge (submit_id, task_id, problem_id, status, ac_count, total_cases, cpu_ms, mem_mb, error) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (submit_id, task_id, problem_id, status, ac_count, total_cases, cpu_ms, mem_mb, error))
                jid = cur.lastrowid
                cur.execute("UPDATE submit SET status=%s WHERE id=%s", (status, submit_id))
                return jid
    except Exception as e:
        print(f'[api] db judge insert failed: {e}', flush=True)
        return 0

def _db_judge_run(judge_id, submit_id, task_id, cases):
    """判题完成时批量写入 judge_run 测试点明细。"""
    if not cases:
        return
    try:
        with _db_conn() as c:
            with c.cursor() as cur:
                rows = []
                for idx, case in enumerate(cases):
                    rows.append((judge_id, submit_id, task_id, idx + 1,
                                 case.get("name", ""), case.get("status", ""),
                                 case.get("cpu_ms", 0), (case.get("error") or "")[:2000]))
                # 判题中可能已有实时写入的该 task_id 记录，先删除再批量插入最终结果
                cur.execute("DELETE FROM judge_run WHERE task_id=%s", (task_id,))
                cur.executemany(
                    "INSERT INTO judge_run (judge_id, submit_id, task_id, case_index, case_name, status, cpu_ms, error) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)", rows)
    except Exception as e:
        print(f'[api] db judge_run insert failed: {e}', flush=True)

def _db_judge_run_point(task_id, point_idx, status, cpu_ms):
    """判题进行中：实时写入单个测试点结果（判题完成时会被最终批量数据替换）。"""
    try:
        with _db_conn() as c:
            with c.cursor() as cur:
                cur.execute(
                    "SELECT id FROM judge_run WHERE task_id=%s AND case_index=%s LIMIT 1",
                    (task_id, point_idx + 1))
                row = cur.fetchone()
                if row:
                    cur.execute(
                        "UPDATE judge_run SET status=%s, cpu_ms=%s WHERE id=%s",
                        (status, cpu_ms, row[0]))
                else:
                    cur.execute(
                        "INSERT INTO judge_run (judge_id, submit_id, task_id, case_index, case_name, status, cpu_ms, error) "
                        "VALUES (0, 0, %s, %s, %s, %s, %s, '')",
                        (task_id, point_idx + 1, "#" + str(point_idx + 1), status, cpu_ms))
    except Exception as e:
        print(f'[api] db judge_run_point upsert failed: {e}', flush=True)

def _db_finalize_judge(submit_id, task_id, problem_id, status, ac_count, total_cases,
                          cpu_ms, mem_mb, error, cases):
    """判题完成：事务原子化落库。

    顺序：写 judge 汇总 -> 覆写 judge_run 测试详情 -> 回写 submit 最终状态。
    全部在单个 InnoDB 事务内完成，任一环节失败整体回滚。
    """
    if not cases:
        cases = []
    try:
        conn = _db_conn()
        try:
            with conn.cursor() as cur:
                # 1) 写 judge 汇总记录
                cur.execute(
                    "INSERT INTO judge (submit_id, task_id, problem_id, status, ac_count, total_cases, cpu_ms, mem_mb, error) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (submit_id, task_id, problem_id, status, ac_count, total_cases, cpu_ms, mem_mb, error))
                judge_id = cur.lastrowid
                # 2) 覆写 judge_run 测试详情（判题中已有的临时记录一并清除后重写）
                cur.execute("DELETE FROM judge_run WHERE task_id=%s", (task_id,))
                if cases:
                    rows = []
                    for idx, case in enumerate(cases):
                        rows.append((judge_id, submit_id, task_id, idx + 1,
                                     case.get("name", ""), case.get("status", ""),
                                     case.get("cpu_ms", 0), (case.get("error") or "")[:2000]))
                    cur.executemany(
                        "INSERT INTO judge_run (judge_id, submit_id, task_id, case_index, case_name, status, cpu_ms, error) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)", rows)
                # 3) 回写 submit 最终状态
                cur.execute("UPDATE submit SET status=%s WHERE id=%s", (status, submit_id))
            conn.commit()
            return judge_id
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
    except Exception as e:
        print(f'[api] db finalize judge failed: {e}', flush=True)
        return 0


# ============ 提交对象存储：key=hash(源码标识+用户名)，value=测试详情 ============
_OBJ_PREFIX = "oj:substore:"
_OBJ_URI_BASE = "lsm://127.0.0.1:6380/" + _OBJ_PREFIX

def _make_store_key(username, code):
    """按『源码标识 + 用户名』组合后再哈希生成对象存储 key。"""
    code_hash = hashlib.sha256((code or "").encode("utf-8")).hexdigest()
    return hashlib.sha256((str(username or "") + ":" + code_hash).encode("utf-8")).hexdigest()

def _obj_put_submission(store_key, payload):
    """将源码+测试详情写入对象存储（LSM KV，Redis 协议）。"""
    import lsm_store as _lsm
    body = json.dumps(payload, ensure_ascii=False)
    r = _lsm.parse(_lsm.cmd("SET", _OBJ_PREFIX + store_key, body))
    return r == "OK"

def _obj_get_submission(store_key):
    """按 key 从对象存储取回测试详情。"""
    import lsm_store as _lsm
    raw = _lsm.parse(_lsm.cmd("GET", _OBJ_PREFIX + store_key))
    if not raw or isinstance(raw, dict):
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None

def _db_ensure_submission_store():
    with _db_conn() as c:
        with c.cursor() as cur:
            cur.execute(
                "CREATE TABLE IF NOT EXISTS submission_store ("
                "id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,"
                "submission_no VARCHAR(40) NOT NULL UNIQUE,"
                "store_key CHAR(64) NOT NULL UNIQUE,"
                "task_id VARCHAR(64) NOT NULL,"
                "username VARCHAR(64) NOT NULL DEFAULT '',"
                "problem_id INT NOT NULL DEFAULT 0,"
                "verdict VARCHAR(32) NOT NULL DEFAULT '',"
                "obj_uri VARCHAR(160) NOT NULL DEFAULT '',"
                "created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP"
                ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4")

def _db_lookup_submission(store_key):
    """按哈希 key 查询已登记提交；存在即视为重复提交过相同代码。"""
    try:
        _db_ensure_submission_store()
        with _db_conn() as c:
            with c.cursor() as cur:
                cur.execute(
                    "SELECT submission_no, task_id, username, problem_id, verdict, obj_uri "
                    "FROM submission_store WHERE store_key=%s LIMIT 1", (store_key,))
                row = cur.fetchone()
        if not row:
            return None
        return {"submission_no": row[0], "task_id": row[1], "username": row[2],
                "problem_id": row[3], "verdict": row[4], "obj_uri": row[5]}
    except Exception as e:
        print(f"[api] submission lookup failed: {e}", flush=True)
        return None

def _db_register_submission(store_key, task_id, username, problem_id, verdict, obj_uri):
    """登记最终提交：唯一提交编号 + 验收状态 + 对象存储位置；key 已存在时复用原编号。"""
    _db_ensure_submission_store()
    with _db_conn() as c:
        with c.cursor() as cur:
            cur.execute("SELECT submission_no FROM submission_store WHERE store_key=%s LIMIT 1", (store_key,))
            row = cur.fetchone()
            if row:
                return row[0]
            sno = "sub_" + uuid.uuid4().hex[:20]
            cur.execute(
                "INSERT INTO submission_store (submission_no, store_key, task_id, username, problem_id, verdict, obj_uri) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s)",
                (sno, store_key, task_id, username, problem_id, verdict, obj_uri))
            return sno

def _db_get_code(task_id):
    """按 task_id 回查 submit 表中的源码（判题结果消息不携带源码）。"""
    try:
        with _db_conn() as c:
            with c.cursor() as cur:
                cur.execute("SELECT code FROM submit WHERE task_id=%s LIMIT 1", (task_id,))
                row = cur.fetchone()
                return row[0] if row and row[0] else ""
    except Exception:
        return ""


def _trigger_vh_init(username):
    """Trigger virtual human account creation for OJ user."""
    try:
        import urllib.request
        body = json.dumps({"username": username}).encode()
        req = urllib.request.Request("http://127.0.0.1:18082/api/ai/vh_info",
            data=body, method="POST",
            headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass

_ssl_ctx = _ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = _ssl.CERT_NONE

_results = {}
_results_ts = {}
_results_lock = threading.Lock()
_task_meta = {}  # 持久保存 username/problem，避免被 SSE pop 消费掉

# ==================== 竞赛（Contest）功能 ====================
_CID_FONT = "STSong-Light"
_cid_font_ready = False


def _parse_ct_time(s):
    """解析竞赛时间字符串为时间戳（服务器本地时区），失败返回 None"""
    s = (s or "").strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(s, fmt).timestamp()
        except Exception:
            pass
    return None


def _fetch_contests():
    """从中间件获取竞赛列表并解析 content 字段"""
    raw = json.loads(_proxy_get("/api/contests"))
    contests = []
    for item in raw:
        try:
            c = json.loads(item.get("content", "{}"))
        except Exception:
            continue
        c["id"] = item.get("id", c.get("id"))
        contests.append(c)
    return contests


def _contest_summary(c):
    return {
        "id": c.get("id"),
        "name": c.get("name", ""),
        "description": c.get("description", ""),
        "startTime": c.get("startTime", ""),
        "endTime": c.get("endTime", ""),
        "startTs": _parse_ct_time(c.get("startTime", "")),
        "endTs": _parse_ct_time(c.get("endTime", "")),
        "problems": c.get("problems", []),
    }


def _md_inline(text):
    """转义特殊字符并处理行内代码/粗体/斜体"""
    text = str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    text = re.sub(r"`([^`]+)`", r'<font backColor="#f0f0f0">\1</font>', text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"\*([^*\n]+)\*", r"<i>\1</i>", text)
    return text


def _md_to_flowables(md_text, styles):
    """把 Markdown 题面粗略转换为 reportlab 段落列表"""
    from reportlab.platypus import Paragraph, Preformatted
    lines = (md_text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    flow, para_buf, code_buf = [], [], []
    in_code = False

    def flush_para():
        if para_buf:
            t = " ".join(x.strip() for x in para_buf).strip()
            if t:
                flow.append(Paragraph(_md_inline(t), styles["body"]))
            para_buf.clear()

    for ln in lines:
        s = ln.strip()
        if s.startswith("```"):
            if in_code:
                flow.append(Preformatted("\n".join(code_buf) or " ", styles["code"]))
                code_buf = []
                in_code = False
            else:
                flush_para()
                in_code = True
            continue
        if in_code:
            code_buf.append(ln.rstrip())
            continue
        if not s:
            flush_para()
            continue
        if s.startswith("####"):
            flush_para(); flow.append(Paragraph(_md_inline(s[4:].strip()), styles["h4"]))
        elif s.startswith("###"):
            flush_para(); flow.append(Paragraph(_md_inline(s[3:].strip()), styles["h3"]))
        elif s.startswith("##"):
            flush_para(); flow.append(Paragraph(_md_inline(s[2:].strip()), styles["h2"]))
        elif s.startswith("#"):
            flush_para(); flow.append(Paragraph(_md_inline(s[1:].strip()), styles["h2"]))
        elif s.startswith("- ") or s.startswith("* "):
            flush_para(); flow.append(Paragraph("\u2022 " + _md_inline(s[2:].strip()), styles["body"]))
        else:
            para_buf.append(s)
    if in_code and code_buf:
        flow.append(Preformatted("\n".join(code_buf), styles["code"]))
    flush_para()
    return flow


def _build_contest_pdf(contest, problems):
    """生成竞赛全部题面合并后的 PDF 字节"""
    global _cid_font_ready
    from io import BytesIO
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.enums import TA_CENTER
    from reportlab.lib.fonts import addMapping
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Preformatted
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    if not _cid_font_ready:
        pdfmetrics.registerFont(UnicodeCIDFont(_CID_FONT))
        addMapping(_CID_FONT, 0, 0, _CID_FONT)
        addMapping(_CID_FONT, 1, 0, _CID_FONT)
        addMapping(_CID_FONT, 0, 1, _CID_FONT)
        addMapping(_CID_FONT, 1, 1, _CID_FONT)
        _cid_font_ready = True
    styles = {
        "title": ParagraphStyle("ct", fontName=_CID_FONT, fontSize=22, leading=30, alignment=TA_CENTER, spaceAfter=8),
        "meta": ParagraphStyle("cm", fontName=_CID_FONT, fontSize=10.5, leading=15, alignment=TA_CENTER, textColor="#666666"),
        "ptitle": ParagraphStyle("pt", fontName=_CID_FONT, fontSize=16, leading=22, spaceBefore=4, spaceAfter=6),
        "h2": ParagraphStyle("h2", fontName=_CID_FONT, fontSize=13, leading=18, spaceBefore=10, spaceAfter=4),
        "h3": ParagraphStyle("h3", fontName=_CID_FONT, fontSize=12, leading=17, spaceBefore=8, spaceAfter=3),
        "h4": ParagraphStyle("h4", fontName=_CID_FONT, fontSize=11, leading=16, spaceBefore=6, spaceAfter=2),
        "body": ParagraphStyle("bd", fontName=_CID_FONT, fontSize=10.5, leading=16, spaceAfter=4),
        "code": ParagraphStyle("cd", fontName=_CID_FONT, fontSize=9.5, leading=13, backColor="#f5f5f5", borderPadding=6, leftIndent=6, spaceBefore=4, spaceAfter=8),
        "sample": ParagraphStyle("sp", fontName=_CID_FONT, fontSize=9.5, leading=13, backColor="#eef3ff", borderPadding=6, leftIndent=6, spaceBefore=2, spaceAfter=8),
    }
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm,
                            topMargin=18 * mm, bottomMargin=18 * mm,
                            title=str(contest.get("name", "contest")))
    story = [Paragraph(_md_inline(contest.get("name", "\u7ade\u8d5b\u9898\u9762")), styles["title"])]
    story.append(Paragraph(_md_inline("\u65f6\u95f4\uff1a%s ~ %s" % (contest.get("startTime", ""), contest.get("endTime", ""))), styles["meta"]))
    story.append(Spacer(1, 6 * mm))
    for idx, p in enumerate(problems, 1):
        if idx > 1:
            story.append(PageBreak())
        story.append(Paragraph(_md_inline("\u7b2c %d \u9898\uff1a%s" % (idx, p.get("title", ""))), styles["ptitle"]))
        story.append(Paragraph(_md_inline("\u65f6\u95f4\u9650\u5236 %s ms\u3000\u5185\u5b58\u9650\u5236 %s MB" % (p.get("timeMs", ""), p.get("memMb", ""))), styles["meta"]))
        story.append(Spacer(1, 2 * mm))
        story.extend(_md_to_flowables(p.get("description", ""), styles))
        si = (p.get("sampleIn") or "").strip()
        so = (p.get("sampleOut") or "").strip()
        if si:
            story.append(Paragraph("\u6837\u4f8b\u8f93\u5165", styles["h3"]))
            story.append(Preformatted(si, styles["sample"]))
        if so:
            story.append(Paragraph("\u6837\u4f8b\u8f93\u51fa", styles["h3"]))
            story.append(Preformatted(so, styles["sample"]))
    doc.build(story)
    return buf.getvalue()

def _mq_consume_results():
    while True:
        try:
            conn = pika.BlockingConnection(pika.ConnectionParameters(MQ_HOST, MQ_PORT))
            ch = conn.channel()
            ch.queue_declare(queue=RESULT_QUEUE, durable=True)
            def on_msg(ch, method, props, body):
                try:
                    r = json.loads(body)
                    tid = r.get("task_id", "")
                    if tid:
                        existing = _task_meta.get(tid, {})
                        if True:
                            # Merge with persistent task meta (username, problem)
                            print('[api] DEBUG mq_result: tid=' + str(tid) + ' status=' + str(r.get('status')) + ' username=' + str(r.get('username')), flush=True)
                            for k, v in existing.items():
                                if k not in r or r.get(k) in (None, ""):
                                    r[k] = v
                            # Trigger AI encouragement on final result
                            status = r.get("status", "")
                            if status and status not in ("judging", "pending"):
                                try:
                                    username = r.get("username", "")
                                    problem = r.get("problem", "未知题目")
                                    if username:
                                        ai_body = json.dumps({"username": username, "problem": problem, "status": status}).encode()
                                        ai_req = Request("http://127.0.0.1:18082/api/ai/judge_event", data=ai_body, headers={"Content-Type": "application/json"})
                                        ai_resp = urlopen(ai_req, timeout=10)
                                        ai_data = json.loads(ai_resp.read().decode())
                                        if "reply" in ai_data:
                                            r["ai_message"] = {"reply": ai_data["reply"], "status": status}
                                except Exception as e:
                                    print(f'[api] AI trigger failed: {e}', flush=True)
                            # 竞赛提交：写入数据库（与客户端逻辑一致，维护榜单）
                            try:
                                if status and status not in ("judging", "pending"):
                                    cid = existing.get("contest_id", 0)
                                    tk = existing.get("token", "")
                                    if cid and tk:
                                        detail = (r.get("error") or r.get("stderr") or "")[:200]
                                        time_ms = int(r.get("cpu_ns", 0) / 1e6) if r.get("cpu_ns") else 0
                                        sb = json.dumps({"problemId": r.get("problem_id", 0), "contestId": cid,
                                                         "verdict": status, "detail": detail, "timeMs": time_ms}).encode()
                                        sreq = Request(MIDDLEWARE_URL + "/api/submit", data=sb, method="POST",
                                                       headers={"Content-Type": "application/json"})
                                        sreq.add_header("Authorization", f"Bearer {tk}")
                                        sresp = json.loads(urlopen(sreq, context=_ssl_ctx, timeout=10).read().decode())
                                        print(f'[api] contest submit recorded cid={cid} verdict={status} sid={sresp.get("sid")}', flush=True)
                            except Exception as e:
                                print(f'[api] contest submit record failed: {e}', flush=True)
                            if status in ("judging", "pending") and r.get("progress") is not None:
                                # 进度事件：实时落库当前测试点结果（力扣式逐点显示），同时推送给前端
                                if r.get("point_idx") is not None and r.get("point_status"):
                                    _db_judge_run_point(tid, int(r.get("point_idx") or 0),
                                                        str(r.get("point_status") or ""),
                                                        int((r.get("cpu_us") or 0) / 1000))
                                with _results_lock:
                                    _results.setdefault(tid, []).append(r)
                                    _results_ts[tid] = time.time()
                                return
                            _lsm_rec = None
                            try:
                                import lsm_store as _lsm
                                _lsm_rec = _lsm.save_from_result(r, existing)
                            except Exception as _le:
                                print(f'[api] lsm save failed: {_le}', flush=True)
                            # 判题最终结果事务化落库：先写测试详情，最后回写提交记录
                            try:
                                if status and status not in ("judging", "pending"):
                                    _sid = existing.get("submit_id", 0)
                                    _err = (r.get("error") or "")[:2000]
                                    _db_finalize_judge(_sid, tid, r.get("problem_id", 0), status,
                                                       r.get("ac_count", 0), r.get("total_cases", 0),
                                                       r.get("cpu_ms", 0), r.get("mem_mb", 0), _err,
                                                       r.get("cases") or [])
                                    # 上传对象存储（key=hash(源码标识+用户名)，value=测试详情）并登记唯一提交编号
                                    try:
                                        _scode = _db_get_code(tid)
                                        _skey = existing.get("store_key") or _make_store_key(r.get("username", "") or existing.get("username", ""), _scode)
                                        _payload = {"code": _scode, "language": existing.get("language", ""),
                                                    "verdict": status, "ac_count": r.get("ac_count", 0),
                                                    "total_cases": r.get("total_cases", 0),
                                                    "cpu_ms": r.get("cpu_ms", 0), "mem_mb": r.get("mem_mb", 0),
                                                    "error": _err, "cases": r.get("cases") or []}
                                        if _obj_put_submission(_skey, _payload):
                                            _sno = _db_register_submission(_skey, tid,
                                                                           r.get("username", "") or existing.get("username", ""),
                                                                           r.get("problem_id", 0), status,
                                                                           _OBJ_URI_BASE + _skey)
                                            r["submission_no"] = _sno
                                            r["store_key"] = _skey
                                            print(f"[api] submission stored no={_sno} key={_skey[:12]} verdict={status}", flush=True)
                                        else:
                                            print(f"[api] obj store put failed key={_skey[:12]}", flush=True)
                                    except Exception as _ose:
                                        print(f"[api] obj store persist failed: {_ose}", flush=True)
                            except Exception as _dbe:
                                print(f'[api] db judge persist failed: {_dbe}', flush=True)
                            # The first accepted submission of a user on a problem is
                            # mirrored into the DOMjudge database so it reaches the
                            # scoreboard; every other verdict stays in the LSM store.
                            # DOMjudge MySQL 同步已移除：10.255.1.2:3306 不可达，
                            # 首次 AC 仅保留在 LSM store 中，不再写入外部数据库。
                            r.pop("token", None)
                            r.pop("contest_id", None)
                            with _results_lock:
                                _results.setdefault(tid, []).append(r)
                                _results_ts[tid] = time.time()
                except Exception:
                    pass
                finally:
                    ch.basic_ack(delivery_tag=method.delivery_tag)
            ch.basic_consume(queue=RESULT_QUEUE, on_message_callback=on_msg)
            print("[api] result consumer connected", flush=True)
            ch.start_consuming()
        except Exception as e:
            print(f"[api] result consumer error: {e}, retrying...", flush=True)
            time.sleep(3)

ANIME_TUNNEL = "http://127.0.0.1:18091"

def _tunnel_get(path):
    """GET 经 SSH 隧道访问动漫智能体服务。"""
    resp = urlopen(ANIME_TUNNEL + path, timeout=15)
    return resp.read().decode("utf-8")

def _tunnel_post(path, body, timeout=300):
    """POST 经 SSH 隧道访问动漫智能体服务。"""
    req = Request(ANIME_TUNNEL + path, data=body.encode("utf-8"), method="POST")
    req.add_header("Content-Type", "application/json")
    resp = urlopen(req, timeout=timeout)
    return resp.read().decode("utf-8")

def _proxy_get(path, token=None):
    url = MIDDLEWARE_URL + path
    req = Request(url, method="GET")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        resp = urlopen(req, context=_ssl_ctx, timeout=10)
        return resp.read().decode("utf-8")
    except HTTPError as e:
        return e.read().decode("utf-8")

def _proxy_post(path, body):
    from urllib.request import Request
    url = MIDDLEWARE_URL + path
    req = Request(url, data=body.encode("utf-8"), method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        resp = urlopen(req, context=_ssl_ctx, timeout=10)
        return resp.read().decode("utf-8")
    except HTTPError as e:
        return e.read().decode("utf-8")

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"[api] {fmt % args}", flush=True)

    def _send_json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        if parsed.path == "/api/judge_status_list":
            # 某道题的提交记录列表（需登录）。
            # 权限：admin/author 可看该题所有人；普通 user 仅能看自己的提交。
            # SQL 走 submit.idx_problem 索引，按提交时间倒序。
            try:
                problem_id = qs.get("problem_id", [""])[0]
                if not problem_id:
                    self._send_json(400, {"error": "problem_id required"})
                    return
                try:
                    problem_id = int(problem_id)
                except ValueError:
                    self._send_json(400, {"error": "invalid problem_id"})
                    return
                limit = int(qs.get("limit", ["50"])[0])
                limit = max(1, min(limit, 200))

                # 鉴权：必须登录
                token = self.headers.get("Authorization", "")
                if token.startswith("Bearer "):
                    token = token[7:]
                if not token:
                    self._send_json(401, {"error": "需登录后查看提交记录"})
                    return
                # 用 whoami 拿当前用户角色
                role = "user"
                cur_user = ""
                try:
                    wraw = _proxy_get("/api/whoami", token=token)
                    w = json.loads(wraw)
                    if not w.get("ok", True) or not w.get("username"):
                        self._send_json(401, {"error": "登录已失效"})
                        return
                    role = w.get("role") or "user"
                    cur_user = w.get("username", "")
                except Exception:
                    self._send_json(401, {"error": "登录校验失败"})
                    return

                # 前端可选传 username；仅 admin/author 有权查他人
                username = qs.get("username", [""])[0] or None
                is_privileged = role in ("admin", "author")
                if not is_privileged:
                    # 普通用户强制只看自己，忽略前端传入的 username
                    username = cur_user

                sql = ("SELECT s.id, s.task_id, s.username, s.problem_id, s.problem_name, "
                       "s.language, s.status AS submit_status, s.submit_time, "
                       "j.status AS judge_status, j.ac_count, j.total_cases, j.cpu_ms, j.mem_mb, j.judge_time "
                       "FROM submit s LEFT JOIN judge j ON j.submit_id = s.id "
                       "WHERE s.problem_id=%s")
                args = [problem_id]
                if username:
                    sql += " AND s.username=%s"
                    args.append(username)
                sql += " ORDER BY s.id DESC LIMIT %s"
                args.append(limit)

                with _db_conn() as c:
                    with c.cursor() as cur:
                        cur.execute(sql, args)
                        rows = cur.fetchall()
                        cols = [d[0] for d in cur.description]
                data = []
                for row in rows:
                    item = dict(zip(cols, row))
                    for k in ("submit_time", "judge_time"):
                        if item.get(k) is not None:
                            item[k] = str(item[k])
                    data.append(item)
                self._send_json(200, data)
            except Exception as e:
                self._send_json(500, {"error": str(e)})
        elif parsed.path == "/api/judge_status_detail":
            # 单条判题的测试点明细（judge_run），需登录且仅本人/特权角色可见
            try:
                task_id = qs.get("task_id", [""])[0]
                if not task_id:
                    self._send_json(400, {"error": "task_id required"})
                    return
                # 鉴权
                token = self.headers.get("Authorization", "")
                if token.startswith("Bearer "):
                    token = token[7:]
                if not token:
                    self._send_json(401, {"error": "需登录后查看测试详情"})
                    return
                role = "user"
                cur_user = ""
                try:
                    wraw = _proxy_get("/api/whoami", token=token)
                    w = json.loads(wraw)
                    if not w.get("ok", True) or not w.get("username"):
                        self._send_json(401, {"error": "登录已失效"})
                        return
                    role = w.get("role") or "user"
                    cur_user = w.get("username", "")
                except Exception:
                    self._send_json(401, {"error": "登录校验失败"})
                    return
                # 校验该提交属于当前用户（或特权角色）
                is_privileged = role in ("admin", "author")
                if not is_privileged:
                    with _db_conn() as c:
                        with c.cursor() as cur:
                            cur.execute("SELECT username FROM submit WHERE task_id=%s LIMIT 1", (task_id,))
                            row = cur.fetchone()
                    if not row or row[0] != cur_user:
                        self._send_json(403, {"error": "无权查看他人提交详情"})
                        return
                with _db_conn() as c:
                    with c.cursor() as cur:
                        cur.execute(
                            "SELECT case_index, case_name, status, cpu_ms, error "
                            "FROM judge_run WHERE task_id=%s ORDER BY case_index ASC",
                            (task_id,))
                        rows = cur.fetchall()
                        cols = [d[0] for d in cur.description]
                data = []
                for row in rows:
                    item = dict(zip(cols, row))
                    data.append(item)
                # 判题中：合并内存中的实时进度（标记 running/queued/total，供前端力扣式展示）
                live = None
                with _results_lock:
                    _lst = _results.get(task_id) or []
                    for evt in reversed(_lst):
                        if evt.get("status") == "judging" and evt.get("progress") is not None:
                            live = evt
                            break
                if live is not None:
                    cur_idx = int(live.get("point_idx") or 0) + 1
                    total = int(live.get("total") or 0)
                    done = {int(d.get("case_index") or 0) for d in data}
                    if total > len(data):
                        for i in range(len(data) + 1, total + 1):
                            if i == cur_idx and i not in done:
                                data.append({"case_index": i, "case_name": "#%d" % i,
                                             "status": "running", "cpu_ms": None, "error": ""})
                            else:
                                data.append({"case_index": i, "case_name": "#%d" % i,
                                             "status": "queued", "cpu_ms": None, "error": ""})
                        data.sort(key=lambda x: int(x.get("case_index") or 0))
                    self._send_json(200, {"judging": True, "progress": live.get("progress"),
                                          "total": total, "cases": data})
                else:
                    self._send_json(200, data)
            except Exception as e:
                self._send_json(500, {"error": str(e)})
        elif parsed.path == "/api/submission_detail":
            # 单条提交完整详情：提交元信息（含源码）+ 判题汇总 + 测试点明细
            # 需登录，普通用户只能看自己的源码；admin/author 可看任意人的
            try:
                task_id = qs.get("task_id", [""])[0]
                if not task_id:
                    self._send_json(400, {"error": "task_id required"})
                    return
                # 鉴权
                token = self.headers.get("Authorization", "")
                if token.startswith("Bearer "):
                    token = token[7:]
                if not token:
                    self._send_json(401, {"error": "需登录后查看提交详情"})
                    return
                role = "user"
                cur_user = ""
                try:
                    wraw = _proxy_get("/api/whoami", token=token)
                    w = json.loads(wraw)
                    if not w.get("ok", True) or not w.get("username"):
                        self._send_json(401, {"error": "登录已失效"})
                        return
                    role = w.get("role") or "user"
                    cur_user = w.get("username", "")
                except Exception:
                    self._send_json(401, {"error": "登录校验失败"})
                    return

                is_privileged = role in ("admin", "author")
                # 查提交元信息（含 code）+ judge 汇总
                with _db_conn() as c:
                    with c.cursor() as cur:
                        cur.execute(
                            "SELECT s.id, s.task_id, s.username, s.problem_id, s.problem_name, "
                            "s.language, s.status AS submit_status, s.submit_time, s.code, "
                            "j.status AS judge_status, j.ac_count, j.total_cases, j.cpu_ms, j.mem_mb, j.error "
                            "FROM submit s LEFT JOIN judge j ON j.submit_id = s.id "
                            "WHERE s.task_id=%s LIMIT 1", (task_id,))
                        row = cur.fetchone()
                if not row:
                    self._send_json(404, {"error": "提交不存在"})
                    return
                cols = ["id", "task_id", "username", "problem_id", "problem_name",
                        "language", "submit_status", "submit_time", "code",
                        "judge_status", "ac_count", "total_cases", "cpu_ms", "mem_mb", "error"]
                item = dict(zip(cols, row))
                # 权限：普通用户只能看自己的源码
                if not is_privileged and item.get("username") != cur_user:
                    self._send_json(403, {"error": "无权查看他人提交源码"})
                    return
                # 源码仅本人/特权可见（已是权限过滤结果，保留）
                for k in ("submit_time",):
                    if item.get(k) is not None:
                        item[k] = str(item[k])
                # 查测试点明细
                with _db_conn() as c:
                    with c.cursor() as cur:
                        cur.execute(
                            "SELECT case_index, case_name, status, cpu_ms, error "
                            "FROM judge_run WHERE task_id=%s ORDER BY case_index ASC",
                            (task_id,))
                        crows = cur.fetchall()
                        ccols = [d[0] for d in cur.description]
                item["cases"] = [dict(zip(ccols, cr)) for cr in crows]
                # 补充对象存储登记信息（唯一提交编号 + 存储位置）
                try:
                    _skey = _make_store_key(item.get("username", ""), item.get("code") or "")
                    _reg = _db_lookup_submission(_skey)
                    if _reg:
                        item["submission_no"] = _reg.get("submission_no")
                        item["obj_uri"] = _reg.get("obj_uri")
                except Exception:
                    pass
                self._send_json(200, item)
            except Exception as e:
                self._send_json(500, {"error": str(e)})
        elif parsed.path == "/api/cloud_problems":
            # 题目列表来自 txy2 对象存储，不再查询数据库 problems 表
            try:
                public = [p for p in _nav_list_problems() if p.get("isPublic", False)]
                self._send_json(200, public)
            except Exception as e:
                self._send_json(502, {"error": str(e)})
        elif parsed.path == "/api/cloud_problem":
            # 题面只从 txy2 对象存储读取，不再回退数据库
            try:
                pid = qs.get("id", [""])[0]
                if not pid or not pid.isdigit():
                    self._send_json(400, {"error": "id required"})
                    return
                with urlopen(FILER_BASE + "/problems/" + pid + ".json", timeout=10) as _fr:
                    body = _fr.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)
            except HTTPError as _he:
                self._send_json(_he.code, {"error": "problem not found in object storage"})
            except Exception as e:
                self._send_json(502, {"error": str(e)})
        elif parsed.path == "/api/cloud_whoami":
            try:
                token = self.headers.get("Authorization", "")
                if token.startswith("Bearer "):
                    token = token[7:]
                raw = _proxy_get(f"/api/whoami?token={token}")
                body = raw.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                self._send_json(401, {"error": str(e)})
        elif parsed.path == "/api/cloud_judge_result":
            task_id = qs.get("task_id", [""])[0]
            if not task_id:
                self._send_json(400, {"error": "task_id required"})
                return
            now = time.time()
            with _results_lock:
                _lst = _results.get(task_id) or []
                evt = _lst[-1] if _lst else None
                stale = [k for k, t in _results_ts.items() if now - t > 600]
                for k in stale:
                    _results.pop(k, None)
                    _results_ts.pop(k, None)
            if evt is None:
                self._send_json(200, {"task_id": task_id, "status": "pending", "phase": "queued"})
            else:
                result = dict(evt)
                self._send_json(200, result)
        elif parsed.path == "/api/cloud_contests":
            try:
                self._send_json(200, [_contest_summary(c) for c in _fetch_contests()])
            except Exception as e:
                self._send_json(502, {"error": str(e)})
        elif parsed.path == "/api/cloud_contest":
            try:
                cid = qs.get("id", [""])[0]
                if not cid:
                    self._send_json(400, {"error": "id required"})
                    return
                target = None
                for c in _fetch_contests():
                    if str(c.get("id")) == str(cid):
                        target = c
                        break
                if target is None:
                    self._send_json(404, {"error": "contest not found"})
                    return
                summary = _contest_summary(target)
                pmap = {str(p.get("id")): p for p in _nav_list_problems()}
                probs = []
                for pid in summary["problems"]:
                    p = pmap.get(str(pid))
                    if p:
                        probs.append({"id": p.get("id"), "title": p.get("title", ""),
                                      "timeMs": p.get("timeMs"), "memMb": p.get("memMb")})
                    else:
                        probs.append({"id": pid, "title": "\u9898\u76ee %s" % pid,
                                      "timeMs": None, "memMb": None})
                summary["problemList"] = probs
                summary["serverTs"] = time.time()
                self._send_json(200, summary)
            except Exception as e:
                self._send_json(502, {"error": str(e)})
        elif parsed.path == "/api/cloud_contest_pdf":
            try:
                cid = qs.get("id", [""])[0]
                if not cid:
                    self._send_json(400, {"error": "id required"})
                    return
                target = None
                for c in _fetch_contests():
                    if str(c.get("id")) == str(cid):
                        target = c
                        break
                if target is None:
                    self._send_json(404, {"error": "contest not found"})
                    return
                probs = []
                for pid in target.get("problems", []):
                    try:
                        _cpid = _filer_get_problem(pid)
                        if not _cpid:
                            raise RuntimeError("problem not in object storage")
                        probs.append(_cpid)
                    except Exception:
                        probs.append({"id": pid, "title": "\u9898\u76ee %s" % pid, "description": ""})
                pdf = _build_contest_pdf(target, probs)
                self.send_response(200)
                self.send_header("Content-Type", "application/pdf")
                self.send_header("Content-Disposition", "attachment; filename=contest_%s.pdf" % cid)
                self.send_header("Content-Length", str(len(pdf)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(pdf)
            except Exception as e:
                self._send_json(500, {"error": str(e)})
        elif parsed.path == "/api/anime/status":
            try:
                raw = _tunnel_get("/api/anime/status")
                body = raw.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                self._send_json(502, {"error": str(e)})
        elif parsed.path == "/api/cloud_contest_board":
            try:
                cid = qs.get("cid", [""])[0]
                if not cid:
                    self._send_json(400, {"error": "cid required"})
                    return
                raw = _proxy_get(f"/api/board/realtime?cid={cid}")
                body = raw.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                self._send_json(502, {"error": str(e)})
        elif parsed.path == "/api/hot_problems":
            try:
                limit = int(qs.get("limit", ["10"])[0])
                r = _redis.Redis(host="127.0.0.1", port=6382, password=os.environ.get("HOT_REDIS_PASSWORD", ""), decode_responses=True)
                items = r.zrevrange("hot:problems", 0, limit - 1, withscores=True)
                if not items:
                    self._send_json(200, [])
                    return
                # 题名来自 DB 导航表
                title_map = {}
                for _p in _nav_list_problems():
                    try:
                        title_map[int(_p.get("id"))] = _p.get("title", "")
                    except Exception:
                        pass
                result = []
                for pid, score in items:
                    result.append({
                        "id": int(pid),
                        "title": title_map.get(int(pid), ""),
                        "hot_score": int(score)
                    })
                self._send_json(200, result)
            except Exception as e:
                self._send_json(500, {"error": str(e)})

    def do_POST(self):
        if self.path == "/api/cloud_login":
            try:
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length).decode("utf-8")
                raw = _proxy_post("/api/login", body)
                resp_body = raw.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(resp_body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(resp_body)
                # Auto-create virtual human account on successful login
                try:
                    login_data = json.loads(raw)
                    if login_data.get("ok") or "token" in login_data:
                        req_body = json.loads(body)
                        username = req_body.get("username", "")
                        if username:
                            threading.Thread(target=_trigger_vh_init, args=(username,), daemon=True).start()
                except Exception:
                    pass
            except Exception as e:
                self._send_json(401, {"error": str(e)})
        elif self.path == "/api/cloud_register":
            try:
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length).decode("utf-8")
                raw = _proxy_post("/api/register", body)
                resp_body = raw.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(resp_body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(resp_body)
                # Auto-create virtual human account on successful register
                try:
                    reg_data = json.loads(raw)
                    if reg_data.get("ok") or "token" in reg_data:
                        req_body = json.loads(body)
                        username = req_body.get("username", "")
                        if username:
                            threading.Thread(target=_trigger_vh_init, args=(username,), daemon=True).start()
                except Exception:
                    pass
            except Exception as e:
                self._send_json(400, {"error": str(e)})
        elif self.path == "/api/cloud_judge":
            try:
                # Token validation
                token = self.headers.get("Authorization", "")
                if token.startswith("Bearer "):
                    token = token[7:]
                if not token:
                    self._send_json(401, {"error": "missing token, please login first"})
                    return
                # Verify token via middleware whoami
                try:
                    whoami_check = _proxy_get("/api/whoami", token=token)
                    whoami_check_data = json.loads(whoami_check)
                    if not whoami_check_data.get("ok", True):
                        self._send_json(401, {"error": "invalid or expired token"})
                        return
                except Exception:
                    self._send_json(401, {"error": "invalid or expired token"})
                    return
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length).decode("utf-8")
                req = json.loads(body)
                code = req.get("code", "")
                lang = req.get("language", "cpp").lower()
                problem_id = req.get("problemId", 0)
                contest_id = req.get("contestId", 0)
                if not code or not problem_id:
                    self._send_json(400, {"error": "code and problemId required"})
                    return
                _nav = _nav_get_problem(problem_id)
                if _nav:
                    pdata = _nav
                    cpu_ms = _nav.get("timeMs", 1000)
                    mem_mb = _nav.get("memMb", 256)
                else:
                    pdata = _filer_get_problem(problem_id)
                    cpu_ms = pdata.get("timeMs", 1000) or 1000
                    mem_mb = pdata.get("memMb", 256) or 256
                task_id = f"web_{uuid.uuid4().hex[:12]}"
                task = {
                    "task_id": task_id,
                    "code": code,
                    "language": lang,
                    "stdin": "",
                    "expected_output": "",
                    "cpu_limit_ms": cpu_ms,
                    "mem_limit_bytes": mem_mb * 1024 * 1024,
                    "problem_id": problem_id,
                    "contest_id": contest_id,
                }
                # Pre-store username and problem info for AI encouragement
                try:
                    whoami_raw = _proxy_get("/api/whoami", token=token)
                    whoami = json.loads(whoami_raw)
                    username = whoami.get("username", "")
                    print(f"[api] DEBUG whoami username={username}", flush=True)
                except Exception:
                    username = ""
                try:
                    problem_name = pdata.get("title", f"题目{problem_id}")
                except Exception:
                    problem_name = f"题目{problem_id}"
                task["username"] = username
                # 重复提交检测：key = hash(源码标识 + 用户名)，已登记且已判终即视为重复提交相同代码
                _store_key = _make_store_key(username, code)
                _dup = _db_lookup_submission(_store_key)
                if _dup and _dup.get("verdict"):
                    print(f"[api] duplicate submission rejected key={_store_key[:12]} user={username}", flush=True)
                    self._send_json(409, {"error": "不能重复提交相同的代码",
                                          "duplicate": True, "submission_no": _dup.get("submission_no")})
                    return
                # 写入 submit 表（提交记录，含源码）
                try:
                    _submit_id = _db_submit(task_id, username, problem_id, problem_name, contest_id, lang, code)
                except Exception:
                    _submit_id = 0
                with _results_lock:
                    _task_meta[task_id] = {"username": username, "problem": problem_name, "problem_id": problem_id, "contest_id": contest_id, "language": lang, "submit_id": _submit_id, "token": token, "store_key": _store_key, "submittime": int(time.time())}
                    _results[task_id] = [{"status": "pending", "username": username, "problem": problem_name}]
                    _results_ts[task_id] = time.time()
                conn = pika.BlockingConnection(pika.ConnectionParameters(MQ_HOST, MQ_PORT))
                ch = conn.channel()
                ch.queue_declare(queue=TASK_QUEUE, durable=True)
                ch.basic_publish(exchange="", routing_key=TASK_QUEUE,
                                 body=json.dumps(task),
                                 properties=pika.BasicProperties(delivery_mode=2))
                conn.close()
                print(f"[api] published {task_id} problem={problem_id}", flush=True)
                # Return immediately; client uses SSE to receive result
                self._send_json(200, {"task_id": task_id, "status": "pending"})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
        elif self.path == "/api/anime/toggle":
            try:
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length).decode("utf-8") if length else "{}"
                raw = _tunnel_post("/api/anime/toggle", body, timeout=15)
                out = raw.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(out)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(out)
            except Exception as e:
                self._send_json(502, {"error": str(e)})
        elif self.path == "/api/anime/generate":
            try:
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length).decode("utf-8") if length else "{}"
                try:
                    raw = _tunnel_post("/api/anime/generate", body, timeout=300)
                except HTTPError as he:
                    raw = he.read().decode("utf-8")
                out = raw.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(out)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(out)
            except Exception as e:
                self._send_json(502, {"error": str(e)})
        elif self.path == "/api/cloud_contest_register":
            try:
                token = self.headers.get("Authorization", "")
                if token.startswith("Bearer "):
                    token = token[7:]
                if not token:
                    self._send_json(401, {"error": "missing token"})
                    return
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length).decode("utf-8")
                req = json.loads(body)
                contest_id = req.get("contestId", 0)
                if not contest_id:
                    self._send_json(400, {"error": "contestId required"})
                    return
                sb = json.dumps({"contestId": contest_id, "virtual": False}).encode()
                sreq = Request(MIDDLEWARE_URL + "/api/contest/register", data=sb, method="POST",
                               headers={"Content-Type": "application/json"})
                sreq.add_header("Authorization", f"Bearer {token}")
                sresp = json.loads(urlopen(sreq, context=_ssl_ctx, timeout=10).read().decode())
                self._send_json(200, sresp)
            except Exception as e:
                self._send_json(500, {"error": str(e)})
        elif self.path == "/api/cloud_contest_data_prepare":
            try:
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length).decode("utf-8")
                req = json.loads(body)
                contest_id = req.get("contestId", 0)
                if not contest_id:
                    self._send_json(400, {"error": "contestId required"})
                    return
                conn = pika.BlockingConnection(pika.ConnectionParameters(MQ_HOST, MQ_PORT))
                ch = conn.channel()
                ch.queue_declare(queue=TASK_QUEUE, durable=True)
                ch.basic_publish(exchange="", routing_key=TASK_QUEUE,
                                 body=json.dumps({"type": "contest_data_prepare", "contest_id": str(contest_id)}),
                                 properties=pika.BasicProperties(delivery_mode=2))
                conn.close()
                print(f"[api] contest_data_prepare sent cid={contest_id}", flush=True)
                self._send_json(200, {"sent": True})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
        elif self.path == "/api/cloud_contest_data_cleanup":
            try:
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length).decode("utf-8")
                req = json.loads(body)
                contest_id = req.get("contestId", 0)
                if not contest_id:
                    self._send_json(400, {"error": "contestId required"})
                    return
                conn = pika.BlockingConnection(pika.ConnectionParameters(MQ_HOST, MQ_PORT))
                ch = conn.channel()
                ch.queue_declare(queue=TASK_QUEUE, durable=True)
                ch.basic_publish(exchange="", routing_key=TASK_QUEUE,
                                 body=json.dumps({"type": "contest_data_cleanup", "contest_id": str(contest_id)}),
                                 properties=pika.BasicProperties(delivery_mode=2))
                conn.close()
                print(f"[api] contest_data_cleanup sent cid={contest_id}", flush=True)
                try:
                    _proxy_post("/api/board/persist", json.dumps({"contestId": contest_id}))
                    print(f"[api] contest board persisted cid={contest_id}", flush=True)
                except Exception as pe:
                    print(f"[api] board persist failed: {pe}", flush=True)
                self._send_json(200, {"sent": True})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
        else:
            self._send_json(404, {"error": "not found"})

if __name__ == "__main__":
    t = threading.Thread(target=_mq_consume_results, daemon=True)
    t.start()
    class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
        daemon_threads = True
    servers = [
        ThreadingHTTPServer(("127.0.0.1", LISTEN_PORT), Handler),
    ]
    print(f"[api] listening on 127.0.0.1:{LISTEN_PORT}", flush=True)
    servers[0].serve_forever()

