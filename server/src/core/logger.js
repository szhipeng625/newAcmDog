import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 统一日志。
 *
 * 设计取舍：
 * - 文件写入用持久 fd + writeSync，不用 createWriteStream。日志行很小，
 *   同步追加省掉了流缓冲与轮转时丢日志的麻烦，也不会因日志失败拖垮请求。
 * - 上下文用 AsyncLocalStorage：HTTP 中间件注入 requestId、判题链路注入 taskId，
 *   业务代码不用层层传参就能把一次请求/一次判题的日志串起来。
 * - 默认脱敏：token / 密码 / 源码等字段不进日志，日志绝不能成为泄漏面。
 */

export const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

const DEFAULTS = Object.freeze({
  level: "info",
  format: "text",       // text | json
  console: true,
  dir: "",              // 空 = 不写文件；由进程入口按配置打开
  file: "server.log",
  maxBytes: 10 * 1024 * 1024,
  maxFiles: 5,
  sink: null,           // 可选回调 (level, line, record)，便于测试或接外部采集
});

const SENSITIVE_KEYS = new Set([
  "token", "password", "passwd", "pwd", "secret", "authorization", "cookie",
  "apikey", "api_key", "privatekey", "private_key", "accesskey", "access_key",
  "code", "source", "sourcecode", "source_code", "body", "payload",
]);
const SENSITIVE_KEY_RE = /token|password|passwd|secret|credential|bearer|privatekey/i;
const MAX_STRING = 2000;

function truncate(value) {
  const s = String(value);
  return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…(truncated)` : s;
}

/** 清掉字符串里夹带的凭据（Bearer 头、URL 查询参数、JSON 片段）。 */
export function redactText(value) {
  return truncate(String(value ?? ""))
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer ***")
    .replace(/([?&](?:token|password|passwd|secret|key|authorization)=)[^&\s]+/gi, "$1***")
    .replace(/"(token|password|passwd|secret|code|source)"\s*:\s*"[^"]*"/gi, '"$1":"***"')
    .replace(/\r?\n/g, " \\n ");
}

function isSensitiveKey(key) {
  const normalized = String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
  return SENSITIVE_KEYS.has(normalized) || SENSITIVE_KEY_RE.test(normalized);
}

/** 深度脱敏 + 截断，带环检测和深度上限，避免把 4MB 源码或一个循环对象写进日志。 */
export function redactValue(value, depth = 0, seen = new WeakSet(), withStack = false) {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    const out = { name: value.name, message: redactText(value.message) };
    if (withStack && value.stack) out.stack = truncate(value.stack).replace(/\r?\n/g, " | ");
    return out;
  }
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function") return "[function]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  if (depth >= 3) return "[object]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redactValue(item, depth + 1, seen, withStack));
  }
  const out = {};
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (count >= 40) { out.__more__ = true; break; }
    out[key] = isSensitiveKey(key) ? "***" : redactValue(item, depth + 1, seen, withStack);
    count += 1;
  }
  return out;
}

export function formatRecord(record, format) {
  if (format === "json") return `${JSON.stringify(record)}\n`;
  const { ts, level, module, message, ...rest } = record;
  const tail = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
  return `${ts} ${level.toUpperCase().padEnd(5)} [${module}] ${message}${tail}\n`;
}

export function shouldLog(level, minLevel) {
  return (LEVELS[level] ?? LEVELS.info) >= (LEVELS[minLevel] ?? LEVELS.info);
}

const als = new AsyncLocalStorage();

export function createLogger(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const minLevel = LEVELS[opts.level] ? opts.level : "info";
  const format = opts.format === "json" ? "json" : "text";
  const filePath = opts.dir ? path.resolve(opts.dir, opts.file) : "";

  let fd = null;
  let fileEnabled = Boolean(filePath);

  function openFile() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fd = fs.openSync(filePath, "a");
  }

  function rotate() {
    if (fd !== null) { fs.closeSync(fd); fd = null; }
    for (let i = opts.maxFiles - 1; i >= 1; i -= 1) {
      const from = `${filePath}.${i}`;
      const to = `${filePath}.${i + 1}`;
      if (!fs.existsSync(from)) continue;
      if (fs.existsSync(to)) fs.unlinkSync(to); // Windows 上 rename 不允许目标已存在
      fs.renameSync(from, to);
    }
    if (fs.existsSync(`${filePath}.1`)) fs.unlinkSync(`${filePath}.1`);
    if (fs.existsSync(filePath)) fs.renameSync(filePath, `${filePath}.1`);
    fd = fs.openSync(filePath, "a");
  }

  function writeFile(line) {
    if (!fileEnabled) return;
    try {
      if (fd === null) openFile();
      // 写之前检查：宁可当前文件略微超过，也不把一行日志劈成两半。
      // size>0 的保护避免单行就超过 maxBytes 时每条日志都触发一次轮转。
      const size = fs.fstatSync(fd).size;
      if (size > 0 && size + Buffer.byteLength(line) > opts.maxBytes) rotate();
      fs.writeSync(fd, line);
    } catch (err) {
      // 日志IO 故障只降级，绝不让业务跟着崩
      fileEnabled = false;
      try { if (fd !== null) fs.closeSync(fd); } catch { /* ignore */ }
      fd = null;
      process.stderr.write(`[logger] file sink disabled: ${err.message}\n`);
    }
  }

  function emit(level, module, message, fields) {
    if (!shouldLog(level, minLevel)) return;

    const context = als.getStore() || {};
    const record = {
      ts: new Date().toISOString(),
      level,
      module: module || "app",
      message: redactText(message),
    };
    for (const [key, value] of Object.entries(context)) {
      if (value !== undefined && value !== null && value !== "") record[key] = value;
    }

    if (fields instanceof Error) fields = { error: fields };
    if (fields && typeof fields === "object") {
      const withStack = level === "error" || format === "json";
      for (const [key, value] of Object.entries(fields)) {
        record[key] = isSensitiveKey(key) ? "***" : redactValue(value, 0, new WeakSet(), withStack);
      }
    }

    const line = formatRecord(record, format);

    if (opts.console) {
      const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
      stream.write(line);
    }
    writeFile(line);
    if (typeof opts.sink === "function") {
      try { opts.sink(level, line, record); } catch { /* 采集端故障不影响主流程 */ }
    }
  }

  return {
    emit,
    runWith(context, fn) {
      return als.run({ ...(als.getStore() || {}), ...context }, fn);
    },
    setContext(context) {
      const store = als.getStore();
      if (store) Object.assign(store, context);
    },
    getContext() {
      return { ...(als.getStore() || {}) };
    },
    close() {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        fd = null;
      }
    },
    get options() { return { ...opts }; },
  };
}

let active = createLogger();

/** 稳定的代理：模块顶层 import 后，configure() 换掉底层实现也照样生效。 */
function makeChild(name) {
  const at = (level) => (message, fields) => active.emit(level, name, message, fields);
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: (childName) => makeChild(childName),
  };
}

export const logger = {
  ...makeChild("app"),
  child: (name) => makeChild(name),
  configure(options = {}) {
    active.close();
    active = createLogger(options);
    return active;
  },
  create: createLogger,
  runWith: (context, fn) => active.runWith(context, fn),
  setContext: (context) => active.setContext(context),
  getContext: () => active.getContext(),
  close: () => active.close(),
  get level() { return active.options.level; },
};
