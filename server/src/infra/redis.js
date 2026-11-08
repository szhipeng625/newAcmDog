import Redis from "ioredis";
import { logger } from "../core/logger.js";

const log = logger.child("redis");

/**
 * 真 Redis（6382）：两类数据
 *   hot:problems  zset  热门题目排行（score = 提交次数）
 *   pdata:<pid>   string 一道题的全部测试文件，JSON + base64
 *   pdata:lru     zset   LRU 时间戳，最多缓存 20 题
 */
export function createRedis(config) {
  const opts = {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password || undefined,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 3000,
  };
  let client = null;

  function get() {
    if (!client) {
      client = new Redis(opts);
      client.on("error", (err) => log.error("redis client error", { error: err }));
    }
    return client;
  }

  async function call(fn, fallback) {
    try {
      return await fn(get());
    } catch (err) {
      log.warn("redis degraded, using fallback", { error: err });
      return fallback;
    }
  }

  return {
    raw: () => get(),

    /** 热门题目：[{ id, hot_score }]，按分数倒序。 */
    async hotProblems(limit = 10) {
      const rows = await call(
        (r) => r.zrevrange("hot:problems", 0, limit - 1, "WITHSCORES"),
        [],
      );
      const out = [];
      for (let i = 0; i < rows.length; i += 2) {
        const id = Number(rows[i]);
        if (Number.isFinite(id)) out.push({ id, hot_score: Math.trunc(Number(rows[i + 1])) });
      }
      return out;
    },

    /** 命中返回 { filename: Buffer }，未命中或 Redis 异常返回 null。 */
    async getProblemData(problemId) {
      return call(async (r) => {
        const raw = await r.get(`pdata:${problemId}`);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        const files = {};
        for (const [name, b64] of Object.entries(obj)) {
          files[name] = Buffer.from(b64, "base64");
        }
        await r.zadd("pdata:lru", Date.now(), String(problemId));
        log.debug("test data cache hit", { problem_id: problemId, files: Object.keys(files).length });
        return files;
      }, null);
    },

    /** 写入并维护 20 题 LRU 淘汰。 */
    async putProblemData(problemId, files) {
      return call(async (r) => {
        const obj = {};
        for (const [name, buf] of Object.entries(files)) {
          obj[name] = Buffer.from(buf).toString("base64");
        }
        await r.set(`pdata:${problemId}`, JSON.stringify(obj));
        await r.zadd("pdata:lru", Date.now(), String(problemId));

        const n = await r.zcard("pdata:lru");
        if (n > config.redis.lruMax) {
          const old = await r.zrange("pdata:lru", 0, n - config.redis.lruMax - 1);
          for (const pid of old) {
            await r.del(`pdata:${pid}`);
            await r.zrem("pdata:lru", pid);
            log.debug("test data cache evicted", { problem_id: pid });
          }
        }
        return true;
      }, false);
    },

    async close() {
      if (client) {
        try { await client.quit(); } catch { /* ignore */ }
        client = null;
      }
    },
  };
}
