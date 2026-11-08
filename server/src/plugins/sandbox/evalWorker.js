import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  LANG_SPECS, buildRunSpec, supportedLanguages,
} from "./languages.js";

export class CompileError extends Error {
  constructor(message) {
    super(message);
    this.isCompileError = true;
  }
}

const MAX_OUTPUT = 8 * 1024 * 1024;

/**
 * 执行子进程并收集输出。
 * detached=true 让子进程自成进程组，超时可以整组 SIGKILL，
 * 避免 gcc 派生的 cc1plus 之类的孙进程残留。
 */
export function runChild(cmd, { cwd, timeoutMs = 30000, env, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      cwd,
      env: env || process.env,
      detached: process.platform !== "win32",
      stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });

    const outChunks = [];
    const errChunks = [];
    let outLen = 0;
    let errLen = 0;
    let timedOut = false;
    let settled = false;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        timedOut,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* 已退出 */ }
    }, timeoutMs);

    child.stdout.on("data", (buf) => {
      if (outLen < MAX_OUTPUT) { outChunks.push(buf); outLen += buf.length; }
    });
    child.stderr.on("data", (buf) => {
      if (errLen < MAX_OUTPUT) { errChunks.push(buf); errLen += buf.length; }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ code: -1, stdout: "", stderr: String(err.message), timedOut });
      }
    });
    child.on("close", finish);

    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

/**
 * 本地沙箱：编译 + 通过 C++ eval_worker 执行。
 * eval_worker 负责 cgroup / namespace / seccomp / 降权，本层只负责喂 JSON。
 */
export function createEvalWorkerSandbox(options = {}) {
  const evalWorker = options.evalWorker;
  const workRoot = options.workRoot || os.tmpdir();
  const goCache = path.join(os.tmpdir(), ".judge-gocache");

  return {
    name: "local",
    languages: supportedLanguages(),

    /** 编译或预检，返回沙箱运行参数。编译失败抛 CompileError。 */
    async prepare({ code, lang, workDir, memBytes }) {
      const spec = LANG_SPECS[lang];
      if (!spec) throw new CompileError(`Unsupported language: ${lang}`);

      const dir = workDir || path.join(workRoot, `judge_${Date.now()}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, spec.src), code, "utf8");

      let env;
      if (lang === "go") {
        await fs.mkdir(goCache, { recursive: true });
        env = {
          ...process.env,
          GOCACHE: goCache,
          GOPATH: path.join(goCache, "gopath"),
          CGO_ENABLED: "0",
        };
      }

      const { code: rc, stderr, timedOut } = await runChild(spec.build, {
        cwd: dir,
        timeoutMs: spec.buildTimeout * 1000,
        env,
      });

      if (timedOut) throw new CompileError(`Compilation timed out (${spec.buildTimeout}s)`);
      if (rc !== 0) throw new CompileError(stderr.trim().slice(0, 4096) || `toolchain exited ${rc}`);

      if (spec.kind === "native") {
        try {
          await fs.access(path.join(dir, "user_bin"));
        } catch {
          throw new CompileError("build reported success but produced no binary");
        }
      } else if (spec.kind === "java") {
        try {
          await fs.access(path.join(dir, "Main.class"));
        } catch {
          throw new CompileError("编译未生成 Main.class：类名必须是 Main，且不要使用 package 声明");
        }
      }

      return { workDir: dir, ...buildRunSpec(spec, dir, memBytes) };
    },

    /** 执行一次判题，task 字段与 eval_worker 的 JSON 契约一致。 */
    async run(task) {
      const payload = JSON.stringify({
        task_id: task.task_id,
        user_binary: task.binary,
        args: task.args || [],
        problem_data: task.problem_data || "",
        stdin_file: task.stdin_file || "",
        expected_output_file: task.expected_output_file || "",
        cpu_limit_ms: task.cpu_limit_ms,
        mem_limit_bytes: task.mem_limit_bytes,
        max_pids: task.max_pids || 32,
        checker: task.checker || "diff",
      }) + "\n";

      const cpuMs = task.cpu_limit_ms || 1000;
      const timeoutMs = Math.min(120000, Math.max(30000, cpuMs + 30000));

      const { stdout, stderr, timedOut, code } = await runChild([evalWorker], {
        input: payload,
        timeoutMs,
      });

      if (timedOut) {
        return { task_id: task.task_id, status: "SE", error: `eval_worker did not exit within ${timeoutMs / 1000}s` };
      }

      for (const line of stdout.split("\n")) {
        const text = line.trim();
        if (!text.startsWith("{")) continue;
        try {
          return JSON.parse(text);
        } catch { /* 继续找下一行 JSON */ }
      }

      return {
        task_id: task.task_id,
        status: "SE",
        error: stderr.trim().slice(0, 1024) || `eval_worker exited ${code}, no JSON output`,
      };
    },

    async close() {},
  };
}
