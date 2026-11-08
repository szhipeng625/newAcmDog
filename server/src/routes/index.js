import Router from "@koa/router";
import authRoutes from "./auth.js";
import problemRoutes from "./problem.js";
import judgeRoutes from "./judge.js";
import submissionRoutes from "./submission.js";
import contestRoutes from "./contest.js";
import animeRoutes from "./anime.js";

/**
 * 路由表。保持与原 Python 服务完全一致的 21 个端点，前端不用改。
 *
 * 路由只做三件事：取参数、挑服务、把结果塞进 ctx.body。
 * 校验与业务判断都在 service 层，抛 HttpError 由 httpMiddleware 统一转 JSON。
 */
const GROUPS = [
  authRoutes,       // POST /api/cloud_login, /api/cloud_register, GET /api/cloud_whoami
  problemRoutes,    // GET  /api/cloud_problems, /api/cloud_problem, /api/hot_problems
  judgeRoutes,      // POST /api/cloud_judge, GET /api/cloud_judge_result
  submissionRoutes, // GET  /api/judge_status_list, /api/judge_status_detail, /api/submission_detail
  contestRoutes,    // GET  /api/cloud_contests /cloud_contest /cloud_contest_pdf /cloud_contest_board
                    // POST /api/cloud_contest_register /cloud_contest_data_prepare /cloud_contest_data_cleanup
  animeRoutes,      // GET  /api/anime/status, POST /api/anime/toggle, /api/anime/generate
];

export function createRoutes(app) {
  const router = new Router();
  for (const register of GROUPS) register(router, app);
  return router;
}
