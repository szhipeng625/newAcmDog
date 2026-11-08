import { createApp } from "./app.js";
import { config } from "./config.js";
import { logger } from "./core/logger.js";

// 只有进程入口负责打开日志文件：createApp() 被测试或嵌入式调用时不会往磁盘写东西
logger.configure(config.log);
const log = logger.child("server");

const app = await createApp();

app.on("error", (err, ctx) => {
  log.error("koa error", { error: err, path: ctx?.path });
});

const server = app.listen(config.http.port, config.http.host, () => {
  log.info("listening", {
    url: `http://${config.http.host}:${config.http.port}`,
    sandbox: app.sandbox.name,
    languages: app.sandbox.languages.join(","),
    log_level: config.log.level,
    log_format: config.log.format,
    log_file: config.log.dir ? `${config.log.dir}/${config.log.file}` : "disabled",
  });
});

// 结果消费者常驻：把 MQ 里的判题结果写回内存 + MySQL + LSM。
const stopConsumer = app.services.judge.startResultConsumer();

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  log.info("shutting down", { signal });
  try {
    stopConsumer();
    await app.closePlugins();
    await app.infra.close();
  } finally {
    const done = () => {
      logger.close();
      process.exit(0);
    };
    server.close(done);
    setTimeout(done, 5000).unref();
  }
}

// 未捕获的异常必须留下现场再退出，否则容器重启后无从排查
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", {
    error: reason instanceof Error ? reason : new Error(String(reason)),
  });
});
process.on("uncaughtException", (err) => {
  log.error("uncaught exception", { error: err });
  logger.close();
  process.exit(1);
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
