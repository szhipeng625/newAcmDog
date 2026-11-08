import test from "node:test";
import assert from "node:assert/strict";
import { normalizeText, outputsMatch } from "../src/plugins/sandbox/normalize.js";

// 归一化规则与 C++ eval_worker / Python 实现逐字一致：
// 去 BOM → 删 \r → 删行尾空白 → 删末尾空行。行首空白不忽略。

test("normalizeText: 统一换行并去掉行尾空白", () => {
  assert.equal(normalizeText("a\r\nb\r\n"), "a\nb\n");
  assert.equal(normalizeText("a   \nb\t\n\n\n"), "a\nb\n");
  assert.equal(normalizeText(""), "");
  assert.equal(normalizeText(null), "");
  assert.equal(normalizeText(undefined), "");
});

test("normalizeText: 保留行首缩进（缩进可能是有意义的输出）", () => {
  assert.equal(normalizeText("  x  \n    y"), "  x\n    y\n");
});

test("normalizeText: 去 UTF-8 BOM", () => {
  assert.equal(normalizeText("\uFEFF42\n"), "42\n");
});

test("outputsMatch: 末尾换行差异不算错", () => {
  assert.equal(outputsMatch("1 2 3", "1 2 3\n"), true);
  assert.equal(outputsMatch("1 2 3\n\n", "1 2 3"), true);
});

test("outputsMatch: 行内多余空白算错（不能宽松到失去判错能力）", () => {
  assert.equal(outputsMatch("1  2", "1 2"), false);
  assert.equal(outputsMatch("1 2", "1 3"), false);
});

test("outputsMatch: 纯空白输出等价于空输出", () => {
  assert.equal(outputsMatch("", "\n"), true);
  assert.equal(outputsMatch("", " \t\n"), true);
  assert.equal(outputsMatch("0", ""), false);
});
