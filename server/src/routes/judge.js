import { badRequest, unauthorized, bearerToken } from "../core/http.js";

/** 提交判题 + 结果轮询（前端拿到 task_id 后靠它做 SSE/长轮询）。 */
export default function register(router, app) {
  const { judge, auth, resultHub } = app.services;

  router.post("/api/cloud_judge", async (ctx) => {
    const token = auth.requireToken(bearerToken(ctx), "missing token, please login first");
    let me;
    try {
      me = await auth.whoami(token);
    } catch {
      throw unauthorized("invalid or expired token");
    }

    const body = ctx.request.body || {};
    const code = body.code || "";
    const problemId = body.problemId || 0;
    if (!code || !problemId) throw badRequest("code and problemId required");

    ctx.body = await judge.submit({
      code,
      language: body.language || "cpp",
      problemId,
      contestId: body.contestId || 0,
    }, { username: me.username, token });
  });

  router.get("/api/cloud_judge_result", async (ctx) => {
    const taskId = String(ctx.query.task_id || "");
    if (!taskId) throw badRequest("task_id required");
    ctx.body = resultHub.latest(taskId);
  });
}
