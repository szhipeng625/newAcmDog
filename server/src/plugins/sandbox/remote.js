import { supportedLanguages } from "./languages.js";

/**
 * 远程沙箱：把编译与执行都委托给一个 HTTP 沙箱服务。
 * 这是"沙箱可插拔"的扩展点——判题集群扩容时，业务层不用改。
 * 对端契约：POST /prepare、POST /run，字段与本地沙箱一致。
 */
export function createRemoteSandbox(options = {}) {
  const base = options.remoteBase;
  if (!base) throw new Error("remote sandbox requires config.sandbox.remoteBase");

  async function post(pathname, body) {
    const res = await fetch(base + pathname, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`remote sandbox ${pathname} -> HTTP ${res.status}`);
    return res.json();
  }

  return {
    name: "remote",
    languages: supportedLanguages(),
    async prepare(payload) {
      return post("/prepare", payload);
    },
    async run(task) {
      return post("/run", task);
    },
    async close() {},
  };
}
