import { httpJson, request } from "./httpClient.js";

/**
 * SeaweedFS Filer（对象存储）。
 * 题面：GET /problems/{pid}.json
 * 测试数据：GET /problem_data/{pid}/?limit=500 列出，再逐个下载
 */
export function createFiler(config) {
  const base = String(config.filer.base).replace(/\/+$/, "");

  function entriesOf(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.Entries)) return payload.Entries;
    if (payload && Array.isArray(payload.Files)) return payload.Files;
    return [];
  }

  const nameOf = (entry) => entry?.Name || entry?.name || String(entry?.FullPath || "").split("/").pop();

  return {
    async problemJson(pid) {
      return httpJson(`${base}/problems/${pid}.json`, { timeoutMs: 8000 });
    },

    async listProblemData(pid) {
      const payload = await httpJson(`${base}/problem_data/${pid}/?limit=500`, { timeoutMs: 8000 });
      return entriesOf(payload).map(nameOf).filter(Boolean);
    },

    async download(pid, filename) {
      const res = await request(
        `${base}/problem_data/${pid}/${encodeURIComponent(filename)}`,
        { timeoutMs: 15000 },
      );
      if (res.status >= 400) throw new Error(`filer ${filename} -> HTTP ${res.status}`);
      return res.buffer;
    },
  };
}
