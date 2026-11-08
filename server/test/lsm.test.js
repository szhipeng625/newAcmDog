import test from "node:test";
import assert from "node:assert/strict";
import { encode, parseValue } from "../src/infra/lsm.js";

test("encode: RESP 数组编码逐字节正确", () => {
  assert.equal(encode("GET", "k").toString("binary"), "*2\r\n$3\r\nGET\r\n$1\r\nk\r\n");
});

test("encode: 多字节字符按 UTF-8 长度写 $len", () => {
  const buf = encode("SET", "题目", "值");
  assert.equal(buf.toString("binary").startsWith("*3\r\n$3\r\nSET\r\n$6\r\n"), true);
});

test("parseValue: 简单字符串 / 整数 / 错误", () => {
  assert.equal(parseValue(Buffer.from("+OK\r\n")).value, "OK");
  assert.equal(parseValue(Buffer.from(":42\r\n")).value, 42);
  assert.deepEqual(parseValue(Buffer.from("-ERR bad\r\n")).value, { __error__: "ERR bad" });
});

test("parseValue: bulk string 与 nil", () => {
  assert.equal(parseValue(Buffer.from("$3\r\nabc\r\n")).value, "abc");
  assert.equal(parseValue(Buffer.from("$0\r\n\r\n")).value, "");
  assert.equal(parseValue(Buffer.from("$-1\r\n")).value, null);
});

test("parseValue: 数组嵌套", () => {
  const parsed = parseValue(Buffer.from("*2\r\n$1\r\na\r\n*2\r\n:1\r\n:2\r\n"));
  assert.deepEqual(parsed.value, ["a", [1, 2]]);
});

test("parseValue: 数据不完整返回 null（增量解析的关键）", () => {
  assert.equal(parseValue(Buffer.from("*2\r\n$3\r\nGE")), null);
  assert.equal(parseValue(Buffer.from("$10\r\nabc")), null);
  assert.equal(parseValue(Buffer.from("")), null);

  // 分两批到达，拼起来才完整
  const full = Buffer.from("*2\r\n$3\r\nGET\r\n$1\r\nk\r\n");
  assert.equal(parseValue(full.subarray(0, 7), 0), null);
  const done = parseValue(full, 0);
  assert.deepEqual(done.value, ["GET", "k"]);
  assert.equal(done.next, full.length);
});

test("parseValue: 中文 value 按 UTF-8 解回", () => {
  const payload = Buffer.from("中国", "utf8");
  const buf = Buffer.concat([
    Buffer.from(`$${payload.length}\r\n`, "latin1"),
    payload,
    Buffer.from("\r\n", "latin1"),
  ]);
  assert.equal(parseValue(buf).value, "中国");
});
