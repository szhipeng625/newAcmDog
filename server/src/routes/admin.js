import { HttpError, badRequest, unauthorized } from "../core/http.js";
import { logger } from "../core/logger.js";

const log = logger.child("admin");

export default function register(router, app) {
  const mysql = app.infra.mysql;
  const auth = app.services.auth;

  async function requireStaff(ctx) {
    const raw = String(ctx.headers.authorization || "");
    const token = raw.replace(/^Bearer\s+/i, "").trim();
    if (!token) throw unauthorized("need login");
    let me;
    try {
      me = await auth.whoami(token);
    } catch (err) {
      throw unauthorized("login expired");
    }
    if (me.role !== "admin" && me.role !== "author") throw new HttpError(403, "need admin or author");
    return me;
  }

  async function requireAdmin(ctx) {
    const raw = String(ctx.headers.authorization || "");
    const token = raw.replace(/^Bearer\s+/i, "").trim();
    if (!token) throw unauthorized("need login");
    let me;
    try {
      me = await auth.whoami(token);
    } catch (err) {
      throw unauthorized("login expired");
    }
    if (me.role !== "admin") throw new HttpError(403, "need admin");
    return me;
  }

  router.get("/api/admin/users", async (ctx) => {
    await requireAdmin(ctx);
    const kw = String(ctx.query.keyword || "");
    const limit = Math.max(1, Math.min(Number(ctx.query.limit) || 50, 200));
    let sql = "SELECT id, username, nickname, role, email, school, created_at FROM users";
    const args = [];
    if (kw) {
      sql += " WHERE username LIKE ? OR nickname LIKE ?";
      args.push("%".concat(kw, "%"), "%".concat(kw, "%"));
    }
    sql += " ORDER BY id DESC LIMIT ?";
    args.push(limit);
    const rows = await mysql.query(sql, args);
    ctx.body = rows.map((r) => Object.assign({}, r, { created_at: String(r.created_at) }));
  });

  router.post("/api/admin/users/role", async (ctx) => {
    await requireAdmin(ctx);
    const body = ctx.request.body || {};
    const id = body.id;
    const role = body.role;
    if (!id || ["admin", "author", "user"].indexOf(role) === -1) throw badRequest("invalid id or role");
    await mysql.query("UPDATE users SET role = ? WHERE id = ?", [role, id]);
    ctx.body = { ok: true };
  });

  router.get("/api/admin/problems", async (ctx) => {
    await requireStaff(ctx);
    const limit = Math.max(1, Math.min(Number(ctx.query.limit) || 100, 500));
    const rows = await mysql.query(
      "SELECT id, title, difficulty, time_ms, mem_mb, is_public, tags, updated_at FROM problems ORDER BY id DESC LIMIT ?",
      [limit],
    );
    ctx.body = rows.map((r) => Object.assign({}, r, { updated_at: String(r.updated_at) }));
  });

  router.post("/api/admin/problems/toggle_public", async (ctx) => {
    await requireStaff(ctx);
    const body = ctx.request.body || {};
    const id = body.id;
    const isPublic = body.isPublic;
    if (!id) throw badRequest("id required");
    await mysql.query("UPDATE problems SET is_public = ? WHERE id = ?", [isPublic ? 1 : 0, id]);
    ctx.body = { ok: true };
  });

  router.post("/api/admin/problems", async (ctx) => {
    await requireStaff(ctx);
    const b = ctx.request.body || {};
    if (!b.title) throw badRequest("title required");
    const tags = Array.isArray(b.tags) ? JSON.stringify(b.tags) : (b.tags || "[]");
    const res = await mysql.query(
      "INSERT INTO problems (title, description, sample_in, sample_out, time_ms, mem_mb, tags, is_public, difficulty, judge_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [b.title, b.description || "", b.sample_in || "", b.sample_out || "", Number(b.time_ms) || 1000, Number(b.mem_mb) || 256, tags, b.is_public ? 1 : 0, Number(b.difficulty) || 0, Number(b.judge_mode) || 0],
    );
    ctx.body = { ok: true, id: res.insertId };
  });

  router.put("/api/admin/problems", async (ctx) => {
    await requireStaff(ctx);
    const b = ctx.request.body || {};
    const id = b.id;
    if (!id) throw badRequest("id required");
    const sets = [];
    const args = [];
    if (b.title !== undefined) { sets.push("title = ?"); args.push(b.title); }
    if (b.description !== undefined) { sets.push("description = ?"); args.push(b.description); }
    if (b.time_ms !== undefined) { sets.push("time_ms = ?"); args.push(Number(b.time_ms)); }
    if (b.mem_mb !== undefined) { sets.push("mem_mb = ?"); args.push(Number(b.mem_mb)); }
    if (b.tags !== undefined) { sets.push("tags = ?"); args.push(Array.isArray(b.tags) ? JSON.stringify(b.tags) : b.tags); }
    if (b.is_public !== undefined) { sets.push("is_public = ?"); args.push(b.is_public ? 1 : 0); }
    if (b.difficulty !== undefined) { sets.push("difficulty = ?"); args.push(Number(b.difficulty)); }
    if (b.judge_mode !== undefined) { sets.push("judge_mode = ?"); args.push(Number(b.judge_mode)); }
    if (!sets.length) throw badRequest("nothing to update");
    sets.push("updated_at = NOW()");
    args.push(id);
    await mysql.query("UPDATE problems SET " + sets.join(", ") + " WHERE id = ?", args);
    ctx.body = { ok: true };
  });

  router.delete("/api/admin/problems", async (ctx) => {
    await requireStaff(ctx);
    const id = Number(ctx.query.id || ctx.request.body && ctx.request.body.id);
    if (!id) throw badRequest("id required");
    await mysql.query("DELETE FROM problems WHERE id = ?", [id]);
    ctx.body = { ok: true };
  });

  router.get("/api/admin/submissions", async (ctx) => {
    await requireStaff(ctx);
    const limit = Math.max(1, Math.min(Number(ctx.query.limit) || 100, 500));
    const username = String(ctx.query.username || "");
    const status = String(ctx.query.status || "");
    let sql = "SELECT s.id, s.task_id, s.username, s.problem_id, s.problem_name, s.language, s.status AS submit_status, s.submit_time, j.status AS judge_status, j.ac_count, j.total_cases FROM submit s LEFT JOIN judge j ON j.submit_id = s.id";
    const args = [];
    const where = [];
    if (username) { where.push("s.username = ?"); args.push(username); }
    if (status) { where.push("s.status = ?"); args.push(status); }
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY s.id DESC LIMIT ?";
    args.push(limit);
    const rows = await mysql.query(sql, args);
    ctx.body = rows.map((r) => Object.assign({}, r, { submit_time: String(r.submit_time) }));
  });

  // ---------- 比赛管理（admin + author） ----------
  router.get("/api/admin/contests", async (ctx) => {
    await requireStaff(ctx);
    const limit = Math.max(1, Math.min(Number(ctx.query.limit) || 100, 500));
    const rows = await mysql.query("SELECT id, content FROM contests ORDER BY id DESC LIMIT ?", [limit]);
    ctx.body = rows.map((r) => {
      let parsed = {};
      try { parsed = JSON.parse(r.content || "[]"); } catch { parsed = {}; }
      return Object.assign({ id: r.id }, parsed);
    });
  });

  router.post("/api/admin/contests", async (ctx) => {
    await requireStaff(ctx);
    const b = ctx.request.body || {};
    const content = JSON.stringify(b.content || b);
    const res = await mysql.query("INSERT INTO contests (content) VALUES (?)", [content]);
    ctx.body = { ok: true, id: res.insertId };
  });

  router.put("/api/admin/contests", async (ctx) => {
    await requireStaff(ctx);
    const b = ctx.request.body || {};
    const id = b.id;
    if (!id) throw badRequest("id required");
    const content = JSON.stringify(b.content || b);
    await mysql.query("UPDATE contests SET content = ? WHERE id = ?", [content, id]);
    ctx.body = { ok: true };
  });

  router.delete("/api/admin/contests", async (ctx) => {
    await requireStaff(ctx);
    const id = Number(ctx.query.id || (ctx.request.body && ctx.request.body.id));
    if (!id) throw badRequest("id required");
    await mysql.query("DELETE FROM contests WHERE id = ?", [id]);
    ctx.body = { ok: true };
  });
}
