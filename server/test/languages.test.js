import test from "node:test";
import assert from "node:assert/strict";
import {
  LANG_SPECS, normalizeLang, cpuBudgetMs, buildRunSpec, supportedLanguages, CPU_STARTUP_MS,
} from "../src/plugins/sandbox/languages.js";

test("normalizeLang: 别名归一", () => {
  assert.equal(normalizeLang("PY"), "python");
  assert.equal(normalizeLang("py"), "python");
  assert.equal(normalizeLang("python3"), "python");
  assert.equal(normalizeLang("C++"), "cpp");
  assert.equal(normalizeLang("golang"), "go");
  assert.equal(normalizeLang("  Java "), "java");
  assert.equal(normalizeLang(undefined), "");
});

test("每种语言的源文件名与构建命令自洽", () => {
  for (const [lang, spec] of Object.entries(LANG_SPECS)) {
    assert.ok(spec.src, `${lang} 缺少源文件名`);
    assert.ok(Array.isArray(spec.build) && spec.build.length, `${lang} 缺少构建命令`);
    // 构建命令里必须引用源文件，否则编译的永远是上一次的残留
    assert.ok(spec.build.some((a) => String(a).includes(spec.src)), `${lang} 构建未引用 ${spec.src}`);
    // native 必须产出 user_bin，run 阶段就是跑它
    if (spec.kind === "native") {
      const idx = spec.build.indexOf("-o");
      assert.ok(idx >= 0 && spec.build[idx + 1] === "user_bin", `${lang} 未输出 user_bin`);
    }
  }
});

test("Java 的 pids 上限必须高于 C/C++（JVM 要开 GC/JIT 线程）", () => {
  assert.ok(LANG_SPECS.java.pids > LANG_SPECS.cpp.pids);
});

test("cpuBudgetMs: 用加法补贴启动开销，不是倍数放大", () => {
  assert.equal(cpuBudgetMs("cpp", 1000), 1000);
  assert.equal(cpuBudgetMs("python", 1000), 1000 + CPU_STARTUP_MS.python);
  assert.equal(cpuBudgetMs("java", 1000), 1300);
  // 10s 的题不能因为 Java 变成 30s
  assert.equal(cpuBudgetMs("java", 10000), 10300);
});

test("buildRunSpec: python 用解释器拉起且带 -B -u", () => {
  const { binary, args, pids } = buildRunSpec(LANG_SPECS.python, "/w", 256 * 1024 * 1024);
  assert.ok(binary.endsWith("python3") || binary === "python3");
  assert.deepEqual(args.slice(0, 2), ["-B", "-u"]);
  assert.equal(args[2].replace(/\\/g, "/"), "/w/main.py");
  assert.equal(pids, 16);
});

test("buildRunSpec: java 堆取内存上限一半，且有 32m 下限", () => {
  const small = buildRunSpec(LANG_SPECS.java, "/w", 16 * 1024 * 1024);
  assert.ok(small.args.includes("-Xmx32m"), "小内存题必须兜到 32m");

  const big = buildRunSpec(LANG_SPECS.java, "/w", 512 * 1024 * 1024);
  assert.ok(big.args.includes("-Xmx256m"));
  assert.ok(big.args.includes("-cp"));
  assert.equal(big.args[big.args.length - 1], "Main");
});

test("buildRunSpec: native 直接跑构建产物", () => {
  const spec = buildRunSpec(LANG_SPECS.cpp, "/w", 256 * 1024 * 1024);
  assert.equal(spec.binary.replace(/\\/g, "/"), "/w/user_bin");
  assert.deepEqual(spec.args, []);
});

test("supportedLanguages 覆盖 C/C++/Python/Java/Go", () => {
  const langs = supportedLanguages();
  for (const lang of ["c", "cpp", "python", "java", "go"]) {
    assert.ok(langs.includes(lang), `缺少 ${lang}`);
  }
});
