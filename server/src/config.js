// 集中配置：全部可被环境变量覆盖，默认值与原 Python 实现保持一致。
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const str = (v, d) => (v === undefined || v === null || v === "" ? d : String(v));

export const config = {
  http: {
    host: str(process.env.HOST, "127.0.0.1"),
    port: num(process.env.PORT, 18081),
    // 结果在内存里保留多久（原实现 600s）
    resultTtlMs: num(process.env.RESULT_TTL_MS, 600_000),
  },

  mq: {
    url: str(process.env.AMQP_URL, "amqp://127.0.0.1:5672"),
    taskQueue: "oj.judge",
    resultQueue: "oj.judge.result",
    deadQueue: "oj.judge.dead",
    dlx: "oj.judge.dlx",
    prefetch: num(process.env.MQ_PREFETCH, 1),
    heartbeat: 30,
  },

  redis: {
    // 真 Redis：热题缓存 + 测试数据 LRU
    host: str(process.env.REDIS_HOST, "127.0.0.1"),
    port: num(process.env.REDIS_PORT, 6382),
    password: str(process.env.HOT_REDIS_PASSWORD, ""),
    lruMax: 20,
  },

  lsm: {
    // 自研 LSM-KV，只兼容 Redis RESP 协议子集
    host: str(process.env.LSM_HOST, "127.0.0.1"),
    port: num(process.env.LSM_PORT, 6380),
  },

  mysql: {
    host: str(process.env.OJ_DB_HOST, "127.0.0.1"),
    port: num(process.env.OJ_DB_PORT, 3306),
    user: str(process.env.OJ_DB_USER, "oj_user"),
    password: str(process.env.OJ_DB_PASSWORD, ""),
    database: str(process.env.OJ_DB_NAME, "oj"),
    connectionLimit: num(process.env.OJ_DB_POOL, 8),
  },

  filer: {
    base: str(process.env.FILER_BASE, "http://43.157.53.29:8888"),
  },

  middleware: {
    base: str(process.env.MIDDLEWARE_BASE, "https://127.0.0.1:8899"),
  },

  ai: {
    base: str(process.env.AI_BASE, "http://127.0.0.1:18082"),
  },

  anime: {
    base: str(process.env.ANIME_BASE, "http://127.0.0.1:18091"),
  },

  orchestrator: {
    base: str(process.env.ORCHESTRATOR_BASE, "http://127.0.0.1:8890"),
  },

  sandbox: {
    // local | mock | remote。mock 仅用于开发联调，不会真正执行代码。
    driver: str(process.env.SANDBOX_DRIVER, "local"),
    evalWorker: str(process.env.EVAL_WORKER, "/home/admin/eval-worker/build/eval_worker"),
    orchestrator: str(process.env.ORCHESTRATOR_BIN, "/home/admin/eval-worker/build/orchestrator"),
    workRoot: str(process.env.JUDGE_WORK_ROOT, "/tmp"),
    dataRoot: str(process.env.JUDGE_DATA_ROOT, "/tmp/cloud_judge_data"),
    remoteBase: str(process.env.SANDBOX_REMOTE_BASE, ""),
    // 判题时的兜底资源上限
    maxCodeBytes: 256 * 1024,
    maxStreamBytes: 8 * 1024 * 1024,
    cpuMsMin: 100,
    cpuMsMax: 10000,
    memBytesMax: 512 * 1024 * 1024,
  },
};
