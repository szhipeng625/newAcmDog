import { bearerToken } from "../core/http.js";

/** 提交记录：列表 / 测试点明细 / 完整详情。三个都要登录，权限在 service 里判。 */
export default function register(router, app) {
  const { submission } = app.services;

  router.get("/api/judge_status_list", async (ctx) => {
    ctx.body = await submission.judgeStatusList({
      problemId: String(ctx.query.problem_id || ""),
      limit: ctx.query.limit || 50,
      username: String(ctx.query.username || ""),
    }, bearerToken(ctx));
  });

  router.get("/api/judge_status_detail", async (ctx) => {
    ctx.body = await submission.judgeStatusDetail(
      { taskId: String(ctx.query.task_id || "") },
      bearerToken(ctx),
    );
  });

  router.get("/api/submission_detail", async (ctx) => {
    ctx.body = await submission.submissionDetail(
      { taskId: String(ctx.query.task_id || "") },
      bearerToken(ctx),
    );
  });
}
