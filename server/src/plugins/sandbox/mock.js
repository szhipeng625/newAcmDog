import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { supportedLanguages } from "./languages.js";

/**
 * 开发用沙箱：不编译、不执行任何用户代码，只返回构造好的判定结果。
 * 用于本机联调 API 与结果持久化链路（没有 Linux cgroup/seccomp 的环境）。
 * 通过 options.behavior(task) 可以注入 WA/TLE/RE 等场景。
 */
export function createMockSandbox(options = {}) {
  const behavior = options.behavior || (() => ({}));

  return {
    name: "mock",
    languages: supportedLanguages(),

    async prepare({ workDir }) {
      const dir = workDir || path.join(os.tmpdir(), `mock_${Date.now()}`);
      await fs.mkdir(dir, { recursive: true });
      return { workDir: dir, binary: path.join(dir, "user_bin"), args: [], pids: 32 };
    },

    async run(task) {
      return {
        task_id: task.task_id,
        status: "AC",
        cpu_ns: 1_500_000,
        mem_bytes: 2 * 1024 * 1024,
        exit_code: 0,
        ...behavior(task),
      };
    },

    async close() {},
  };
}
