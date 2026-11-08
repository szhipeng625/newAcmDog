import { createEvalWorkerSandbox } from "./evalWorker.js";
import { createMockSandbox } from "./mock.js";
import { createRemoteSandbox } from "./remote.js";

/**
 * 沙箱插件工厂。按 SANDBOX_DRIVER 选择实现：
 *   local  —— 本机 C++ eval_worker（生产）
 *   mock   —— 不执行代码，仅用于开发联调
 *   remote —— 委托给远程沙箱服务（水平扩容）
 *
 * 三个实现共享同一份契约，业务层只依赖 name/languages/prepare/run。
 */
export function sandboxPlugin(options = {}) {
  switch (options.driver) {
    case "mock":
      return createMockSandbox(options);
    case "remote":
      return createRemoteSandbox(options);
    case "local":
    default:
      return createEvalWorkerSandbox(options);
  }
}
