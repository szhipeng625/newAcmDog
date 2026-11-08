import { createMq } from "./mq.js";
import { createRedis } from "./redis.js";
import { createLsm } from "./lsm.js";
import { createMysql } from "./mysql.js";
import { createFiler } from "./filer.js";
import { createMiddleware } from "./middleware.js";

/**
 * 基础设施聚合。全部懒连接：任何外部服务没起，进程仍能启动，
 * 具体调用时才失败——副作用是本地开发不用先起一整套中间件。
 */
export function createInfra(config) {
  const infra = {
    config,
    mq: createMq(config),
    redis: createRedis(config),
    lsm: createLsm(config),
    mysql: createMysql(config),
    filer: createFiler(config),
    middleware: createMiddleware(config),
  };

  infra.close = async () => {
    await Promise.allSettled([
      infra.mq.close(),
      infra.redis.close(),
      infra.mysql.close(),
    ]);
  };

  return infra;
}
