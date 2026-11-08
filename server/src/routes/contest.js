import { badRequest, bearerToken } from "../core/http.js";

/** 竞赛：列表 / 详情 / 题面 PDF / 榜单 / 报名 / 数据准备与清理。 */
export default function register(router, app) {
  const { contest, auth } = app.services;

  router.get("/api/cloud_contests", async (ctx) => {
    ctx.body = await contest.list();
  });

  router.get("/api/cloud_contest", async (ctx) => {
    ctx.body = await contest.detail(ctx.query.id);
  });

  router.get("/api/cloud_contest_pdf", async (ctx) => {
    const { contest: info, buffer } = await contest.pdf(ctx.query.id);
    ctx.set("Content-Type", "application/pdf");
    ctx.set(
      "Content-Disposition",
      `attachment; filename=contest_${info.id}.pdf`,
    );
    ctx.body = buffer;
  });

  router.get("/api/cloud_contest_board", async (ctx) => {
    ctx.body = await contest.board(ctx.query.cid);
  });

  router.post("/api/cloud_contest_register", async (ctx) => {
    const token = auth.requireToken(bearerToken(ctx), "missing token");
    const body = ctx.request.body || {};
    if (!body.contestId) throw badRequest("contestId required");
    ctx.body = await contest.register(body.contestId, token);
  });

  router.post("/api/cloud_contest_data_prepare", async (ctx) => {
    const body = ctx.request.body || {};
    if (!body.contestId) throw badRequest("contestId required");
    ctx.body = await contest.dataPrepare(body.contestId);
  });

  router.post("/api/cloud_contest_data_cleanup", async (ctx) => {
    const body = ctx.request.body || {};
    if (!body.contestId) throw badRequest("contestId required");
    ctx.body = await contest.dataCleanup(body.contestId);
  });
}
