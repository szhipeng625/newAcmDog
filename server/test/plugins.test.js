import test from "node:test";
import assert from "node:assert/strict";
import { enablePlugins } from "../src/core/plugins.js";

const fakeSandbox = (name, extra = {}) => ({
  name,
  languages: ["cpp"],
  prepare: async () => ({ binary: "x", args: [], pids: 32 }),
  run: async () => ({ status: "AC" }),
  ...extra,
});

test("插件：name 必填", async () => {
  const app = {};
  enablePlugins(app);
  await assert.rejects(() => app.registerPlugin({}), /non-empty string 'name'/);
});

test("插件：同名重复注册要报错", async () => {
  const app = {};
  enablePlugins(app);
  await app.registerPlugin({ name: "a" });
  await assert.rejects(() => app.registerPlugin({ name: "a" }), /already registered/);
});

test("沙箱插件：必须实现 run()", async () => {
  const app = {};
  enablePlugins(app);
  const broken = fakeSandbox("broken", { run: undefined });
  await assert.rejects(() => app.useSandbox(broken), /must implement run/);
});

test("沙箱插件：必须声明支持的语言", async () => {
  const app = {};
  enablePlugins(app);
  await assert.rejects(() => app.useSandbox(fakeSandbox("x", { languages: [] })), /supported languages/);
});

test("首个注册的沙箱成为默认，可运行时切换", async () => {
  const app = {};
  enablePlugins(app);
  const local = await app.useSandbox(fakeSandbox("local"));
  const remote = await app.useSandbox(fakeSandbox("remote"));
  assert.equal(app.sandbox, local);
  assert.equal(app.sandboxes.size, 2);

  app.useSandboxDriver("remote");
  assert.equal(app.sandbox, remote);
  assert.throws(() => app.useSandboxDriver("nope"), /not registered/);
});

test("工厂函数形式：install() 收到 app 与 options", async () => {
  const app = {};
  enablePlugins(app);
  let seen = null;
  const factory = (options) => ({
    name: "withInstall",
    install: (theApp, opts) => { seen = { app: theApp, opts }; },
  });
  await app.registerPlugin(factory, { a: 1 });
  assert.equal(seen.app, app);
  assert.deepEqual(seen.opts, { a: 1 });
});

test("closePlugins：单个插件关闭失败不影响其他插件", async () => {
  const app = {};
  enablePlugins(app);
  const closed = [];
  await app.registerPlugin({ name: "ok", close: async () => closed.push("ok") });
  await app.registerPlugin({
    name: "bad",
    close: async () => { throw new Error("boom"); },
  });
  await app.registerPlugin({ name: "ok2", close: async () => closed.push("ok2") });
  await app.closePlugins();
  assert.deepEqual(closed, ["ok", "ok2"]);
});
