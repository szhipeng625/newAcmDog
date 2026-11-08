import { badRequest, forbidden, notFound } from "../core/http.js";
import { logger } from "../core/logger.js";
import { makeStoreKey } from "./judgeService.js";

const log = logger.child("submission");

/**
 * 提交记录服务：列表 / 测试点明细 / 完整详情。
 * 数据在 MySQL（submit + judge + judge_run），实时进度在内存（resultHub）。
 */
export function createSubmissionService(app, { resultHub, auth }) {
  const { mysql } = app.infra;

  const str = (v) => (v === null || v === undefined ? v : String(v));

  /** submit_time / judge_time 是 DATETIME，转成字符串给前端，避免时区歧义。 */
  function stringifyDates(row, keys) {
    for (const k of keys) {
      if (row[k] !== null && row[k] !== undefined) row[k] = String(row[k]);
    }
    return row;
  }

  async function judgeStatusList({ problemId, limit = 50, username = "" }, token) {
    if (!problemId) throw badRequest("problem_id required");
    const pid = Number(problemId);
    if (!Number.isFinite(pid)) throw badRequest("invalid problem_id");

    const take = Math.max(1, Math.min(Number(limit) || 50, 200));

    const me = await auth.whoami(auth.requireToken(token, "需登录后查看提交记录"));

    // 普通用户强制只看自己，忽略前端传的 username
    const target = auth.isPrivileged(me.role) ? (username || "") : me.username;

    let sql = "SELECT s.id, s.task_id, s.username, s.problem_id, s.problem_name, "
      + "s.language, s.status AS submit_status, s.submit_time, "
      + "j.status AS judge_status, j.ac_count, j.total_cases, j.cpu_ms, j.mem_mb, j.judge_time "
      + "FROM submit s LEFT JOIN judge j ON j.submit_id = s.id "
      + "WHERE s.problem_id = ?";
    const args = [pid];
    if (target) {
      sql += " AND s.username = ?";
      args.push(target);
    }
    sql += " ORDER BY s.id DESC LIMIT ?";
    args.push(take);

    const rows = await mysql.query(sql, args);
    return rows.map((row) => stringifyDates({ ...row }, ["submit_time", "judge_time"]));
  }

  /**
   * 判题中的实时进度：内存里最后一条事件可能是
   *   - 后端 worker 自己推的 { done_cases, total_cases }
   *   - Python worker 经 MQ 推的 { progress, point_idx, total }
   * 两种都要能拼出"已判完 / 正在判 / 排队中"的力扣式列表。
   */
  function liveProgress(taskId, rows) {
    const evt = resultHub.latest(taskId);
    if (!evt || evt.status !== "judging") return null;

    const total = Number(evt.total_cases ?? evt.total ?? 0);
    if (!total) return null;

    const done = new Set(rows.map((r) => Number(r.case_index) || 0));
    const current = evt.point_idx !== undefined && evt.point_idx !== null
      ? Number(evt.point_idx) + 1
      : Number(evt.done_cases ?? 0) + 1;

    const cases = rows.slice();
    if (total > cases.length) {
      for (let i = cases.length + 1; i <= total; i += 1) {
        cases.push({
          case_index: i,
          case_name: `#${i}`,
          status: i === current && !done.has(i) ? "running" : "queued",
          cpu_ms: null,
          error: "",
        });
      }
      cases.sort((a, b) => (Number(a.case_index) || 0) - (Number(b.case_index) || 0));
    }

    const progress = evt.progress !== undefined && evt.progress !== null
      ? evt.progress
      : (Number(evt.done_cases ?? 0) / total);

    return { judging: true, progress, total, cases };
  }

  async function caseRows(taskId) {
    return mysql.query(
      "SELECT case_index, case_name, status, cpu_ms, error "
      + "FROM judge_run WHERE task_id = ? ORDER BY case_index ASC",
      [taskId],
    );
  }

  async function judgeStatusDetail({ taskId }, token) {
    if (!taskId) throw badRequest("task_id required");
    const me = await auth.whoami(auth.requireToken(token, "需登录后查看测试详情"));

    if (!auth.isPrivileged(me.role)) {
      const owner = await mysql.query(
        "SELECT username FROM submit WHERE task_id = ? LIMIT 1",
        [taskId],
      );
      if (!owner.length || owner[0].username !== me.username) {
        throw forbidden("无权查看他人提交详情");
      }
    }

    const rows = await caseRows(taskId);
    const live = liveProgress(taskId, rows);
    return live || rows;
  }

  async function submissionDetail({ taskId }, token) {
    if (!taskId) throw badRequest("task_id required");
    const me = await auth.whoami(auth.requireToken(token, "需登录后查看提交详情"));

    const rows = await mysql.query(
      "SELECT s.id, s.task_id, s.username, s.problem_id, s.problem_name, "
      + "s.language, s.status AS submit_status, s.submit_time, s.code, "
      + "j.status AS judge_status, j.ac_count, j.total_cases, j.cpu_ms, j.mem_mb, j.error "
      + "FROM submit s LEFT JOIN judge j ON j.submit_id = s.id "
      + "WHERE s.task_id = ? LIMIT 1",
      [taskId],
    );
    if (!rows.length) throw notFound("提交不存在");

    const item = stringifyDates({ ...rows[0] }, ["submit_time"]);
    // 源码只对本人/特权角色可见
    if (!auth.isPrivileged(me.role) && item.username !== me.username) {
      throw forbidden("无权查看他人提交源码");
    }

    item.cases = await caseRows(taskId);

    // 对象存储登记信息（唯一提交编号 + 存储位置），失败不影响主内容
    try {
      const key = makeStoreKey(item.username || "", item.code || "");
      const reg = await mysql.query(
        "SELECT submission_no, obj_uri FROM submission_store WHERE store_key = ? LIMIT 1",
        [key],
      );
      if (reg.length) {
        item.submission_no = str(reg[0].submission_no);
        item.obj_uri = str(reg[0].obj_uri);
      }
    } catch (err) {
      log.warn("submission store lookup failed", { task_id: taskId, error: err });
    }

    return item;
  }

  return { judgeStatusList, judgeStatusDetail, submissionDetail };
}
