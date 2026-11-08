import test from "node:test";
import assert from "node:assert/strict";
import { buildPdf, PdfPage, utf16Hex, measureText } from "../src/services/pdf.js";
import { toBlocks, wrapLine, buildContestPdf } from "../src/services/contestPdf.js";

test("utf16Hex: BMP 字符按 UCS-2 编码，增补平面降级为 ?", () => {
  assert.equal(utf16Hex("A"), "0041");
  assert.equal(utf16Hex("中"), "4E2D");
  assert.equal(utf16Hex("😀"), "003F");
});

test("measureText: 拉丁用比例宽度，中文用全角宽度", () => {
  assert.ok(Math.abs(measureText("A", 10) - 6.67) < 0.01);
  assert.equal(measureText("中", 10), 10);
  assert.ok(measureText("A", 10) < measureText("中", 10));
});

test("buildPdf: 头部 / xref 偏移 / EOF 结构自洽", () => {
  const page = new PdfPage();
  page.text(72, 700, 12, "hello 中文");
  const buf = buildPdf([page], { title: "测试" });
  const text = buf.toString("latin1");

  assert.ok(text.startsWith("%PDF-1.4"));
  assert.ok(text.trimEnd().endsWith("%%EOF"));

  const m = /startxref\n(\d+)\n%%EOF/.exec(text);
  assert.ok(m, "缺少 startxref");
  const xrefStart = Number(m[1]);
  assert.equal(text.slice(xrefStart, xrefStart + 4), "xref");

  const header = /xref\n0 (\d+)\n/.exec(text.slice(xrefStart));
  const count = Number(header[1]);
  // 固定 7 个（含 F2 Helvetica）+ 每页 2 个，单页时 id 上限 9 → xref 共 10 条
  assert.equal(count, 10);
  assert.match(text, /\/Font << \/F1 3 0 R \/F2 7 0 R >>/);

  const body = text.slice(xrefStart + header[0].length);
  const offsets = [];
  for (let i = 1; i < count; i += 1) {
    // 第 0 条是 free 表项，id 1 从第 1 条开始
    const line = body.slice(i * 20, (i + 1) * 20);
    offsets.push({ id: i, offset: Number(line.slice(0, 10)) });
  }
  for (const { id, offset } of offsets) {
    assert.equal(text.slice(offset, offset + `${id} 0 obj`.length), `${id} 0 obj`, `obj ${id} 偏移错误`);
  }
});

test("buildPdf: 多页时页面树与内容流一一对应", () => {
  const pages = [new PdfPage(), new PdfPage(), new PdfPage()];
  pages[1].text(50, 50, 10, "p2");
  const text = buildPdf(pages).toString("latin1");
  assert.match(text, /\/Count 3/);
  assert.match(text, /\/Kids \[8 0 R 10 0 R 12 0 R\]/);
  assert.match(text, /\/Contents 13 0 R/);
});

test("wrapLine: 按真实字宽折行，ASCII 单词不被拆断", () => {
  assert.deepEqual(wrapLine("hello world", 10, 30), ["hello", "world"]);
  assert.deepEqual(wrapLine("中文测试换行", 10, 50), ["中文测试换", "行"]);
});

test("wrapLine: 超长无空格 token 被强制切断且每行不超宽", () => {
  const lines = wrapLine("aaaaaaaaaaaa", 10, 50);
  assert.ok(lines.length >= 2);
  for (const line of lines) {
    assert.ok(measureText(line, 10) <= 50 + 1e-6, `"${line}" 超宽`);
  }
});

test("toBlocks: 代码块 / 标题 / 列表 / 段落", () => {
  const blocks = toBlocks("# 标题\n\npara one\npara two\n\n- item\n\n```\ncode\n```");
  assert.deepEqual(blocks, [
    { type: "h2", text: "标题" },
    { type: "body", text: "para one para two" },
    { type: "bullet", text: "item" },
    { type: "code", text: "code" },
  ]);
});

test("buildContestPdf: 多题时每题一页", () => {
  const buf = buildContestPdf(
    { name: "校赛", startTime: "2026-05-01 09:00", endTime: "2026-05-01 12:00" },
    [
      { title: "A", description: "第一题", timeMs: 1000, memMb: 256, sampleIn: "1", sampleOut: "1" },
      { title: "B", description: "第二题", timeMs: 2000, memMb: 512 },
    ],
  );
  const text = buf.toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.match(text, /\/Count 2/, "标题页 + 第一题在第 1 页，第二题另起一页");
});
