import { httpJson, request } from "./httpClient.js";

/**
 * 业务中间件（8899）：登录鉴权、竞赛、榜单、题目与测试点回退。
 * 用自签名证书，所以统一 insecure=true。
 */
export function createMiddleware(config) {
  const base = String(config.middleware.base).replace(/\/+$/, "");
  const opts = (extra = {}) => ({ timeoutMs: 10000, insecure: true, ...extra });

  const withToken = (token) => (token ? { authorization: `Bearer ${token}` } : {});

  /**
   * 登录/注册不抛错：中间件用 4xx + {ok:false,error} 表达业务失败，
   * 这对前端是"正常响应"，必须原样透传而不是变成网关错误。
   */
  async function postRaw(path, body) {
    const res = await request(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      timeoutMs: 10000,
      insecure: true,
    });
    try {
      return JSON.parse(res.text);
    } catch {
      return { ok: false, error: res.text || `HTTP ${res.status}` };
    }
  }

  return {
    base,
    whoami: (token) =>
      httpJson(`${base}/api/whoami?token=${encodeURIComponent(token)}`, opts()),

    login: (body) => postRaw("/api/login", body),
    register: (body) => postRaw("/api/register", body),

    contests: () => httpJson(`${base}/api/contests`, opts()),

    submitScore: (body, token) =>
      httpJson(`${base}/api/submit`, opts({ method: "POST", body, headers: withToken(token) })),

    contestRegister: (body, token) =>
      httpJson(`${base}/api/contest/register`, opts({ method: "POST", body, headers: withToken(token) })),

    boardRealtime: (cid) => httpJson(`${base}/api/board/realtime?cid=${encodeURIComponent(cid)}`, opts()),

    boardPersist: (body) => httpJson(`${base}/api/board/persist`, opts({ method: "POST", body })),

    problem: (pid) => httpJson(`${base}/api/problem?id=${encodeURIComponent(pid)}`, opts()),

    testcases: (pid) => httpJson(`${base}/api/testcases?problemId=${encodeURIComponent(pid)}`, opts()),
  };
}
