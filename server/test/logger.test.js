import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createLogger, logger, formatRecord, shouldLog, redactText, redactValue,
} from "../src/core/logger.js";

const capture = (options = {}) => {
  const lines = [];
  const instance = createLogger({
    console: false,
    level: "debug",
    sink: (level, line, record) => lines.push({ level, line, record }),
    ...options,
  });
  return { instance, lines };
};

test("shouldLog: 级别过滤是 >= 语义", () => {
  assert.equal(shouldLog("debug", "info"), false);
  assert.equal(shouldLog("info", "info"), true);
  assert.equal(shouldLog("warn", "info"), true);
  assert.equal(shouldLog("error", "warn"), true);
  assert.equal(shouldLog("info", "error"), false);
  assert.equal(shouldLog("bogus", "bogus"), true); // 未知级别回落 info，不静默丢日志
});

test("formatRecord: text 可读、json 单行可解析", () => {
  const rec = {
    ts: "2026-11-08T03:00:00.000Z", level: "info", module: "judge",
    message: "judge finished", status: "AC",
  };
  const text = formatRecord(rec, "text");
  assert.match(text, /2026-11-08T03:00:00.000Z INFO\s+\[judge\] judge finished/);
  assert.match(text, /"status":"AC"/);
  assert.ok(text.endsWith("\n"));

  const parsed = JSON.parse(formatRecord(rec, "json"));
  assert.deepEqual(parsed, rec);
  assert.equal(formatRecord(rec, "json").split("\n").length, 2);
});

test("redactText: 凭据不进日志（Bearer / query / JSON 片段）", () => {
  assert.equal(
    redactText("GET /api/cloud_whoami?token=abc123&x=1"),
    "GET /api/cloud_whoami?token=***&x=1",
  );
  assert.equal(redactText("Authorization: Bearer eyJhbGciOi.xxx"), "Authorization: Bearer ***");
  assert.equal(redactText('{"token":"secret-value"}'), '{"token":"***"}');
  assert.equal(redactText("line1\nline2"), "line1 \\n line2"); // 保持单行
});

test("redactValue: 敏感字段打码，普通字段保留", () => {
  const v = redactValue({
    token: "abc",
    code: "int main(){}",
    exit_code: 0,
    nested: { password: "p", status: "AC" },
    tags: ["a", "b"],
  });
  assert.equal(v.token, "***");
  assert.equal(v.code, "***");
  assert.equal(v.exit_code, 0, "exit_code 不是源码，不能被误伤");
  assert.equal(v.nested.password, "***");
  assert.equal(v.nested.status, "AC");
  assert.deepEqual(v.tags, ["a", "b"]);
});

test("redactValue: Error、循环引用、超深对象都不会写爆日志", () => {
  const err = redactValue(new Error("boom"), 0, new WeakSet(), true);
  assert.equal(err.name, "Error");
  assert.equal(err.message, "boom");
  assert.match(err.stack, /Error: boom/);

  const circular = { name: "root" };
  circular.self = circular;
  assert.equal(redactValue(circular).self, "[circular]");

  let deep = { leaf: 1 };
  for (let i = 0; i < 8; i += 1) deep = { child: deep };
  assert.deepEqual(redactValue(deep).child.child.child, "[object]");

  assert.equal(redactValue("x".repeat(5000)).length < 2100, true);
});

test("createLogger: 低于 level 的日志不产生任何输出", () => {
  const { instance, lines } = capture({ level: "warn" });
  instance.emit("debug", "m", "d");
  instance.emit("info", "m", "i");
  instance.emit("warn", "m", "w");
  instance.emit("error", "m", "e");
  assert.deepEqual(lines.map((x) => x.level), ["warn", "error"]);
});

test("runWith: 上下文自动附加，嵌套不污染父级", async () => {
  const { instance, lines } = capture();
  await instance.runWith({ request_id: "r1" }, async () => {
    instance.emit("info", "svc", "first");
    await instance.runWith({ task_id: "t1" }, () => {
      instance.emit("info", "svc", "nested");
    });
    instance.emit("info", "svc", "after");
  });

  assert.equal(lines[0].record.request_id, "r1");
  assert.equal(lines[0].record.task_id, undefined);
  assert.equal(lines[1].record.request_id, "r1");
  assert.equal(lines[1].record.task_id, "t1");
  assert.equal(lines[2].record.request_id, "r1");
  assert.equal(lines[2].record.task_id, undefined, "内层上下文不能泄漏到外层");
});

test("runWith: 并发请求之间的上下文互不串", async () => {
  const { instance, lines } = capture();
  await Promise.all(["a", "b"].map((id) => instance.runWith({ request_id: id }, async () => {
    await new Promise((resolve) => setTimeout(resolve, id === "a" ? 12 : 1));
    instance.emit("info", "svc", `done ${id}`);
  })));
  const byId = Object.fromEntries(lines.map((x) => [x.record.request_id, x.record.message]));
  assert.deepEqual(byId, { a: "done a", b: "done b" });
});

test("文件输出：写盘 + 按大小轮转 + 保留上限", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acmdog-log-test-"));
  try {
    const instance = createLogger({
      console: false, dir, file: "app.log", maxBytes: 180, maxFiles: 3, level: "info",
    });
    for (let i = 0; i < 14; i += 1) {
      instance.emit("info", "rotate", `message number ${i}`, { index: i });
    }
    instance.close();
    instance.close(); // 关闭必须幂等

    const files = fs.readdirSync(dir).sort();
    assert.ok(files.includes("app.log"), "当前日志文件应存在");
    assert.ok(files.includes("app.log.1"), "应产生轮转文件");
    assert.ok(files.length <= 4, `轮转文件超出 maxFiles：${files.join(",")}`);
    assert.match(fs.readFileSync(path.join(dir, "app.log"), "utf8"), /\[rotate\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("logger 代理：configure 之后旧引用仍能写进新实现", () => {
  const child = logger.child("proxy-test");
  const lines = [];
  try {
    logger.configure({
      console: false, level: "debug", dir: "",
      sink: (level, line, record) => lines.push({ level, record }),
    });
    child.info("hello", { token: "supersecret", status: "AC" });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].record.module, "proxy-test");
    assert.equal(lines[0].record.token, "***");
    assert.equal(lines[0].record.status, "AC");
  } finally {
    logger.configure({ console: false, dir: "", level: "info" });
  }
});
