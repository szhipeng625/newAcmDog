import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";

/**
 * HTTP 冒烟：真正把 app 拉起来，用 mock 沙箱驱动，验证路由挂载、鉴权边界、
 * 错误格式与降级行为。外部依赖（MySQL/MQ/Redis/中间件）全部不通，
 * 正好顺带验证"外部没起也能启动、按端点独立降级"这个设计目标。
 */
process.env.SANDBOX_DRIVER = "mock";
process.env.JUDGE_WORK_ROOT = os.tmpdir();
process.env.RESULT_TTL_MS = "60000";

const { createApp } = await import("../src/app.js");

test("HTTP 冒烟", async (t) => {
  const app = await createApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.closePlugins();
    await app.infra.close();
  });

  await t.test("沙箱是插件，默认取 driver 指定的实现", () => {
    assert.equal(app.sandbox.name, "mock");
    assert.ok(app.sandbox.languages.includes("java"));
    assert.equal(typeof app.sandbox.run, "function");
    assert.equal(typeof app.sandbox.prepare, "function");
  });

  await t.test("CORS 预检返回 204", async () => {
    const res = await fetch(`${base}/api/cloud_judge`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  });

  await t.test("提交判题缺 token → 401", async () => {
    const res = await fetch(`${base}/api/cloud_judge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "x", problemId: 1 }),
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "missing token, please login first" });
  });

  await t.test("提交记录缺 token → 401", async () => {
    const res = await fetch(`${base}/api/judge_status_list?problem_id=1`);
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /需登录/);
  });

  await t.test("未知 task_id → 200 且报告排队中", async () => {
    const res = await fetch(`${base}/api/cloud_judge_result?task_id=nope`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "pending");
    assert.equal(body.phase, "queued");
  });

  await t.test("缺参数 → 400", async () => {
    const noTask = await fetch(`${base}/api/cloud_judge_result`);
    assert.equal(noTask.status, 400);
    assert.deepEqual(await noTask.json(), { error: "task_id required" });

    const badId = await fetch(`${base}/api/cloud_problem?id=abc`);
    assert.equal(badId.status, 400);
    assert.deepEqual(await badId.json(), { error: "id required" });
  });

  await t.test("未知路由 → 404 且是 JSON", async () => {
    const res = await fetch(`${base}/api/definitely-not-here`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not found" });
  });

  await t.test("上游不可用时返回 502 而不是崩掉进程", async () => {
    const res = await fetch(`${base}/api/anime/status`);
    assert.ok([502, 200].includes(res.status), `unexpected ${res.status}`);
    if (res.status === 502) assert.match((await res.json()).error, /动漫智能体不可用/);
  });
});
