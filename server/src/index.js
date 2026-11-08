import { createApp } from "./app.js";
import { config } from "./config.js";

const app = await createApp();

const server = app.listen(config.http.port, config.http.host, () => {
  console.log(`[acmdog] listening on http://${config.http.host}:${config.http.port}`);
  console.log(`[acmdog] sandbox driver = ${app.sandbox.name} (${app.sandbox.languages.join(",")})`);
});

// 结果消费者常驻：把 MQ 里的判题结果写回内存 + MySQL + LSM。
const stopConsumer = app.services.judge.startResultConsumer();

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[acmdog] ${signal} received, shutting down...`);
  try {
    stopConsumer();
    await app.closePlugins();
    await app.infra.close();
  } finally {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
