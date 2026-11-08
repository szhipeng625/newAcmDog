import { HttpError, bearerToken } from "../core/http.js";

/** 登录 / 注册 / 当前用户。身份数据全在业务中间件，这里只做转发和副作用。 */
export default function register(router, app) {
  const { middleware } = app.infra;
  const { ai } = app.services;

  router.post("/api/cloud_login", async (ctx) => {
    const body = ctx.request.body || {};
    let data;
    try {
      data = await middleware.login(body);
    } catch (err) {
      throw new HttpError(401, err.message);
    }
    ctx.body = data;
    // 登录成功后顺手拉起虚拟人账号；失败了也不影响登录
    if (data && (data.ok || data.token) && body.username) ai.vhInit(body.username);
  });

  router.post("/api/cloud_register", async (ctx) => {
    const body = ctx.request.body || {};
    let data;
    try {
      data = await middleware.register(body);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    ctx.body = data;
    if (data && (data.ok || data.token) && body.username) ai.vhInit(body.username);
  });

  router.get("/api/cloud_whoami", async (ctx) => {
    const token = bearerToken(ctx) || String(ctx.query.token || "");
    try {
      ctx.body = await middleware.whoami(token);
    } catch (err) {
      throw new HttpError(401, err.message);
    }
  });
}
