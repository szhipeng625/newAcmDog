import path from "node:path";

const PYTHON_BIN = process.env.PYTHON_BIN || "python3";
const JAVA_BIN = process.env.JAVA_BIN || "java";
const JAVAC_BIN = process.env.JAVAC_BIN || "javac";
const GO_BIN = process.env.GO_BIN || "go";

// 只做语法预检，不落盘：避免生成 __pycache__（沙箱里 nobody 也写不进去）
const PY_SYNTAX_CHECK =
  "src = open('main.py','rb').read().decode('utf-8-sig'); compile(src,'main.py','exec')";

/**
 * 语言配置。
 * kind: native 直接跑构建产物；python/java 由解释器拉起。
 * pids: cgroup pids.max，JVM 要开 GC/JIT 线程，必须比 C/C++ 高。
 */
export const LANG_SPECS = {
  c: {
    src: "main.c",
    build: ["gcc", "-O2", "-std=c17", "-o", "user_bin", "main.c", "-lm"],
    kind: "native", buildTimeout: 30, pids: 32,
  },
  cpp: {
    src: "main.cpp",
    build: ["g++", "-O2", "-std=c++17", "-o", "user_bin", "main.cpp", "-lm"],
    kind: "native", buildTimeout: 30, pids: 32,
  },
  cc: {
    src: "main.cpp",
    build: ["g++", "-O2", "-std=c++17", "-o", "user_bin", "main.cpp", "-lm"],
    kind: "native", buildTimeout: 30, pids: 32,
  },
  python: {
    src: "main.py",
    build: [PYTHON_BIN, "-c", PY_SYNTAX_CHECK],
    kind: "python", buildTimeout: 15, pids: 16,
  },
  java: {
    src: "Main.java",
    build: [JAVAC_BIN, "-encoding", "UTF-8", "-d", ".", "Main.java"],
    kind: "java", buildTimeout: 60, pids: 96,
  },
  go: {
    src: "main.go",
    build: [GO_BIN, "build", "-trimpath", "-o", "user_bin", "main.go"],
    kind: "native", buildTimeout: 120, pids: 32,
  },
};

export const LANG_ALIASES = {
  py: "python", python3: "python", python2: "python",
  "c++": "cpp", golang: "go",
};

export function normalizeLang(lang) {
  const key = String(lang || "").trim().toLowerCase();
  return LANG_ALIASES[key] || key;
}

// 运行时自身的启动开销不占题目时限。用固定补贴而不是倍数放大：
// 10s 的题乘 3 会变 30s，加法只到 10.3s。
export const CPU_STARTUP_MS = { java: 300, python: 60, go: 20 };

export function cpuBudgetMs(lang, cpuLimitMs) {
  return cpuLimitMs + (CPU_STARTUP_MS[lang] || 0);
}

/** 决定沙箱最终 execve 的目标与参数。 */
export function buildRunSpec(spec, workDir, memBytes) {
  if (spec.kind === "native") {
    return { binary: path.join(workDir, "user_bin"), args: [], pids: spec.pids };
  }
  if (spec.kind === "python") {
    // -B 不写 __pycache__；-u 不缓冲，被 SIGKILL 时已打印内容也不丢
    return {
      binary: PYTHON_BIN,
      args: ["-B", "-u", path.join(workDir, spec.src)],
      pids: spec.pids,
    };
  }
  // java：堆给内存上限一半，其余留给 metaspace / code cache / 线程栈
  const heapMb = Math.max(32, Math.floor((memBytes * 0.5) / (1024 * 1024)));
  return {
    binary: JAVA_BIN,
    args: [
      "-XX:-UsePerfData",
      "-XX:+UseSerialGC",
      "-XX:ActiveProcessorCount=2",
      "-Dfile.encoding=UTF-8",
      `-Xmx${heapMb}m`,
      "-cp", workDir,
      "Main",
    ],
    pids: spec.pids,
  };
}

export function supportedLanguages() {
  return Object.keys(LANG_SPECS);
}
