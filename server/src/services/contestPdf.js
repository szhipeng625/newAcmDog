import { buildPdf, PdfPage, PAGE_HEIGHT, PAGE_WIDTH, MM_TO_PT, measureText } from "./pdf.js";

/**
 * 竞赛题面 PDF：标题页 + 每题一页。
 * 版式对齐原 reportlab 实现（A4、左右 20mm、上下 18mm、字号 22/16/13/12/11/10.5/9.5）。
 */

const MARGIN_L = 20 * MM_TO_PT;
const MARGIN_R = 20 * MM_TO_PT;
const MARGIN_T = 18 * MM_TO_PT;
const MARGIN_B = 18 * MM_TO_PT;
const CONTENT_W = PAGE_WIDTH - MARGIN_L - MARGIN_R;

const ASCII_WORD = /^[\x21-\x7e]+$/;

/** 只清掉行内标记，不做字体切换——原实现里 <b>/<i> 映射回同一套 CJK 字体，视觉无差别。 */
function mdInline(text) {
  return String(text ?? "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1");
}

/** Markdown → 段落块（与 Python 版 _md_to_flowables 的分支一致） */
export function toBlocks(md) {
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let para = [];
  let code = [];
  let inCode = false;

  const flushPara = () => {
    if (!para.length) return;
    const text = para.map((s) => s.trim()).join(" ").trim();
    if (text) blocks.push({ type: "body", text });
    para = [];
  };

  for (const raw of lines) {
    const s = raw.trim();
    if (s.startsWith("```")) {
      if (inCode) {
        blocks.push({ type: "code", text: code.join("\n") || " " });
        code = [];
        inCode = false;
      } else {
        flushPara();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(raw.replace(/\s+$/, ""));
      continue;
    }
    if (!s) {
      flushPara();
      continue;
    }
    if (s.startsWith("####")) {
      flushPara();
      blocks.push({ type: "h4", text: s.slice(4).trim() });
    } else if (s.startsWith("###")) {
      flushPara();
      blocks.push({ type: "h3", text: s.slice(3).trim() });
    } else if (s.startsWith("##")) {
      flushPara();
      blocks.push({ type: "h2", text: s.slice(2).trim() });
    } else if (s.startsWith("#")) {
      flushPara();
      blocks.push({ type: "h2", text: s.slice(1).trim() });
    } else if (s.startsWith("- ") || s.startsWith("* ")) {
      flushPara();
      blocks.push({ type: "bullet", text: s.slice(2).trim() });
    } else {
      para.push(s);
    }
  }
  if (inCode && code.length) blocks.push({ type: "code", text: code.join("\n") });
  flushPara();
  return blocks;
}

/** 按真实字宽折行：ASCII 单词整体不断，CJK 逐字可断。 */
export function wrapLine(text, size, maxWidth) {
  const src = String(text ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ");
  if (!src) return [""];

  // 切成"单词 / 单个 CJK 字 / 空格"三种 token，再贪心填行
  const tokens = [];
  let word = "";
  const flush = () => {
    if (word) { tokens.push(word); word = ""; }
  };
  for (const ch of src) {
    if (ch === " " || ch === "\t") { flush(); tokens.push(" "); }
    else if (ASCII_WORD.test(ch)) word += ch;
    else { flush(); tokens.push(ch); }
  }
  flush();

  const w = (s) => measureText(s, size);
  const lines = [];
  let cur = "";

  for (const token of tokens) {
    if (w(token) > maxWidth) {
      // 超长 token（一长串无空格的路径/数字）：硬切
      for (const ch of token) {
        if (w(cur) + w(ch) > maxWidth) { lines.push(cur); cur = ""; }
        cur += ch;
      }
      continue;
    }
    if (w(cur) + w(token) > maxWidth) {
      lines.push(cur.replace(/\s+$/, ""));
      cur = token === " " ? "" : token;
    } else {
      cur += token;
    }
  }
  if (cur) lines.push(cur.replace(/\s+$/, ""));
  return lines.length ? lines : [""];
}

const STYLES = {
  title: { size: 22, leading: 30, gray: 0 },
  meta: { size: 10.5, leading: 15, gray: 0.4 },
  ptitle: { size: 16, leading: 22, gray: 0 },
  h2: { size: 13, leading: 18, gray: 0 },
  h3: { size: 12, leading: 17, gray: 0 },
  h4: { size: 11, leading: 16, gray: 0 },
  body: { size: 10.5, leading: 16, gray: 0 },
  code: { size: 9.5, leading: 13, gray: 0.1 },
};

const BLOCK_PAD = 6;
const ASCENT = 0.88; // 基线相对行顶的比例，够用即可

class Layout {
  constructor() {
    this.pages = [];
    this.page = null;
    this.y = 0;
    this.newPage();
  }

  newPage() {
    this.page = new PdfPage();
    this.pages.push(this.page);
    this.y = PAGE_HEIGHT - MARGIN_T;
  }

  ensure(height) {
    if (this.y - height < MARGIN_B) this.newPage();
  }

  /** 单行文本，align: left | center */
  line(text, style, { align = "left", indent = 0 } = {}) {
    const st = typeof style === "string" ? STYLES[style] : style;
    const lines = wrapLine(text, st.size, CONTENT_W - indent);
    for (const ln of lines) {
      this.ensure(st.leading);
      const width = measureText(ln, st.size);
      const x = align === "center"
        ? MARGIN_L + Math.max(0, (CONTENT_W - width) / 2)
        : MARGIN_L + indent;
      this.page.text(x, this.y - st.size * ASCENT, st.size, ln, st.gray);
      this.y -= st.leading;
    }
  }

  /** 带底色块的等宽块（代码、样例） */
  block(text, style, { background }) {
    const st = typeof style === "string" ? STYLES[style] : style;
    const src = String(text ?? "");
    const lines = [];
    for (const raw of src.replace(/\r\n?/g, "\n").split("\n")) {
      lines.push(...wrapLine(raw, st.size, CONTENT_W - BLOCK_PAD * 2));
    }
    const height = lines.length * st.leading + BLOCK_PAD * 2;

    // 块整体比一页还高时不再分页，直接画到底（比截断丢内容好）
    if (height <= PAGE_HEIGHT - MARGIN_T - MARGIN_B) this.ensure(height);

    const top = this.y;
    this.page.rect(MARGIN_L, top - height, CONTENT_W, height, background);
    let cursor = top - BLOCK_PAD;
    for (const ln of lines) {
      this.page.text(MARGIN_L + BLOCK_PAD, cursor - st.size * ASCENT, st.size, ln, st.gray);
      cursor -= st.leading;
    }
    this.y = top - height - 8;
  }

  space(pt) {
    this.y -= pt;
  }

  pageBreak() {
    this.newPage();
  }
}

export function buildContestPdf(contest = {}, problems = []) {
  const L = new Layout();

  L.line(mdInline(contest.name || "竞赛题面"), "title", { align: "center" });
  L.line(
    mdInline(`时间：${contest.startTime || ""} ~ ${contest.endTime || ""}`),
    "meta",
    { align: "center" },
  );
  L.space(6 * MM_TO_PT);

  problems.forEach((p, index) => {
    if (index > 0) L.pageBreak();
    L.line(mdInline(`第 ${index + 1} 题：${p.title || ""}`), "ptitle");
    const time = p.timeMs ?? "";
    const mem = p.memMb ?? "";
    L.line(mdInline(`时间限制 ${time} ms　内存限制 ${mem} MB`), "meta");
    L.space(2 * MM_TO_PT);

    for (const b of toBlocks(p.description || "")) {
      if (b.type === "code") {
        L.block(b.text, "code", { background: 0.96 });
      } else if (b.type === "bullet") {
        L.line(`• ${mdInline(b.text)}`, "body");
      } else {
        L.line(mdInline(b.text), b.type);
      }
    }

    const sampleIn = String(p.sampleIn ?? "").trim();
    const sampleOut = String(p.sampleOut ?? "").trim();
    if (sampleIn) {
      L.line("样例输入", "h3");
      L.block(sampleIn, "code", { background: 0.93 });
    }
    if (sampleOut) {
      L.line("样例输出", "h3");
      L.block(sampleOut, "code", { background: 0.93 });
    }
  });

  return buildPdf(L.pages, { title: contest.name || "contest" });
}
