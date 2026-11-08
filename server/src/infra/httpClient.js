import http from "node:http";
import https from "node:https";

/**
 * 零依赖 HTTP 客户端。
 * 用 node:http/https 而不是 fetch，是因为中间件 8899 用的是自签名证书，
 * 需要 rejectUnauthorized=false；全局关掉 TLS 校验会波及其他请求。
 */
export function request(url, {
  method = "GET", headers = {}, body, timeoutMs = 10000, insecure = false,
} = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, {
      method,
      headers,
      rejectUnauthorized: !insecure,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          buffer: Buffer.concat(chunks),
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function httpJson(url, opts = {}) {
  const hasBody = opts.body !== undefined;
  const res = await request(url, {
    ...opts,
    body: hasBody ? JSON.stringify(opts.body) : undefined,
    headers: hasBody
      ? { "content-type": "application/json", ...(opts.headers || {}) }
      : (opts.headers || {}),
  });
  let data;
  try {
    data = JSON.parse(res.text);
  } catch {
    data = res.text;
  }
  if (res.status >= 400) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
