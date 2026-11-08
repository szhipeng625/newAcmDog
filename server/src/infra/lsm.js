import net from "node:net";
import { logger } from "../core/logger.js";

const log = logger.child("lsm");

/**
 * LSM-KV 客户端（6380）。
 * 注意：6380 不是 Redis，是自研 LSM 存储，只是实现了 Redis RESP 协议子集，
 * 所以这里没有用 ioredis，而是手写一个最小 RESP 编解码器。
 */
export function encode(...args) {
  let out = `*${args.length}\r\n`;
  for (const arg of args) {
    const buf = Buffer.isBuffer(arg) ? arg : Buffer.from(String(arg), "utf8");
    out += `$${buf.length}\r\n`;
    out += buf.toString("binary") + "\r\n";
  }
  return Buffer.from(out, "binary");
}

/** 增量解析：数据不完整返回 null，完整返回 { value, next }。 */
export function parseValue(buf, offset = 0) {
  if (offset >= buf.length) return null;
  const type = String.fromCharCode(buf[offset]);
  const nl = buf.indexOf("\r\n", offset, "binary");
  if (nl < 0) return null;

  if (type === "$") {
    const len = parseInt(buf.subarray(offset + 1, nl).toString(), 10);
    if (len === -1) return { value: null, next: nl + 2 };
    const start = nl + 2;
    if (buf.length < start + len + 2) return null;
    return { value: buf.subarray(start, start + len).toString("utf8"), next: start + len + 2 };
  }

  if (type === "*") {
    const count = parseInt(buf.subarray(offset + 1, nl).toString(), 10);
    if (count === -1) return { value: null, next: nl + 2 };
    let pos = nl + 2;
    const arr = [];
    for (let i = 0; i < count; i += 1) {
      const item = parseValue(buf, pos);
      if (!item) return null;
      arr.push(item.value);
      pos = item.next;
    }
    return { value: arr, next: pos };
  }

  const text = buf.subarray(offset + 1, nl).toString("utf8");
  if (type === ":") return { value: parseInt(text, 10), next: nl + 2 };
  if (type === "-") return { value: { __error__: text }, next: nl + 2 };
  return { value: text, next: nl + 2 };
}

export function createLsm(config) {
  function cmd(...args) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: config.lsm.host, port: config.lsm.port });
      let buffer = Buffer.alloc(0);
      let done = false;

      const finish = (value) => {
        if (done) return;
        done = true;
        sock.destroy();
        resolve(value);
      };

      sock.setTimeout(5000, () => finish(null));
      sock.on("connect", () => sock.write(encode(...args)));
      sock.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const parsed = parseValue(buffer, 0);
        if (parsed) finish(parsed.value);
      });
      sock.on("end", () => finish(parseValue(buffer, 0)?.value ?? null));
      sock.on("error", reject);
    });
  }

  const SEQ_KEY = "oj:submission:seq";
  const IDX_KEY = "oj:submissions";
  const REC_PREFIX = "oj:submission:";

  const STATUS_MAP = {
    AC: "correct",
    WA: "wrong-answer",
    TLE: "timelimit",
    CE: "compiler-error",
    RE: "run-error",
    SE: "run-error",
  };

  const mapStatus = (status) => STATUS_MAP[String(status || "").toUpperCase()] || "run-error";

  async function nextId() {
    const v = await cmd("INCR", SEQ_KEY);
    return Number.isInteger(v) ? v : 1;
  }

  async function saveRecord(rec) {
    const sid = String(rec.submitid);
    const r1 = await cmd("SET", REC_PREFIX + sid, JSON.stringify(rec));
    const r2 = await cmd("ZADD", IDX_KEY, sid, sid);
    return r1 === "OK" && !(r2 && r2.__error__);
  }

  async function loadRecord(sid) {
    const raw = await cmd("GET", REC_PREFIX + String(sid));
    if (!raw || typeof raw !== "string") return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function listRecords() {
    const ids = await cmd("ZRANGE", IDX_KEY, "0", "-1");
    if (!Array.isArray(ids)) return [];
    const out = [];
    for (const id of ids) {
      const rec = await loadRecord(id);
      if (rec) out.push(rec);
    }
    return out;
  }

  /** 把一次判题结果落成提交记录（对应 Python lsm_store.save_from_result）。 */
  async function saveFromResult(result, existing = {}) {
    const status = result.status;
    if (!status || status === "judging" || status === "pending") return null;

    const rec = {
      submitid: await nextId(),
      username: result.username || existing.username || "",
      problem_id: result.problem_id || 0,
      problem_name: result.problem || existing.problem || "",
      language: existing.language || "",
      status,
      result: mapStatus(status),
      time_ms: result.cpu_ns ? Math.trunc(result.cpu_ns / 1e6) : 0,
      mem_bytes: result.mem_bytes || 0,
      submittime: Math.trunc(existing.submittime || Date.now() / 1000),
      contest_id: existing.contest_id || 0,
      ac_count: result.ac_count || 0,
      total_cases: result.total_cases || 0,
      error: String(result.error || "").slice(0, 200),
    };

    const ok = await saveRecord(rec);
    log.info("submission persisted", { submitid: rec.submitid, status });
    return ok ? rec : null;
  }

  return { cmd, nextId, saveRecord, loadRecord, listRecords, saveFromResult, mapStatus };
}
