/**
 * 输出比对归一化，与 C++ eval_worker / Python _normalize 保持逐字一致：
 *   1. 去 UTF-8 BOM
 *   2. 删除所有 \r
 *   3. 删除每行行尾的空格和 Tab
 *   4. 删除末尾空行
 * 不忽略行首空白，也不做浮点容差——判题就该是确定的。
 */
export function normalizeText(raw) {
  let s = String(raw ?? "");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.replace(/\r/g, "");
  const lines = s.split("\n").map((line) => line.replace(/[ \t]+$/g, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => l + "\n").join("");
}

export function outputsMatch(actual, expected) {
  return normalizeText(actual) === normalizeText(expected);
}
