export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (msg, extra) => new HttpError(400, msg, extra);
export const unauthorized = (msg = "unauthorized") => new HttpError(401, msg);
export const forbidden = (msg = "forbidden") => new HttpError(403, msg);
export const notFound = (msg = "not found") => new HttpError(404, msg);
export const conflict = (msg, extra) => new HttpError(409, msg, extra);
export const upstream = (msg = "upstream error") => new HttpError(502, msg);

/** 统一错误格式 + CORS，行为与原 ThreadingHTTPServer 实现对齐。 */
export function httpMiddleware() {
  return async (ctx, next) => {
    ctx.set("Access-Control-Allow-Origin", "*");
    ctx.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    ctx.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (ctx.method === "OPTIONS") {
      ctx.status = 204;
      return;
    }

    try {
      await next();
      if (ctx.status === 404 && !ctx.body) {
        // 先赋 body 再压回 404：Koa 的 body setter 会把未显式设置的 404 改成 200
        ctx.body = { error: "not found" };
        ctx.status = 404;
      }
    } catch (err) {
      const status = err.status || 500;
      ctx.status = status;
      ctx.body = { error: err.message || "internal error", ...(err.extra || {}) };
      if (status >= 500) console.error("[http]", ctx.method, ctx.path, err);
    }
  };
}

export function bearerToken(ctx) {
  const header = ctx.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : "";
}
