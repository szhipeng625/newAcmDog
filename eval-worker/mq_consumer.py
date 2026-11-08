#!/usr/bin/env python3
"""
ACMDOG Cloud Judge - RabbitMQ Consumer

Consumes judging tasks from 'oj.judge', compiles the submission, runs it inside
the eval_worker sandbox, and publishes the verdict to 'oj.judge.result'.
Messages that cannot be processed are routed to 'oj.judge.dead' via a
dead-letter exchange, together with the reason they were rejected.
"""
import json
import os
import queue
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import uuid

import pika

EVAL_WORKER = "/home/admin/eval-worker/build/eval_worker"
MQ_HOST = "127.0.0.1"
MQ_PORT = 5672
TASK_QUEUE = "oj.judge"
RESULT_QUEUE = "oj.judge.result"
DEAD_QUEUE = "oj.judge.dead"
DLX_EXCHANGE = "oj.judge.dlx"

# Heartbeat is kept in the loop by the main thread; the judge runs on a worker
# thread so a 30s compile + 60s sandbox run can never starve the connection.
HEARTBEAT = 30
POLL_INTERVAL = 0.2

CPU_MS_MIN, CPU_MS_MAX = 100, 10000
MEM_BYTES_MIN, MEM_BYTES_MAX = 16 * 1024 * 1024, 512 * 1024 * 1024

# 运行时自身的启动开销不该算进题目时限：JVM 光启动+类加载就要 150~400ms CPU，
# 若直接计入，1s 的题 Java 只剩 600ms 可用。这里用"固定补贴"而非按倍数放大，
# 避免长时限题目被放得过松（10s 的题乘 3 会变成 30s）。
CPU_STARTUP_MS = {
    "java": 300,
    "python": 60,
    "go": 20,
}
MAX_CODE_BYTES = 256 * 1024
MAX_STREAM_BYTES = 8 * 1024 * 1024
MAX_ERR_BYTES = 4096
GO_CACHE_DIR = "/tmp/.judge-gocache"

# task_id is used as a path component, so it must never contain separators.
TASK_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _which(name, fallback):
    """Resolve the toolchain binary; the sandbox execs this exact path."""
    return shutil.which(name) or fallback


PYTHON_BIN = _which("python3", "/usr/bin/python3")
JAVA_BIN = _which("java", "/usr/bin/java")
JAVAC_BIN = _which("javac", "/usr/bin/javac")
GO_BIN = _which("go", "/usr/local/go/bin/go")

# 只编译不落盘，避免生成 __pycache__（nobody 也写不进题目目录）
_PY_SYNTAX_CHECK = (
    "src = open('main.py', 'rb').read().decode('utf-8-sig'); "
    "compile(src, 'main.py', 'exec')"
)

# src: 源文件名 / build: 构建或预检命令（None 表示无需构建）
# run_kind: native 直接跑构建产物；python/java 由解释器拉起
# pids: 该语言需要的进程/线程配额（JVM 要开 GC、JIT、编译线程）
LANG_SPECS = {
    "c": dict(src="main.c",
              build=["gcc", "-O2", "-std=c17", "-o", "user_bin", "main.c", "-lm"],
              run_kind="native", build_timeout=30, pids=32),
    "cpp": dict(src="main.cpp",
                build=["g++", "-O2", "-std=c++17", "-o", "user_bin", "main.cpp", "-lm"],
                run_kind="native", build_timeout=30, pids=32),
    "cc": dict(src="main.cpp",
               build=["g++", "-O2", "-std=c++17", "-o", "user_bin", "main.cpp", "-lm"],
               run_kind="native", build_timeout=30, pids=32),
    "python": dict(src="main.py",
                   build=[PYTHON_BIN, "-c", _PY_SYNTAX_CHECK],
                   run_kind="python", build_timeout=15, pids=16),
    "java": dict(src="Main.java",
                 build=[JAVAC_BIN, "-encoding", "UTF-8", "-d", ".", "Main.java"],
                 run_kind="java", build_timeout=60, pids=96),
    "go": dict(src="main.go",
               build=[GO_BIN, "build", "-trimpath", "-o", "user_bin", "main.go"],
               run_kind="native", build_timeout=120, pids=32),
}

LANG_ALIASES = {"py": "python", "python3": "python", "python2": "python",
                "c++": "cpp", "golang": "go"}

running = True
_work = queue.Queue()   # (body_bytes, delivery_tag)
_done = queue.Queue()   # (delivery_tag, result, fatal_reason, exception)


def _stop(signum, frame):
    global running
    if running:
        print("[consumer] signal %d received, shutting down..." % signum)
    running = False


signal.signal(signal.SIGINT, _stop)
signal.signal(signal.SIGTERM, _stop)


def _result(task_id, status, error=None, **extra):
    payload = {"task_id": task_id, "status": status}
    if error:
        payload["error"] = error
    payload.update(extra)
    return payload


def _decode(raw, limit=MAX_ERR_BYTES):
    return raw.decode("utf-8", errors="replace").strip()[:limit]


def _as_int(value, default, low, high):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(number, high))


def _kill_process_group(proc):
    """Kill the whole session so compiler children (cc1plus) cannot survive."""
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.kill()
        except OSError:
            pass


def _run_child(cmd, timeout, cwd=None, stdin_bytes=None, env=None):
    """Run a child process and collect its output.

    Output goes to temporary files instead of pipes so a chatty program cannot
    fill the pipe buffer and deadlock. The child gets its own session, which
    lets a timeout kill the entire process group.
    """
    with tempfile.TemporaryFile() as f_out, tempfile.TemporaryFile() as f_err:
        f_in = None
        try:
            if stdin_bytes is not None:
                f_in = tempfile.TemporaryFile()
                f_in.write(stdin_bytes)
                f_in.seek(0)

            proc = subprocess.Popen(
                cmd,
                cwd=cwd,
                stdin=f_in if f_in is not None else subprocess.DEVNULL,
                stdout=f_out,
                stderr=f_err,
                start_new_session=True,
                env=env,
            )

            deadline = time.monotonic() + timeout
            timed_out = False
            while proc.poll() is None:
                if time.monotonic() >= deadline:
                    timed_out = True
                    _kill_process_group(proc)
                    break
                time.sleep(POLL_INTERVAL)
            rc = proc.wait()
        finally:
            if f_in is not None:
                f_in.close()

        f_out.seek(0)
        f_err.seek(0)
        return rc, f_out.read(), f_err.read(), timed_out


def normalize_lang(lang):
    lang = (lang or "").strip().lower()
    return LANG_ALIASES.get(lang, lang)


def build_run_spec(spec, work_dir, mem_bytes):
    """决定沙箱最终 execv 的目标与参数：返回 (user_binary, args, max_pids)。"""
    kind = spec["run_kind"]
    if kind == "native":
        return os.path.join(work_dir, "user_bin"), [], spec["pids"]

    if kind == "python":
        # -B 不写 __pycache__，-u 不缓冲输出（被 SIGKILL 时已打印的内容不丢）
        return PYTHON_BIN, ["-B", "-u", os.path.join(work_dir, spec["src"])], spec["pids"]

    # java：堆给内存上限的一半，其余留给 metaspace / code cache / 线程栈
    heap_mb = max(32, int(mem_bytes * 0.5) // (1024 * 1024))
    return JAVA_BIN, [
        "-XX:-UsePerfData",            # 不往 /tmp 写 hsperfdata 文件
        "-XX:+UseSerialGC",            # 单线程 GC，线程数最少
        "-XX:ActiveProcessorCount=2",  # 不按宿主核数创建 GC/JIT 线程
        "-Dfile.encoding=UTF-8",
        "-Xmx%dm" % heap_mb,
        "-cp", work_dir,
        "Main",
    ], spec["pids"]


def compile_code(code, lang, work_dir):
    """构建或预检，返回 (spec, error)。"""
    spec = LANG_SPECS[lang]

    with open(os.path.join(work_dir, spec["src"]), "w",
              encoding="utf-8", errors="replace") as handle:
        handle.write(code)

    env = None
    if lang == "go":
        # Go 必须有可写 GOCACHE；放固定目录，后续任务能复用已编译的标准库
        os.makedirs(GO_CACHE_DIR, exist_ok=True)
        env = dict(os.environ)
        env.update({
            "GOCACHE": GO_CACHE_DIR,
            "GOPATH": os.path.join(GO_CACHE_DIR, "gopath"),
            "CGO_ENABLED": "0",
            "HOME": env.get("HOME") or "/tmp",
        })

    try:
        rc, _out, err, timed_out = _run_child(
            spec["build"], spec["build_timeout"], cwd=work_dir, env=env)
    except OSError as exc:
        return None, "failed to start toolchain: %s" % exc

    if timed_out:
        return None, "Compilation timed out (%ds)" % spec["build_timeout"]
    if rc != 0:
        return None, _decode(err) or "toolchain exited with code %d" % rc

    if spec["run_kind"] == "native":
        if not os.path.isfile(os.path.join(work_dir, "user_bin")):
            return None, "build reported success but produced no binary"
    elif spec["run_kind"] == "java":
        # 有 package 声明时 class 会落到子目录，这里要求单文件 Main 类
        if not os.path.isfile(os.path.join(work_dir, "Main.class")):
            return None, "编译未生成 Main.class：类名必须是 Main，且不要使用 package 声明"
    return spec, None


def run_sandbox(task_id, binary, args, problem_data, stdin_file, expected_file,
                cpu_ms, mem_bytes, max_pids, checker):
    payload = json.dumps({
        "task_id": task_id,
        "user_binary": binary,
        "args": args,
        "problem_data": problem_data or "",   # 沙箱 chdir 目标，解释型语言靠它定位脚本
        "stdin_file": stdin_file or "",
        "expected_output_file": expected_file or "",
        "cpu_limit_ms": cpu_ms,
        "mem_limit_bytes": mem_bytes,
        "max_pids": max_pids,
        "checker": checker,
    }, ensure_ascii=False)

    # Give the sandbox the CPU budget plus startup/shutdown slack, capped so a
    # wedged worker cannot hold the single prefetch slot forever.
    timeout = min(120, max(30, cpu_ms // 1000 + 30))

    try:
        rc, out, err, timed_out = _run_child(
            [EVAL_WORKER], timeout, stdin_bytes=(payload + "\n").encode("utf-8"))
    except OSError as exc:
        return _result(task_id, "SE", "failed to start eval_worker: %s" % exc)

    if timed_out:
        return _result(task_id, "SE",
                       "eval_worker did not exit within %ds" % timeout)

    for line in out.decode("utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue

    detail = _decode(err) or "eval_worker exited with code %d, no JSON output" % rc
    return _result(task_id, "SE", detail)


def process_task(body):
    """Judge one task.

    Returns (result, fatal): 'fatal' is None when the message was understood and
    handled; otherwise it carries the reason the message should also be copied
    to the dead-letter queue.
    """
    try:
        req = json.loads(body)
    except (ValueError, UnicodeDecodeError) as exc:
        task_id = "mq_%s" % uuid.uuid4().hex[:10]
        reason = "malformed payload: %s" % exc
        return _result(task_id, "SE", reason), reason

    if not isinstance(req, dict):
        task_id = "mq_%s" % uuid.uuid4().hex[:10]
        reason = "payload is not a JSON object"
        return _result(task_id, "SE", reason), reason

    requested = str(req.get("task_id") or "")
    if TASK_ID_RE.match(requested):
        task_id = requested
    else:
        # Never let a hostile id reach the filesystem layout.
        task_id = "mq_%s" % uuid.uuid4().hex[:10]

    lang = normalize_lang(str(req.get("language") or "cpp"))
    if lang not in LANG_SPECS:
        return _result(task_id, "CE",
                       "Unsupported language: %s (supported: %s)"
                       % (lang or "?", ", ".join(sorted(LANG_SPECS)))), None

    # diff：比输出；exitcode：SPJ，退出码 0 即通过
    checker = str(req.get("checker") or "diff").strip().lower()
    if checker not in ("diff", "exitcode"):
        checker = "diff"

    code = req.get("code")
    stdin_data = req.get("stdin")
    expected = req.get("expected_output")

    if code is None:
        code = ""
    if stdin_data is None:
        stdin_data = ""
    if expected is None:
        expected = ""

    if not isinstance(code, str):
        return _result(task_id, "SE", "field 'code' must be a string"), None

    code_bytes = len(code.encode("utf-8", errors="replace"))
    if code_bytes > MAX_CODE_BYTES:
        return _result(task_id, "SE",
                       "source code too large: %d bytes > %d" % (code_bytes, MAX_CODE_BYTES)), None

    for name, value in (("stdin", stdin_data), ("expected_output", expected)):
        if not isinstance(value, str):
            return _result(task_id, "SE", "field '%s' must be a string" % name), None
        if len(value.encode("utf-8", errors="replace")) > MAX_STREAM_BYTES:
            return _result(task_id, "SE",
                           "field '%s' exceeds %d bytes" % (name, MAX_STREAM_BYTES)), None

    cpu_ms = _as_int(req.get("cpu_limit_ms"), 1000, CPU_MS_MIN, CPU_MS_MAX)
    # 题目时限只度量用户代码，运行时启动的固定开销单独补贴
    startup_ms = CPU_STARTUP_MS.get(lang, 0)
    budget_ms = cpu_ms + startup_ms
    mem_bytes = _as_int(req.get("mem_limit_bytes"), 268435456,
                        MEM_BYTES_MIN, MEM_BYTES_MAX)

    print("[consumer] task=%s lang=%s cpu=%dms(+%d startup) mem=%d code=%dB"
          % (task_id, lang, cpu_ms, startup_ms, mem_bytes, code_bytes))

    work_dir = os.path.join(tempfile.gettempdir(), "judge_%s" % task_id)
    try:
        os.makedirs(work_dir, exist_ok=True)
    except OSError as exc:
        return _result(task_id, "SE", "cannot create work dir: %s" % exc), None

    try:
        spec, err = compile_code(code, lang, work_dir)
        if err:
            print("[consumer] %s -> CE" % task_id)
            return _result(task_id, "CE", err), None

        stdin_file = ""
        if stdin_data:
            stdin_file = os.path.join(work_dir, "input.txt")
            with open(stdin_file, "w", encoding="utf-8", errors="replace") as handle:
                handle.write(stdin_data)

        expected_file = ""
        if expected:
            # work_dir 是 0755 且属 root：用户程序（nobody）只能读，无法篡改答案
            expected_file = os.path.join(work_dir, "expected.txt")
            with open(expected_file, "w", encoding="utf-8", errors="replace") as handle:
                handle.write(expected)

        binary, run_args, max_pids = build_run_spec(spec, work_dir, mem_bytes)
        result = run_sandbox(task_id, binary, run_args, work_dir,
                             stdin_file, expected_file,
                             budget_ms, mem_bytes, max_pids, checker)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

    print("[consumer] %s -> %s" % (task_id, result.get("status", "?")))
    return result, None


def _judge_worker():
    """Runs on its own thread so the main thread keeps the AMQP heartbeat alive."""
    while True:
        item = _work.get()
        if item is None:
            return
        body, tag = item
        try:
            result, fatal = process_task(body)
            _done.put((tag, result, fatal, None))
        except Exception as exc:
            reason = "internal error: %s" % exc
            _done.put((tag, _result("unknown", "SE", reason), reason, exc))


def _publish(channel, routing_key, payload):
    channel.basic_publish(
        exchange="",
        routing_key=routing_key,
        body=json.dumps(payload, ensure_ascii=False),
        properties=pika.BasicProperties(delivery_mode=2,
                                        content_type="application/json"),
    )


def _safe_nack(channel, tag, requeue):
    try:
        channel.basic_nack(delivery_tag=tag, requeue=requeue)
    except Exception as exc:
        print("[consumer] nack failed (%s); broker will requeue on disconnect" % exc)


def _drain_results(channel):
    """Publish finished verdicts and only then ack the originating message."""
    while True:
        try:
            tag, result, fatal, _exc = _done.get_nowait()
        except queue.Empty:
            return

        try:
            if result is not None:
                _publish(channel, RESULT_QUEUE, result)
            if fatal:
                _publish(channel, DEAD_QUEUE, {
                    "task_id": (result or {}).get("task_id", "unknown"),
                    "reason": fatal,
                    "rejected_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                })
            channel.basic_ack(delivery_tag=tag)
        except pika.exceptions.UnroutableError as exc:
            # The verdict has nowhere to go: keep the task, drop the message.
            print("[consumer] no route for result (%s); dead-lettering task" % exc)
            _safe_nack(channel, tag, requeue=False)
        except Exception as exc:
            print("[consumer] publish/ack failed (%s); requeueing task" % exc)
            _safe_nack(channel, tag, requeue=True)


DLX_ARGUMENTS = {
    "x-dead-letter-exchange": DLX_EXCHANGE,
    "x-dead-letter-routing-key": DEAD_QUEUE,
}


def _queue_depth(conn):
    """探测任务队列的积压条数；探测失败返回 -1。"""
    probe = conn.channel()
    try:
        result = probe.queue_declare(queue=TASK_QUEUE, durable=True, passive=True)
        depth = getattr(result, "message_count", None)
        if depth is None and hasattr(result, "method"):
            depth = getattr(result.method, "message_count", None)
        return -1 if depth is None else int(depth)
    except pika.exceptions.ChannelClosedByBroker:
        return -1
    finally:
        try:
            probe.close()
        except Exception:
            pass


def _declare_queues(conn):
    """声明各队列，返回 (channel, dead_letter_enabled)。

    队列已存在但缺少死信参数时，broker 会回 PRECONDITION_FAILED，而 AMQP 无法
    在线修改队列参数。这里的分支是：空队列直接删掉重建（零丢失），有积压则降级
    成不带死信的声明——绝不为了配置统一而丢弃排队中的任务。
    """
    channel = conn.channel()
    channel.exchange_declare(exchange=DLX_EXCHANGE, exchange_type="direct",
                             durable=True)
    channel.queue_declare(queue=DEAD_QUEUE, durable=True)
    channel.queue_bind(queue=DEAD_QUEUE, exchange=DLX_EXCHANGE,
                       routing_key=DEAD_QUEUE)
    channel.queue_declare(queue=RESULT_QUEUE, durable=True)

    try:
        channel.queue_declare(queue=TASK_QUEUE, durable=True,
                              arguments=DLX_ARGUMENTS)
        return channel, True
    except pika.exceptions.ChannelClosedByBroker as exc:
        if exc.reply_code != 406:
            raise

    # 406 之后 broker 已关闭原 channel，需要重开
    depth = _queue_depth(conn)
    channel = conn.channel()

    if depth == 0:
        print("[consumer] queue '%s' exists without dead-letter args but is empty; "
              "recreating it" % TASK_QUEUE)
        channel.queue_delete(queue=TASK_QUEUE)
        channel.queue_declare(queue=TASK_QUEUE, durable=True,
                              arguments=DLX_ARGUMENTS)
        return channel, True

    print("[consumer] WARN: queue '%s' exists without dead-letter args and holds %s "
          "message(s); declaring it WITHOUT dead-letter routing to avoid data loss. "
          "Failed tasks will not reach '%s'. Delete the queue during a maintenance "
          "window to enable DLX."
          % (TASK_QUEUE, "unknown" if depth < 0 else depth, DEAD_QUEUE))
    channel.queue_declare(queue=TASK_QUEUE, durable=True)
    return channel, False


def main():
    params = pika.ConnectionParameters(
        host=MQ_HOST,
        port=MQ_PORT,
        heartbeat=HEARTBEAT,
        blocked_connection_timeout=300,
    )
    print("[consumer] connecting to %s:%d..." % (MQ_HOST, MQ_PORT))
    conn = pika.BlockingConnection(params)

    channel, dead_letter = _declare_queues(conn)
    if not dead_letter:
        print("[consumer] WARN: dead-letter routing is disabled for this run")
    channel.basic_qos(prefetch_count=1)

    try:
        channel.confirm_delivery()
        print("[consumer] publisher confirms enabled")
    except pika.exceptions.AMQPError as exc:
        print("[consumer] WARN: publisher confirms unavailable: %s" % exc)

    def on_message(ch, method, properties, body):
        # Hand off immediately; acking happens only after the verdict is published.
        _work.put((body, method.delivery_tag))

    worker = threading.Thread(target=_judge_worker, name="judge-worker", daemon=True)
    worker.start()

    channel.basic_consume(queue=TASK_QUEUE, on_message_callback=on_message)
    print("[consumer] listening on '%s', publishing to '%s'"
          % (TASK_QUEUE, RESULT_QUEUE))

    try:
        while running:
            try:
                conn.process_data_events(time_limit=0.5)
            except pika.exceptions.AMQPError as exc:
                print("[consumer] connection error: %s" % exc)
                break
            _drain_results(channel)
    finally:
        _work.put(None)
        worker.join(timeout=5)
        try:
            if conn.is_open:
                conn.close()
        except Exception:
            pass
        print("[consumer] stopped.")


if __name__ == "__main__":
    main()
