import Koa from "koa";
import bodyParser from "koa-bodyparser";
import { config } from "./config.js";
import { enablePlugins } from "./core/plugins.js";
import { httpMiddleware } from "./core/http.js";
import { createInfra } from "./infra/index.js";
import { createServices } from "./services/index.js";
import { createRoutes } from "./routes/index.js";
import { sandboxPlugin } from "./plugins/sandbox/index.js";

export async function createApp() {
  const app = new Koa();
  app.config = config;
  enablePlugins(app);

  app.use(httpMiddleware());
  app.use(bodyParser({ enableTypes: ["json"], jsonLimit: "4mb" }));

  // 基础设施全部懒连接：外部服务没起时进程仍能启动并返回 503，而不是直接崩。
  app.infra = createInfra(config);

  // 沙箱是插件：local / mock / remote 任选，业务层只依赖 run() 契约。
  await app.useSandbox(sandboxPlugin, config.sandbox);

  app.services = createServices(app);

  const router = createRoutes(app);
  app.use(router.routes());
  app.use(router.allowedMethods());

  return app;
}
