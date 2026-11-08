import amqp from "amqplib";

/**
 * RabbitMQ 封装。
 * - 懒连接：MQ 没起来时 HTTP 服务仍可启动，调用时才报错。
 * - 发布走 confirm channel，等 broker 确认后才算成功。
 * - 队列声明沿用原参数：durable + 死信路由到 oj.judge.dead。
 */
export function createMq(config) {
  let connPromise = null;
  let pubChannelPromise = null;

  async function getConnection() {
    if (!connPromise) {
      connPromise = amqp.connect(config.mq.url, { heartbeat: config.mq.heartbeat })
        .then((conn) => {
          conn.on("error", (err) => console.error("[mq] connection error:", err.message));
          conn.on("close", () => { connPromise = null; pubChannelPromise = null; });
          return conn;
        })
        .catch((err) => { connPromise = null; throw err; });
    }
    return connPromise;
  }

  async function getPublishChannel() {
    if (!pubChannelPromise) {
      pubChannelPromise = (async () => {
        const conn = await getConnection();
        const ch = await conn.createConfirmChannel();
        await ch.assertExchange(config.mq.dlx, "direct", { durable: true });
        await ch.assertQueue(config.mq.deadQueue, { durable: true });
        await ch.bindQueue(config.mq.deadQueue, config.mq.dlx, config.mq.deadQueue);
        await ch.assertQueue(config.mq.resultQueue, { durable: true });
        await ch.assertQueue(config.mq.taskQueue, {
          durable: true,
          arguments: {
            "x-dead-letter-exchange": config.mq.dlx,
            "x-dead-letter-routing-key": config.mq.deadQueue,
          },
        }).catch((err) => {
          // 队列已存在但参数不同：保持现状，绝不为了统一配置删队列丢消息
          console.warn("[mq] task queue declared without DLX args:", err.message);
        });
        return ch;
      })().catch((err) => { pubChannelPromise = null; throw err; });
    }
    return pubChannelPromise;
  }

  async function publish(queue, message) {
    const ch = await getPublishChannel();
    await new Promise((resolve, reject) => {
      ch.publish("", queue, Buffer.from(JSON.stringify(message)), {
        persistent: true,
        contentType: "application/json",
      }, (err) => (err ? reject(err) : resolve()));
    });
  }

  return {
    publishTask: (task) => publish(config.mq.taskQueue, task),
    publish: (queue, message) => publish(queue, message),

    /** 通用消费：handler 抛错会 nack 且不 requeue（避免毒丸循环）。 */
    async consume(queueName, handler) {
      const conn = await getConnection();
      const ch = await conn.createChannel();
      await ch.assertQueue(queueName, { durable: true });
      await ch.prefetch(config.mq.prefetch);
      await ch.consume(queueName, async (msg) => {
        if (!msg) return;
        try {
          await handler(JSON.parse(msg.content.toString("utf8")));
          ch.ack(msg);
        } catch (err) {
          console.error(`[mq] handler for ${queueName} failed:`, err.message);
          ch.nack(msg, false, false);
        }
      });
      return async () => {
        try { await ch.close(); } catch { /* already closed */ }
      };
    },

    /** 消费结果队列。 */
    consumeResults(handler) {
      return this.consume(config.mq.resultQueue, handler);
    },

    async close() {
      pubChannelPromise = null;
      if (connPromise) {
        try {
          const conn = await connPromise;
          await conn.close();
        } catch { /* ignore */ }
        connPromise = null;
      }
    },
  };
}
