import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { logger, redactText } from "./logger.js";

/**
 * HTTP 访问日志 + 请求上下文。
 *
 * 放在最外层中间件：它用 AsyncLocalStorage 注入 request_id，
 * 之后所有业务日志（包括被 httpMiddleware 捕获的异常）都会自动带上同一个 id。
 * 支持复用上游传来的 X-Request-ID，便于跨服务串联。
 */
export function accessLog({ slowMs = 1000 } = {}) {
  const log = logger.child("http");

  return async (ctx, next) => {
    // 预检请求没有业务含义，跳过以免刷屏
    if (ctx.method === "OPTIONS") {
      await next();
      return;
    }

    const requestId = ctx.get("x-request-id") || randomUUID().slice(0, 12);
    ctx.state.requestId = requestId;
    ctx.set("X-Request-ID", requestId);

    // 连 finally 里的访问日志也必须在上下文内输出，否则拿不到 request_id
    return logger.runWith({ request_id: requestId }, async () => {
      const start = performance.now();
      let failure = null;

      try {
        await next();
      } catch (err) {
        failure = err;
        throw err;
      } finally {
        const durationMs = Math.round((performance.now() - start) * 100) / 100;
        const status = failure ? (failure.status || 500) : ctx.status;

        const fields = {
          method: ctx.method,
          path: redactText(ctx.originalUrl || ctx.url),
          status,
          duration_ms: durationMs,
          ip: ctx.ip,
        };
        if (Number.isFinite(ctx.response.length)) fields.bytes = ctx.response.length;
        if (durationMs >= slowMs) fields.slow = true;
        if (failure) fields.error = failure;

        const level = status >= 500 ? "error" : status >= 400 || durationMs >= slowMs ? "warn" : "info";
        log[level](status >= 400 ? "request failed" : "request completed", fields);
      }
    });
  };
}
