import { createResultHub } from "./resultHub.js";
import { createAuthService } from "./authService.js";
import { createProblemService } from "./problemService.js";
import { createJudgeService } from "./judgeService.js";
import { createSubmissionService } from "./submissionService.js";
import { createContestService } from "./contestService.js";
import { createAiService } from "./aiService.js";

/**
 * 服务层装配。
 *
 * 依赖方向是单向的：services → infra / sandbox 插件，routes → services。
 * 判题服务通过 app.services.ai 取 AI 能力，所以这里先建对象、最后再挂到
 * app.services 上——createJudgeService 内部是运行时读取，不存在循环依赖。
 */
export function createServices(app) {
  const resultHub = createResultHub(app.config);
  const auth = createAuthService(app);
  const problems = createProblemService(app);
  const ai = createAiService(app);

  // 判题只依赖沙箱插件的 run()/prepare()，换沙箱实现无需改这里
  const judge = createJudgeService(app, { problems, resultHub });
  const submission = createSubmissionService(app, { resultHub, auth });
  const contest = createContestService(app, { problems });

  return { resultHub, auth, problems, ai, judge, submission, contest };
}
