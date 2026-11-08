import { httpJson } from "../infra/httpClient.js";
import { upstream } from "../core/http.js";

/**
 * AI 相关代理：
 *   - judge_event 判题讲评/鼓励（判题结果落库前调用，失败不影响判题）
 *   - vh_info     登录/注册成功后异步初始化虚拟人账号
 *   - anime/*     动漫智能体（经隧道端口 18091 转发）
 */
export function createAiService(app) {
  const { ai, anime } = app.config;

  const aiBase = String(ai.base).replace(/\/+$/, "");
  const animeBase = String(anime.base).replace(/\/+$/, "");

  /** 判题讲评：返回 { reply, status } 供结果消息带给前端；拿不到就返回 null。 */
  async function judgeEvent(result = {}) {
    if (!result.username) return null;
    try {
      const data = await httpJson(`${aiBase}/api/ai/judge_event`, {
        method: "POST",
        timeoutMs: 10000,
        body: {
          username: result.username,
          problem: result.problem || "未知题目",
          status: result.status,
        },
      });
      if (data && data.reply) return { reply: data.reply, status: result.status };
      return null;
    } catch (err) {
      console.warn("[ai] judge_event failed:", err.message);
      return null;
    }
  }

  /** 虚拟人账号初始化：纯副作用，调用方不等结果。 */
  function vhInit(username) {
    if (!username) return;
    httpJson(`${aiBase}/api/ai/vh_info`, {
      method: "POST",
      timeoutMs: 5000,
      body: { username },
    }).catch((err) => console.warn("[ai] vh_info failed:", err.message));
  }

  async function animeStatus() {
    try {
      return await httpJson(`${animeBase}/api/anime/status`, { timeoutMs: 15000 });
    } catch (err) {
      throw upstream(`动漫智能体不可用: ${err.message}`);
    }
  }

  async function animeToggle(body = {}) {
    try {
      return await httpJson(`${animeBase}/api/anime/toggle`, {
        method: "POST",
        timeoutMs: 15000,
        body,
      });
    } catch (err) {
      throw upstream(`动漫智能体不可用: ${err.message}`);
    }
  }

  /** 生成动图很慢（可能几分钟），上游报错时把它的错误体原样透传。 */
  async function animeGenerate(body = {}) {
    try {
      return await httpJson(`${animeBase}/api/anime/generate`, {
        method: "POST",
        timeoutMs: 300000,
        body,
      });
    } catch (err) {
      if (err.data) return err.data;
      throw upstream(`动漫智能体不可用: ${err.message}`);
    }
  }

  return { judgeEvent, vhInit, animeStatus, animeToggle, animeGenerate };
}
