import { unauthorized } from "../core/http.js";

/**
 * 鉴权服务：登录态一律以业务中间件（8899）的 whoami 为准，
 * 本服务不自己签发/校验 token，避免两套身份体系。
 */
export function createAuthService(app) {
  const { middleware } = app.infra;

  /** 拿不到 token 就直接 401；msg 与原实现的各处提示保持一致。 */
  function requireToken(token, msg) {
    const value = String(token || "").trim();
    if (!value) throw unauthorized(msg);
    return value;
  }

  /** 校验 token 并返回 { username, role }；失效与故障分开报错，便于前端提示。 */
  async function whoami(token) {
    let payload;
    try {
      payload = await middleware.whoami(token);
    } catch (err) {
      throw unauthorized("登录校验失败");
    }
    if (!payload || payload.ok === false || !payload.username) {
      throw unauthorized("登录已失效");
    }
    return { username: payload.username, role: payload.role || "user", raw: payload };
  }

  /** admin/author 可以看别人的东西，普通 user 只能看自己的。 */
  const isPrivileged = (role) => role === "admin" || role === "author";

  return { requireToken, whoami, isPrivileged };
}
