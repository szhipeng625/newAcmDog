/** 动漫智能体：状态 / 开关 / 生成动图。全部转发到 18091。 */
export default function register(router, app) {
  const { ai } = app.services;

  router.get("/api/anime/status", async (ctx) => {
    ctx.body = await ai.animeStatus();
  });

  router.post("/api/anime/toggle", async (ctx) => {
    ctx.body = await ai.animeToggle(ctx.request.body || {});
  });

  router.post("/api/anime/generate", async (ctx) => {
    ctx.body = await ai.animeGenerate(ctx.request.body || {});
  });
}
