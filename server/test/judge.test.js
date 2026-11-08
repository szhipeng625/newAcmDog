import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJudgeService, makeStoreKey } from "../src/services/judgeService.js";
import { createResultHub } from "../src/services/resultHub.js";
import { createMockSandbox } from "../src/plugins/sandbox/mock.js";

/**
 * 判题链路单测：用 mock 沙箱替掉真实进程沙箱，
 * 验证的是「取题 → 逐点判 → 汇总 → 落库」这段业务逻辑，不是内核隔离。
 */

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "judge-test-"));

const CONFIG = {
  http: { resultTtlMs: 60_000 },
  mq: { taskQueue: "oj.judge", resultQueue: "oj.judge.result" },
  sandbox: {
    workRoot: TMP,
    dataRoot: path.join(TMP, "data"),
    maxCodeBytes: 256 * 1024,
    cpuMsMax: 10_000,
    maxStreamBytes: 8 * 1024 * 1024,
  },
};

async function makeCaseDir(pid, cases) {
  const dir = path.join(CONFIG.sandbox.dataRoot, `p${pid}`);
  await fs.mkdir(dir, { recursive: true });
  const out = [];
  for (const c of cases) {
    await fs.writeFile(path.join(dir, `${c.name}.in`), c.input);
    await fs.writeFile(path.join(dir, `${c.name}.out`), c.expected);
    out.push({
      name: c.name,
      input: path.join(dir, `${c.name}.in`),
      expected: path.join(dir, `${c.name}.out`),
    });
  }
  return out;
}

function makeApp({ sandbox, meta, testData }) {
  const calls = { published: [], sql: [] };
  const app = {
    config: CONFIG,
    sandbox,
    infra: {
      mysql: {
        query: async (sql, args) => {
          calls.sql.push({ sql, args });
          if (/submission_store/.test(sql)) return calls.dup || [];
          return [];
        },
        execute: async (sql, args) => {
          calls.sql.push({ sql, args });
          return { insertId: 11 };
        },
      },
      mq: {
        publishTask: async (task) => calls.published.push(task),
        publish: async () => {},
        consume: async () => async () => {},
        consumeResults: async () => async () => {},
      },
      lsm: { saveFromResult: async () => ({ submitid: 7 }) },
      middleware: { submitScore: async () => ({}) },
    },
  };
  const problems = {
    meta: async () => meta,
    testData: async () => testData,
  };
  const resultHub = createResultHub(CONFIG);
  const judge = createJudgeService(app, { problems, resultHub });
  return { app, judge, resultHub, calls, problems };
}

const BASE_META = {
  id: 1, title: "A+B", timeMs: 1000, memMb: 256, judgeMode: 0, spjExe: "", entryExe: "",
};

const CASES = [
  { name: "1", input: "1 2\n", expected: "3\n" },
  { name: "2", input: "5 5\n", expected: "10\n" },
];

const submitted = (extra = {}) => ({
  task_id: "t1", problem_id: 1, language: "cpp", code: "int main(){}", username: "u",
  ...extra,
});

test("judgeOne: 全部通过 → AC", async () => {
  const testData = await makeCaseDir(1, CASES);
  const { judge } = makeApp({ sandbox: createMockSandbox(), meta: BASE_META, testData });

  const r = await judge.judgeOne(submitted());
  assert.equal(r.status, "AC");
  assert.equal(r.ac_count, 2);
  assert.equal(r.total_cases, 2);
  assert.equal(r.cpu_ms, 3); // 每个点 1.5ms
  assert.equal(r.cases.length, 2);
  assert.equal(r.error, "");
});

test("judgeOne: 某点不过 → 取第一个失败点的状态", async () => {
  const testData = await makeCaseDir(1, CASES);
  const sandbox = createMockSandbox({
    behavior: (task) => (task.task_id.endsWith("_2") ? { status: "WA" } : {}),
  });
  const { judge } = makeApp({ sandbox, meta: BASE_META, testData });

  const r = await judge.judgeOne(submitted());
  assert.equal(r.status, "WA");
  assert.equal(r.ac_count, 1);
  assert.equal(r.cases[1].status, "WA");
  assert.match(r.error, /输出与标准答案不一致/);
});

test("judgeOne: 每条用例的 task_id 带测试点名，互不覆盖", async () => {
  const testData = await makeCaseDir(1, CASES);
  const seen = [];
  const sandbox = createMockSandbox({ behavior: (task) => { seen.push(task.task_id); return {}; } });
  const { judge } = makeApp({ sandbox, meta: BASE_META, testData });
  await judge.judgeOne(submitted());
  assert.deepEqual(seen, ["t1_1", "t1_2"]);
});

test("judgeOne: spj 模式 —— 用户程序先跑，再交给 checker 判", async () => {
  const testData = await makeCaseDir(1, CASES);
  const meta = { ...BASE_META, spjExe: Buffer.from("#!/bin/sh\nexit 0\n").toString("base64") };
  const checkers = [];
  const sandbox = createMockSandbox({
    behavior: (task) => {
      if (task.checker === "exitcode") {
        checkers.push(task.args);
        return { status: task.task_id.endsWith("_2_spj") ? "WA" : "AC" };
      }
      return {};
    },
  });
  const { judge } = makeApp({ sandbox, meta, testData });

  const r = await judge.judgeOne(submitted());
  assert.equal(checkers.length, 2, "每个测试点都要跑一次 checker");
  assert.equal(r.status, "WA");
  assert.equal(r.ac_count, 1);
});

test("judgeOne: 函数式判题拿不到输出文件 → WA 而不是 AC", async () => {
  const testData = await makeCaseDir(1, CASES);
  const meta = {
    ...BASE_META, judgeMode: 1, entryExe: Buffer.from("#!/bin/sh\n").toString("base64"),
  };
  const { judge } = makeApp({ sandbox: createMockSandbox(), meta, testData });

  const r = await judge.judgeOne(submitted());
  assert.equal(r.status, "WA");
  assert.match(r.error, /未产出输出文件/);
});

test("judgeOne: 编译失败 → CE，带上编译器信息", async () => {
  const testData = await makeCaseDir(1, CASES);
  const sandbox = createMockSandbox();
  sandbox.prepare = async () => {
    const err = new Error("main.cpp:1:1: error: expected ';'");
    err.isCompileError = true;
    throw err;
  };
  const { judge } = makeApp({ sandbox, meta: BASE_META, testData });

  const r = await judge.judgeOne(submitted());
  assert.equal(r.status, "CE");
  assert.match(r.error, /expected/);
});

test("judgeOne: 题目不存在 → SE，不抛异常", async () => {
  const { judge } = makeApp({ sandbox: createMockSandbox(), meta: null, testData: [] });
  const r = await judge.judgeOne(submitted());
  assert.equal(r.status, "SE");
  assert.match(r.error, /problem not found/);
});

test("judgeOne: 没有测试点 → SE（不能默认判过）", async () => {
  const { judge } = makeApp({ sandbox: createMockSandbox(), meta: BASE_META, testData: [] });
  const r = await judge.judgeOne(submitted());
  assert.equal(r.status, "SE");
  assert.match(r.error, /no testcases/);
});

test("submit: 正常提交 → 写 submit 表 + 投递任务", async () => {
  const testData = await makeCaseDir(1, CASES);
  const { judge, calls } = makeApp({ sandbox: createMockSandbox(), meta: BASE_META, testData });

  const res = await judge.submit(
    { code: "int main(){}", language: "C++", problemId: 1, contestId: 0 },
    { username: "u", token: "tk" },
  );
  assert.match(res.task_id, /^web_[0-9a-f]{12}$/);
  assert.equal(res.status, "pending");

  assert.equal(calls.published.length, 1);
  assert.equal(calls.published[0].language, "cpp", "C++ 要归一成 cpp");
  assert.equal(calls.published[0].cpu_limit_ms, 1000);
  assert.equal(calls.published[0].mem_limit_bytes, 256 * 1024 * 1024);

  const insert = calls.sql.find((s) => /INSERT INTO submit/.test(s.sql));
  assert.ok(insert, "必须写入 submit 表");
  assert.equal(insert.args[1], "u");
  assert.equal(insert.args[5], "cpp");
});

test("submit: 同一用户同一份代码重复提交 → 409", async () => {
  const { judge, calls } = makeApp({ sandbox: createMockSandbox(), meta: BASE_META, testData: [] });
  calls.dup = [{ submission_no: "sub_abc" }];

  await assert.rejects(
    () => judge.submit({ code: "x", language: "cpp", problemId: 1 }, { username: "u" }),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.extra.duplicate, true);
      assert.equal(err.extra.submission_no, "sub_abc");
      return true;
    },
  );
  assert.equal(calls.published.length, 0, "重复提交不能进队列");
});

test("submit: 不支持的语言 / 空代码 / 缺题号 → 400", async () => {
  const { judge } = makeApp({ sandbox: createMockSandbox(), meta: BASE_META, testData: [] });
  await assert.rejects(() => judge.submit({ code: "", language: "cpp", problemId: 1 }, { username: "u" }), /代码不能为空/);
  await assert.rejects(() => judge.submit({ code: "x", language: "rust", problemId: 1 }, { username: "u" }), /Unsupported language/);
  await assert.rejects(() => judge.submit({ code: "x", language: "cpp" }, { username: "u" }), /problemId/);
});

test("consumeResult: 落 LSM + 更新 submit.status", async () => {
  const { judge, resultHub, calls } = makeApp({ sandbox: createMockSandbox(), meta: BASE_META, testData: [] });
  resultHub.setMeta("t1", { username: "u", problem: "A+B", language: "cpp", submit_id: 11 });

  await judge.consumeResult({ task_id: "t1", problem_id: 1, status: "AC", ac_count: 2, total_cases: 2 });

  const update = calls.sql.find((s) => /UPDATE submit SET status/.test(s.sql));
  assert.ok(update, "必须回写 submit 状态");
  assert.equal(update.args[0], "AC");
  assert.equal(resultHub.latest("t1").submission_no, "sub_7");
});

test("consumeResult: 中间态只更新内存，不落库", async () => {
  const { judge, resultHub, calls } = makeApp({ sandbox: createMockSandbox(), meta: BASE_META, testData: [] });
  await judge.consumeResult({ task_id: "t9", status: "judging", done_cases: 1, total_cases: 3 });
  assert.equal(calls.sql.length, 0);
  assert.equal(resultHub.latest("t9").done_cases, 1);
});

test("makeStoreKey: 同用户同代码稳定，换用户/换代码都变", () => {
  const a = makeStoreKey("u", "code");
  assert.equal(a, makeStoreKey("u", "code"));
  assert.notEqual(a, makeStoreKey("v", "code"));
  assert.notEqual(a, makeStoreKey("u", "code2"));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("清理：判题结束要删掉临时工作目录", async () => {
  const testData = await makeCaseDir(1, CASES);
  const { judge } = makeApp({ sandbox: createMockSandbox(), meta: BASE_META, testData });
  await judge.judgeOne(submitted({ task_id: "cleanup" }));
  const left = await fs.readdir(path.join(CONFIG.sandbox.workRoot)).catch(() => []);
  assert.equal(left.filter((n) => n.startsWith("judge_cleanup")).length, 0);
});
