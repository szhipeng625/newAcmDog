import { HttpError, badRequest, upstream } from "../core/http.js";
import { logger } from "../core/logger.js";

const log = logger.child("problem");

/** 题目列表 / 题面 / 热门题。 */
export default function register(router, app) {
  const { filer } = app.infra;
  const { problems } = app.services;

  router.get("/api/cloud_problems", async (ctx) => {
    // 导航表挂了就返回空列表：首页没题比首页 500 好，日志里能查到原因
    let list = [];
    try {
      list = await problems.navList();
    } catch (err) {
      log.warn("nav list failed", { error: err });
    }
    ctx.body = list.filter((p) => p.isPublic);
  });

  // 题面只认对象存储：这里不做 DB 回退，免得两个源不一致时排障困难
  router.get("/api/cloud_problem", async (ctx) => {
    const id = String(ctx.query.id || "");
    if (!/^\d+$/.test(id)) throw badRequest("id required");
    try {
      ctx.body = await filer.problemJson(id);
    } catch (err) {
      if (err.status === 404) throw new HttpError(404, "problem not found in object storage");
      throw upstream(err.message);
    }
  });

  router.get("/api/hot_problems", async (ctx) => {
    const limit = Number(ctx.query.limit || 10);
    ctx.body = await problems.hotProblems(limit);
  });
}
