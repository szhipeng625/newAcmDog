/**
 * 极简 PDF 生成器（无第三方依赖）。
 *
 * 只为一件事存在：把竞赛题面导成 PDF。中文用 Adobe 预定义 CID 字体
 * STSong-Light + UniGB-UCS2-H（正是原 Python 实现 reportlab 的
 * UnicodeCIDFont 做法，不嵌字体、不依赖本机字体文件）；拉丁字符改用
 * Helvetica 按真实字宽绘制，避免中文全角宽度把英文撑成 "A + B"。
 */

const MM = 2.834645669; // 1mm = 2.8346pt

export const PAGE_WIDTH = 210 * MM;
export const PAGE_HEIGHT = 297 * MM;

// Helvetica AFM 字宽（ASCII 0x20..0x7E，单位 1/1000 em）
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const isAscii = (cp) => cp >= 0x20 && cp <= 0x7e;

/** 文本宽度（pt）：ASCII 走 Helvetica 比例宽度，其余按中文全角 1000/1000 em。 */
export function measureText(text, size) {
  let units = 0;
  for (const ch of String(text ?? "")) {
    const cp = ch.codePointAt(0);
    units += isAscii(cp) ? HELVETICA_WIDTHS[cp - 0x20] : 1000;
  }
  return (units / 1000) * size;
}

const escapeLiteral = (s) => s.replace(/[\\()]/g, (m) => `\\${m}`);

/** 把一行按"连续 ASCII / 连续非 ASCII"切段，分别用 F2 / F1 绘制。 */
function segments(text) {
  const out = [];
  let buf = "";
  let ascii = null;
  for (const ch of String(text ?? "")) {
    const flag = isAscii(ch.codePointAt(0));
    if (ascii !== null && flag !== ascii) {
      out.push({ ascii, text: buf });
      buf = "";
    }
    ascii = flag;
    buf += ch;
  }
  if (buf) out.push({ ascii, text: buf });
  return out;
}

const num = (v) => {
  const s = Number(v).toFixed(2);
  return s.replace(/\.?0+$/, "") || "0";
};

/** 文本 → UTF-16BE 十六进制串（UniGB-UCS2-H 只认 UCS-2，增补平面降级为 ?） */
export function utf16Hex(text) {
  let out = "";
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    out += (cp > 0xffff ? 0x3f : cp).toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

export class PdfPage {
  constructor(width = PAGE_WIDTH, height = PAGE_HEIGHT) {
    this.width = width;
    this.height = height;
    this.ops = [];
  }

  /** 底色块（代码块/样例块） */
  rect(x, y, w, h, gray = 0.96) {
    this.ops.push(`q ${num(gray)} g ${num(x)} ${num(y)} ${num(w)} ${num(h)} re f Q`);
  }

  text(x, y, size, content, gray = 0) {
    let cursor = x;
    for (const seg of segments(content)) {
      const payload = seg.ascii
        ? `(${escapeLiteral(seg.text)})`
        : `<${utf16Hex(seg.text)}>`;
      this.ops.push(
        `BT /${seg.ascii ? "F2" : "F1"} ${num(size)} Tf ${num(gray)} g `
        + `1 0 0 1 ${num(cursor)} ${num(y)} Tm ${payload} Tj ET`,
      );
      cursor += measureText(seg.text, size);
    }
  }

  stream() {
    return this.ops.join("\n");
  }
}

/**
 * 组装 PDF 字节。
 * 对象布局：1 目录 / 2 页面树 / 3 F1 Type0 / 4 CIDFont / 5 字体描述
 *          / 6 元信息 / 7 F2 Helvetica，之后每页两个对象：内容流 + 页面对象。
 */
export function buildPdf(pages, { title = "contest" } = {}) {
  const list = pages.length ? pages : [new PdfPage()];
  const chunks = [];
  let size = 0;
  const offsets = [];

  const push = (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1");
    chunks.push(buf);
    size += buf.length;
  };
  const beginObj = (id) => {
    offsets[id] = size;
    push(`${id} 0 obj\n`);
  };
  const endObj = () => push("endobj\n");

  // PDF 头带 4 个 >127 的字节，标明这是二进制文件（否则某些工具会当纯文本处理）
  push(Buffer.concat([Buffer.from("%PDF-1.4\n%", "latin1"), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3]), Buffer.from("\n", "latin1")]));

  const pageId = (i) => 8 + i * 2;
  const contentId = (i) => 9 + i * 2;

  beginObj(1);
  push("<< /Type /Catalog /Pages 2 0 R >>\n");
  endObj();

  beginObj(2);
  push(`<< /Type /Pages /Count ${list.length} /Kids [${list.map((_, i) => `${pageId(i)} 0 R`).join(" ")}] >>\n`);
  endObj();

  beginObj(3);
  push("<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>\n");
  endObj();

  beginObj(4);
  push(
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light "
    + "/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> "
    + "/FontDescriptor 5 0 R /DW 1000 >>\n",
  );
  endObj();

  beginObj(5);
  push(
    "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 "
    + "/FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>\n",
  );
  endObj();

  beginObj(6);
  push(`<< /Title <${utf16Hex(title)}> /Producer (acmdog-server) /Creator (acmdog-server) >>\n`);
  endObj();

  beginObj(7);
  push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n");
  endObj();

  list.forEach((page, i) => {
    const body = page.stream();
    beginObj(contentId(i));
    push(`<< /Length ${Buffer.byteLength(body, "latin1")} >>\nstream\n`);
    push(body);
    push("\nendstream\n");
    endObj();

    beginObj(pageId(i));
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] `
      + `/Resources << /Font << /F1 3 0 R /F2 7 0 R >> >> /Contents ${contentId(i)} 0 R >>\n`,
    );
    endObj();
  });

  const maxId = contentId(list.length - 1);
  const xrefStart = size;
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id += 1) {
    xref += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size ${maxId + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

export const MM_TO_PT = MM;
