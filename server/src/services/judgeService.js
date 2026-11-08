import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { badRequest, conflict, notFound } from "../core/http.js";
import { logger } from "../core/logger.js";
import { cpuBudgetMs, normalizeLang } from "../plugins/sandbox/languages.js";
import { normalizeText } from "../plugins/sandbox/normalize.js";

const log = logger.child("judge");
const MAX_MEM = 512 * 1024 * 1024;
const randomHex = (n) => crypto.randomBytes(n).toString("hex");

/** 与原实现一致：SHA256(username + ":" + SHA256(code)) */
export function makeStoreKey(username, code) {
  const inner = crypto.createHash("sha256").update(String(code), "utf8").digest("hex");
  return crypto.createHash("sha256").update(`${username}:${inner}`, "utf8").digest("hex");
}

export function createJudgeService(app, { problems, resultHub }) {
  const { config, infra, sandbox } = app;
  const { mysql, mq, lsm, middleware } = infra;
  // 收起来的关闭函数（不是 Promise）：start* 是异步建立连接，但关闭必须可同步触发
  const stops = [];

  const status = (taskId, event, meta) => resultHub.push(taskId, { task_id: taskId, ...event }, meta);

  // ---------- 提交 ----------

  async function submit({ code, language, problemId, contestId = 0 }, user) {
    const source = String(code ?? "");
    if (!source.trim()) throw badRequest("代码不能为空");
    if (Buffer.byteLength(source) > config.sandbox.maxCodeBytes) {
      throw badRequest(`源码过大（上限 ${config.sandbox.maxCodeBytes} 字节）`);
    }

    const pid = Number(problemId);
    if (!pid) throw badRequest("problemId 必填");

    const lang = normalizeLang(language || "cpp");
    if (!sandbox.languages.includes(lang)) {
      throw badRequest(`Unsupported language: ${lang} (supported: ${sandbox.languages.join(", ")})`);
    }

    const info = await problems.meta(pid);
    if (!info) throw notFound("题目不存在");

    const taskId = `web_${randomHex(6)}`;
    // 提交入口在 HTTP 上下文里，补上 task_id 后本次请求剩余日志都能关联到这次判题
    logger.setContext({ task_id: taskId });
    const storeKey = makeStoreKey(user.username, source);

    const dup = await mysql.query(
      `SELECT submission_no FROM submission_store
        WHERE store_key = ? AND verdict IS NOT NULL AND verdict <> '' LIMIT 1`,
      [storeKey],
    ).catch(() => []);
    if (dup.length) {
      log.info("duplicate submission rejected", {
        task_id: taskId, username: user.username, problem_id: pid,
      });
      throw conflict("不能重复提交相同的代码", {
        duplicate: true,
        submission_no: dup[0].submission_no,
      });
    }

    const inserted = await mysql.execute(
      `INSERT INTO submit (task_id, username, problem_id, problem_name, contest_id, language, status, code)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [taskId, user.username, pid, info.title, Number(contestId) || 0, lang, source],
    ).catch((err) => {
      log.error("insert submit failed", { task_id: taskId, error: err });
      return null;
    });

    const meta = {
      username: user.username,
      problem: info.title,
      problem_id: pid,
      contest_id: Number(contestId) || 0,
      language: lang,
      submit_id: inserted?.insertId || 0,
      store_key: storeKey,
      submittime: Math.trunc(Date.now() / 1000),
      token: user.token || "",
    };
    resultHub.setMeta(taskId, meta);
    status(taskId, { status: "pending", phase: "queued" }, meta);

    await mq.publishTask({
      task_id: taskId,
      code: source,
      language: lang,
      problem_id: pid,
      contest_id: meta.contest_id,
      username: user.username,
      cpu_limit_ms: Math.min(info.timeMs, config.sandbox.cpuMsMax),
      mem_limit_bytes: Math.min(info.memMb * 1024 * 1024, MAX_MEM),
    });

    log.info("submission accepted", {
      task_id: taskId, username: user.username, problem_id: pid,
      contest_id: meta.contest_id, language: lang,
      cpu_limit_ms: Math.min(info.timeMs, config.sandbox.cpuMsMax),
      queue: config.mq.taskQueue,
    });
    return { task_id: taskId, status: "pending" };
  }

  // ---------- 判题 ----------

  /** 把数据库里的 base64 判题器落成可执行文件。 */
  async function prepareChecker(info, workDir) {
    const decode = async (b64, name) => {
      const bin = path.join(workDir, name);
      await fs.writeFile(bin, Buffer.from(String(b64), "base64"));
      await fs.chmod(bin, 0o755);
      return bin;
    };

    if (info.judgeMode) {
      if (!info.entryExe) return { mode: "diff", warning: "judgeMode 未提供 entry 可执行文件，回落普通判题" };
      return { mode: "entry", binary: await decode(info.entryExe, "entry_bin") };
    }
    if (info.spjExe) {
      return { mode: "spj", binary: await decode(info.spjExe, "spj_bin") };
    }
    return { mode: "diff" };
  }

  function caseEntry(name, result, error = "") {
    return {
      name,
      status: result.status,
      cpu_ms: Math.round((result.cpu_ns || 0) / 1e6),
      error: error || result.error || "",
    };
  }

  /** 执行一个测试点，按 diff / spj / entry 三种模式产出统一结构。 */
  async function runCase({ taskId, name, testcase, prepared, info, checker, budget, memBytes }) {
    const base = {
      task_id: `${taskId}_${name}`,
      stdin_file: testcase.input,
      cpu_limit_ms: budget,
      mem_limit_bytes: memBytes,
      max_pids: prepared.pids,
    };

    if (checker.mode === "diff" || !checker.mode) {
      return sandbox.run({
        ...base,
        binary: prepared.binary,
        args: prepared.args,
        expected_output_file: testcase.expected,
        checker: "diff",
      });
    }

    if (checker.mode === "spj") {
      const userOut = path.join(config.sandbox.workRoot, `spj_${base.task_id}.out`);
      const runUser = await sandbox.run({
        ...base,
        binary: prepared.binary,
        args: prepared.args,
        expected_output_file: "",
        stdout_file: userOut,
        checker: "diff",
      });
      if (runUser.status !== "AC") {
        await fs.rm(userOut, { force: true });
        return runUser;
      }
      const verdict = await sandbox.run({
        task_id: `${base.task_id}_spj`,
        binary: checker.binary,
        args: [userOut, testcase.expected || "", testcase.input],
        stdin_file: "",
        expected_output_file: "",
        cpu_limit_ms: 5000,
        mem_limit_bytes: memBytes,
        max_pids: 32,
        checker: "exitcode",
      });
      await fs.rm(userOut, { force: true });
      return {
        ...runUser,
        status: verdict.status === "AC" ? "AC" : verdict.status === "WA" ? "WA" : "SE",
        cpu_ns: (runUser.cpu_ns || 0) + (verdict.cpu_ns || 0),
        error: verdict.error || "",
      };
    }

    // 函数式判题：entry <user.so> <输入> <输出> <时间>
    const userOut = path.join(config.sandbox.workRoot, `entry_${base.task_id}.out`);
    const timeOut = path.join(config.sandbox.workRoot, `entry_${base.task_id}.time`);
    const run = await sandbox.run({
      task_id: base.task_id,
      binary: checker.binary,
      args: [prepared.binary, testcase.input, userOut, timeOut],
      stdin_file: "",
      expected_output_file: "",
      cpu_limit_ms: budget,
      mem_limit_bytes: memBytes,
      max_pids: 32,
      checker: "diff",
    });

    if (run.status === "AC" && testcase.expected) {
      try {
        const [actual, expected] = await Promise.all([
          fs.readFile(userOut, "utf8"),
          fs.readFile(testcase.expected, "utf8"),
        ]);
        run.status = normalizeText(actual) === normalizeText(expected) ? "AC" : "WA";
      } catch {
        run.status = "WA";
        run.error = "函数式判题未产出输出文件";
      }
    }
    await Promise.allSettled([fs.rm(userOut, { force: true }), fs.rm(timeOut, { force: true })]);
    return run;
  }

  /** 注入 task_id 上下文：逐点日志、落库日志、异常日志全都归属于同一次判题。 */
  async function judgeOne(task) {
    return logger.runWith(
      { task_id: task.task_id, username: task.username || "" },
      () => judgeOneImpl(task),
    );
  }

  async function judgeOneImpl(task) {
    const taskId = task.task_id;
    const pid = Number(task.problem_id);
    const lang = normalizeLang(task.language);
    const workDir = path.join(config.sandbox.workRoot, `judge_${taskId}`);

    try {
      const info = await problems.meta(pid);
      if (!info) return { task_id: taskId, status: "SE", error: "problem not found" };

      const cpuLimit = Math.min(info.timeMs || 1000, config.sandbox.cpuMsMax);
      const memBytes = Math.min((info.memMb || 256) * 1024 * 1024, MAX_MEM);
      const budget = cpuBudgetMs(lang, cpuLimit);

      status(taskId, { status: "judging", phase: "compiling" });
      const prepared = await sandbox.prepare({
        code: task.code, lang, workDir, memBytes,
      });

      const cases = await problems.testData(pid);
      if (!cases.length) {
        return { task_id: taskId, status: "SE", error: "no testcases" };
      }

      const checker = await prepareChecker(info, workDir);
      if (checker.warning) log.warn("checker fallback", { mode: checker.mode, detail: checker.warning });

      status(taskId, {
        status: "judging", phase: "running", total_cases: cases.length,
      });

      const results = [];
      let totalCpu = 0;
      let peakMem = 0;

      for (const testcase of cases) {
        let r;
        try {
          r = await runCase({
            taskId, name: testcase.name, testcase, prepared, info, checker, budget, memBytes,
          });
        } catch (err) {
          r = { status: "SE", error: err.message };
        }
        totalCpu += r.cpu_ns || 0;
        peakMem = Math.max(peakMem, r.mem_bytes || 0);
        results.push(caseEntry(testcase.name, r));
        log.debug("case finished", {
          case_name: testcase.name, status: r.status, cpu_ms: r.cpu_ns ? Math.round(r.cpu_ns / 1e6) : 0,
        });

        status(taskId, {
          status: "judging",
          phase: "running",
          done_cases: results.length,
          total_cases: cases.length,
          ac_count: results.filter((x) => x.status === "AC").length,
        });
      }

      const firstFail = results.find((x) => x.status !== "AC");
      const verdict = {
        task_id: taskId,
        problem_id: pid,
        username: task.username,
        status: firstFail ? firstFail.status : "AC",
        ac_count: results.filter((x) => x.status === "AC").length,
        total_cases: results.length,
        cpu_ns: totalCpu,
        cpu_ms: Math.round(totalCpu / 1e6),
        mem_bytes: peakMem,
        mem_mb: Number((peakMem / 1024 / 1024).toFixed(1)),
        cases: results,
        error: firstFail ? (firstFail.error || defaultError(firstFail.status)) : "",
      };
      log.info("judge finished", {
        status: verdict.status,
        ac_count: verdict.ac_count,
        total_cases: verdict.total_cases,
        cpu_ms: verdict.cpu_ms,
        mem_mb: verdict.mem_mb,
        problem_id: pid,
        language: lang,
      });
      return verdict;
    } catch (err) {
      if (err.isCompileError) {
        log.warn("compilation failed", { language: lang, error: err });
        return { task_id: taskId, problem_id: pid, status: "CE", error: err.message };
      }
      log.error("judge failed", { error: err });
      return { task_id: taskId, problem_id: pid, status: "SE", error: err.message };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  function defaultError(st) {
    return { WA: "输出与标准答案不一致", TLE: "运行超时", MLE: "内存超限", RE: "运行时错误", SE: "系统错误", CE: "编译错误" }[st] || "";
  }

  // ---------- 后台消费 ----------

  function startWorker() {
    return mq.consume(config.mq.taskQueue, async (task) => {
      if (task.type) return; // 竞赛数据准备/清理等控制消息不走判题
      if (!task.code || !task.task_id) {
        log.warn("skip malformed task", { task_id: task.task_id || "", type: task.type || "" });
        return;
      }
      const result = await judgeOne(task);
      await mq.publish(config.mq.resultQueue, result);
    }).then((stopFn) => {
      stops.push(stopFn);
      log.info("worker listening", { queue: config.mq.taskQueue });
      return stopFn;
    }).catch((err) => {
      log.error("worker start failed", { queue: config.mq.taskQueue, error: err });
      return null;
    });
  }

  /** 结果落库：MySQL + LSM + 中间件成绩 + 内存事件。 */
  async function consumeResult(result) {
    const taskId = result.task_id;
    logger.setContext({ task_id: taskId });
    const meta = resultHub.getMeta(taskId) || {};

    if (result.status === "judging" || result.status === "pending") {
      resultHub.push(taskId, result);
      return;
    }

    const merged = {
      ...result,
      username: result.username || meta.username || "",
      problem: meta.problem || "",
      language: meta.language || "",
      contest_id: meta.contest_id || 0,
    };

    // AI 讲评：失败不影响主流程
    if (app.services?.ai) {
      try {
        const ai = await app.services.ai.judgeEvent(merged);
        if (ai) merged.ai_message = ai;
      } catch (err) {
        log.warn("ai event failed", { task_id: taskId, error: err });
      }
    }

    if (merged.contest_id && meta.token) {
      try {
        // 字段名与中间件 /api/submit 的约定一致，别改成 status/username
        await middleware.submitScore({
          problemId: merged.problem_id,
          contestId: merged.contest_id,
          verdict: merged.status,
          detail: String(merged.error || "").slice(0, 200),
          timeMs: merged.cpu_ms || 0,
        }, meta.token);
      } catch (err) {
        log.warn("contest score failed", { task_id: taskId, contest_id: merged.contest_id, error: err });
      }
    }

    try {
      const rec = await lsm.saveFromResult(merged, meta);
      if (rec) merged.submission_no = `sub_${rec.submitid}`;
    } catch (err) {
      log.warn("lsm save failed", { task_id: taskId, error: err });
    }

    try {
      await finalizeDb(merged, meta);
    } catch (err) {
      log.warn("db finalize failed", { task_id: taskId, error: err });
    }

    log.info("result finalized", {
      task_id: taskId,
      status: merged.status,
      username: merged.username,
      problem_id: merged.problem_id,
      ac_count: merged.ac_count || 0,
      total_cases: merged.total_cases || 0,
      submission_no: merged.submission_no || "",
    });
    resultHub.push(taskId, merged);
  }

  async function finalizeDb(merged, meta) {
    const judgeId = await mysql.execute(
      `INSERT INTO judge (submit_id, task_id, problem_id, status, ac_count, total_cases, cpu_ms, mem_mb, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        meta.submit_id || 0, merged.task_id, merged.problem_id, merged.status,
        merged.ac_count || 0, merged.total_cases || 0,
        merged.cpu_ms || 0, merged.mem_mb || 0, String(merged.error || "").slice(0, 2048),
      ],
    ).then((r) => r.insertId).catch(() => 0);

    if (judgeId && Array.isArray(merged.cases)) {
      await mysql.execute("DELETE FROM judge_run WHERE task_id = ?", [merged.task_id]).catch(() => {});
      for (let i = 0; i < merged.cases.length; i += 1) {
        const c = merged.cases[i];
        await mysql.execute(
          `INSERT INTO judge_run (judge_id, submit_id, task_id, case_index, case_name, status, cpu_ms, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [judgeId, meta.submit_id || 0, merged.task_id, i + 1, c.name, c.status, c.cpu_ms || 0, c.error || ""],
        ).catch(() => {});
      }
    }

    await mysql.execute("UPDATE submit SET status = ? WHERE task_id = ?", [merged.status, merged.task_id])
      .catch(() => {});
  }

  /** 启动结果消费者，返回一个同步可调用的“全部停掉”函数。 */
  function startResultConsumer() {
    mq.consumeResults((result) => consumeResult(result))
      .then((stopFn) => {
        stops.push(stopFn);
        log.info("result consumer listening", { queue: config.mq.resultQueue });
      })
      .catch((err) => {
        log.error("result consumer start failed", { queue: config.mq.resultQueue, error: err });
      });

    return stopAll;
  }

  async function stopAll() {
    const pending = stops.splice(0, stops.length);
    await Promise.allSettled(pending.map((fn) => fn()));
  }

  return {
    submit, judgeOne, consumeResult, startWorker, startResultConsumer, stopAll, makeStoreKey,
  };
}
