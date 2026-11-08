/**
 * 插件机制。
 *
 * Koa 本身没有插件系统，这里按"约定优于配置"补一层：
 *   - 插件 = { name, install?(app, options), close?() } 或返回该对象的工厂函数
 *   - 沙箱插件额外要求：languages: string[]，run(task, ctx) => Promise<Verdict>
 *
 * 沙箱只是其中一类插件。换成 Docker 沙箱、远程沙箱，只要满足同一份契约，
 * 业务层（judgeService / routes）不需要改任何一行。
 */

export function enablePlugins(app) {
  app.plugins = new Map();
  app.sandboxes = new Map();
  app.sandbox = null;

  app.registerPlugin = async (plugin, options = {}) => {
    const instance = typeof plugin === "function" ? await plugin(options) : plugin;
    if (!instance || typeof instance.name !== "string" || !instance.name) {
      throw new Error("plugin must expose a non-empty string 'name'");
    }
    if (app.plugins.has(instance.name)) {
      throw new Error(`plugin '${instance.name}' is already registered`);
    }
    if (typeof instance.install === "function") {
      await instance.install(app, options);
    }
    app.plugins.set(instance.name, instance);
    console.log(`[plugin] ${instance.name} registered`);
    return instance;
  };

  /** 注册一个沙箱实现；第一个注册的是默认实现。 */
  app.useSandbox = async (plugin, options = {}) => {
    const instance = await app.registerPlugin(plugin, options);
    if (typeof instance.run !== "function") {
      throw new Error(`sandbox '${instance.name}' must implement run(task, ctx)`);
    }
    if (!Array.isArray(instance.languages) || instance.languages.length === 0) {
      throw new Error(`sandbox '${instance.name}' must declare supported languages`);
    }
    app.sandboxes.set(instance.name, instance);
    if (!app.sandbox) app.sandbox = instance;
    return instance;
  };

  /** 运行时切换默认沙箱，例如从本地进程沙箱切到远程沙箱。 */
  app.useSandboxDriver = (name) => {
    const target = app.sandboxes.get(name);
    if (!target) throw new Error(`sandbox '${name}' is not registered`);
    app.sandbox = target;
    return target;
  };

  app.closePlugins = async () => {
    for (const plugin of app.plugins.values()) {
      if (typeof plugin.close === "function") {
        try {
          await plugin.close();
        } catch (err) {
          console.error(`[plugin] ${plugin.name} close failed:`, err.message);
        }
      }
    }
  };
}
