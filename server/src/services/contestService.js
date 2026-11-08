import { badRequest, notFound, upstream } from "../core/http.js";
import { buildContestPdf } from "./contestPdf.js";

/**
 * 竞赛服务。
 * 竞赛本体存在业务中间件（8899）里，content 字段是一段 JSON 字符串，
 * 这里负责解析、拼装题目列表、生成 PDF，以及数据准备/清理的控制消息。
 */

/** "2026-05-01 09:00" / "2026-05-01 09:00:00" → 秒级时间戳（服务器本地时区） */
export function parseContestTime(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!m) {
    const ts = Date.parse(text);
    return Number.isFinite(ts) ? Math.trunc(ts / 1000) : null;
  }
  const [, y, mo, d, h, mi, s] = m;
  const ts = new Date(
    Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || 0),
  ).getTime();
  return Number.isFinite(ts) ? Math.trunc(ts / 1000) : null;
}

export function contestSummary(c = {}) {
  return {
    id: c.id,
    name: c.name || "",
    description: c.description || "",
    startTime: c.startTime || "",
    endTime: c.endTime || "",
    startTs: parseContestTime(c.startTime),
    endTs: parseContestTime(c.endTime),
    problems: c.problems || [],
  };
}

export function createContestService(app, { problems }) {
  const { middleware, mq } = app.infra;

  /** 拉全部竞赛并解开 content；任一环节失败都视为上游故障。 */
  async function fetchContests() {
    let raw;
    try {
      raw = await middleware.contests();
    } catch (err) {
      throw upstream(`获取竞赛列表失败: ${err.message}`);
    }
    if (!Array.isArray(raw)) return [];

    const out = [];
    for (const item of raw) {
      let c;
      try {
        c = JSON.parse(item?.content ?? "{}");
      } catch {
        continue; // content 不是合法 JSON 的竞赛直接跳过，避免一条脏数据拖垮整表
      }
      if (!c || typeof c !== "object") continue;
      c.id = item?.id ?? c.id;
      out.push(c);
    }
    return out;
  }

  async function findContest(cid) {
    if (cid === undefined || cid === null || cid === "") throw badRequest("id required");
    const contests = await fetchContests();
    const target = contests.find((c) => String(c.id) === String(cid));
    if (!target) throw notFound("contest not found");
    return target;
  }

  async function list() {
    const contests = await fetchContests();
    return contests.map(contestSummary);
  }

  async function detail(cid) {
    const target = await findContest(cid);
    const summary = contestSummary(target);

    // 题目标题/限制从导航表补齐；查不到的保留占位，保证前端能渲染出格子
    let nav = [];
    try {
      nav = await problems.navList();
    } catch (err) {
      console.warn("[contest] nav list failed:", err.message);
    }
    const byId = new Map(nav.map((p) => [String(p.id), p]));

    summary.problemList = (summary.problems || []).map((pid) => {
      const p = byId.get(String(pid));
      return p
        ? { id: p.id, title: p.title || "", timeMs: p.timeMs, memMb: p.memMb }
        : { id: pid, title: `题目 ${pid}`, timeMs: null, memMb: null };
    });
    summary.serverTs = Date.now() / 1000;
    return summary;
  }

  async function pdf(cid) {
    const target = await findContest(cid);
    const full = [];
    for (const pid of target.problems || []) {
      let p = null;
      try {
        p = await problems.meta(pid);
      } catch (err) {
        console.warn(`[contest] problem ${pid} load failed:`, err.message);
      }
      full.push(p || { id: pid, title: `题目 ${pid}`, description: "" });
    }
    return { contest: target, buffer: buildContestPdf(target, full) };
  }

  async function register(cid, token) {
    if (cid === undefined || cid === null || cid === "") throw badRequest("contestId required");
    try {
      return await middleware.contestRegister({ contestId: cid, virtual: false }, token);
    } catch (err) {
      throw upstream(`报名失败: ${err.message}`);
    }
  }

  async function board(cid) {
    if (cid === undefined || cid === null || cid === "") throw badRequest("cid required");
    try {
      return await middleware.boardRealtime(cid);
    } catch (err) {
      throw upstream(`获取榜单失败: ${err.message}`);
    }
  }

  /**
   * 控制消息走判题队列但不带 task_id，worker 用 task.type 分流。
   * contest_id 统一转字符串，历史实现就是这么发的，消费端按字符串比对。
   */
  async function sendControl(type, cid) {
    await mq.publishTask({ type, contest_id: String(cid) });
  }

  async function dataPrepare(cid) {
    if (!cid) throw badRequest("contestId required");
    await sendControl("contest_data_prepare", cid);
    return { sent: true };
  }

  async function dataCleanup(cid) {
    if (!cid) throw badRequest("contestId required");
    await sendControl("contest_data_cleanup", cid);
    // 榜单落盘失败不影响清理动作本身，只记日志
    try {
      await middleware.boardPersist({ contestId: cid });
    } catch (err) {
      console.warn("[contest] board persist failed:", err.message);
    }
    return { sent: true };
  }

  return { fetchContests, list, detail, pdf, register, board, dataPrepare, dataCleanup };
}
