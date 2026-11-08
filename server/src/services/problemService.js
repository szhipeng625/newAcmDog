import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "../core/logger.js";

const log = logger.child("problem");

/**
 * 题目服务：元数据 + 测试数据。
 * 取数优先级与原实现一致：Redis LRU → 对象存储 → MySQL → 中间件 → 样例。
 */
export function createProblemService(app) {
  const { mysql, filer, redis, middleware, config } = {
    ...app.infra,
    config: app.config,
  };

  function normalizeProblem(raw = {}) {
    return {
      id: Number(raw.id ?? raw.problem_id ?? 0),
      title: raw.title || raw.name || "",
      description: raw.description || "",
      tags: raw.tags || [],
      isPublic: Boolean(raw.isPublic ?? raw.is_public ?? true),
      timeMs: Number(raw.timeMs ?? raw.time_ms ?? 1000),
      memMb: Number(raw.memMb ?? raw.mem_mb ?? 256),
      difficulty: Number(raw.difficulty ?? 0),
      stdCode: raw.stdCode ?? raw.std_code ?? "",
      stdExe: raw.stdExe ?? raw.std_exe ?? "",
      spjCode: raw.spjCode ?? raw.spj_code ?? "",
      spjExe: raw.spjExe ?? raw.spj_exe ?? "",
      entryCode: raw.entryCode ?? raw.entry_code ?? "",
      entryExe: raw.entryExe ?? raw.entry_exe ?? "",
      judgeMode: raw.judgeMode ?? raw.judge_mode ?? 0,
      sampleIn: raw.sampleIn ?? raw.sample_in ?? "",
      sampleOut: raw.sampleOut ?? raw.sample_out ?? "",
      generators: raw.generators || [],
    };
  }

  async function fromDb(pid) {
    const rows = await mysql.query(
      `SELECT id, title, tags, is_public, time_ms, mem_mb, difficulty,
              std_code, std_exe, spj_code, spj_exe, entry_code, entry_exe, judge_mode
         FROM problems WHERE id = ? LIMIT 1`,
      [pid],
    );
    if (!rows.length) return null;
    const row = rows[0];
    let tags = row.tags;
    if (typeof tags === "string") {
      try { tags = JSON.parse(tags); } catch { tags = tags.split(",").map((s) => s.trim()); }
    }
    return normalizeProblem({ ...row, tags });
  }

  async function meta(pid) {
    const numeric = Number(pid);
    const local = await fromDb(numeric).catch(() => null);
    if (local) return local;

    try {
      return normalizeProblem(await filer.problemJson(numeric));
    } catch (err) {
      log.warn("filer meta failed", { problem_id: pid, error: err });
    }
    try {
      return normalizeProblem(await middleware.problem(numeric));
    } catch (err) {
      log.warn("middleware meta failed", { problem_id: pid, error: err });
    }
    return null;
  }

  async function navList() {
    const rows = await mysql.query(
      `SELECT p.id, p.title, p.tags, p.is_public, p.time_ms, p.mem_mb, p.difficulty,
              (SELECT COUNT(*) FROM judge j WHERE j.problem_id = p.id AND j.status = 'AC') AS accepted,
              (SELECT COUNT(*) FROM submit s WHERE s.problem_id = p.id) AS submissions
         FROM problems p WHERE p.is_public = 1 ORDER BY p.id ASC`,
    );
    return rows.map((row) => {
      let tags = row.tags;
      if (typeof tags === "string") {
        try { tags = JSON.parse(tags); } catch { tags = tags.split(",").map((s) => s.trim()); }
      }
      return {
        id: Number(row.id),
        title: row.title || "",
        tags: tags || [],
        isPublic: Boolean(row.is_public),
        timeMs: Number(row.time_ms) || 1000,
        memMb: Number(row.mem_mb) || 256,
        difficulty: Number(row.difficulty) || 0,
        accepted: Number(row.accepted) || 0,
        submissions: Number(row.submissions) || 0,
      };
    });
  }

  async function writeFiles(dir, files) {
    await fs.mkdir(dir, { recursive: true });
    await Promise.all(
      Object.entries(files).map(([name, buf]) => fs.writeFile(path.join(dir, name), buf)),
    );
  }

  /** 列出目录里的测试点，按数字序（2.in 在 10.in 前）。 */
  async function sortedCases(dir) {
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const ins = names
      .filter((n) => n.endsWith(".in"))
      .sort((a, b) => Number(a.slice(0, -3)) - Number(b.slice(0, -3)));
    return ins.map((name) => {
      const base = name.slice(0, -3);
      return {
        name: base,
        input: path.join(dir, name),
        expected: names.includes(`${base}.out`) ? path.join(dir, `${base}.out`) : "",
      };
    });
  }

  /** 取某题全部测试点，落到本地目录后返回 [{ name, input, expected }]。 */
  async function testData(pid) {
    const numeric = Number(pid);
    const dir = path.join(config.sandbox.dataRoot, `p${numeric}`);

    const cached = await redis.getProblemData(numeric);
    if (cached) {
      await writeFiles(dir, cached);
      return sortedCases(dir);
    }

    try {
      const names = await filer.listProblemData(numeric).catch(() => []);
      const dataNames = names.filter((n) => /\.(in|out|txt)$/i.test(n));
      if (dataNames.length) {
        const files = {};
        for (const name of dataNames) {
          // 只认形如 1.in / 1.out 的测试文件
          if (!/^\d+\.(in|out)$/i.test(name)) continue;
          files[name] = await filer.download(numeric, name);
        }
        if (Object.keys(files).length) {
          await writeFiles(dir, files);
          await redis.putProblemData(numeric, files);
          log.info("test data loaded from object storage", {
            problem_id: pid, files: Object.keys(files).length,
          });
          return sortedCases(dir);
        }
      }
    } catch (err) {
      log.warn("filer test data failed", { problem_id: pid, error: err });
    }

    try {
      const rows = await mysql.query(
        "SELECT input, output FROM problem_testcases WHERE problem_id = ? ORDER BY sort, id",
        [numeric],
      );
      if (rows.length) {
        const files = {};
        rows.forEach((row, i) => {
          files[`${i + 1}.in`] = Buffer.from(row.input ?? "", "utf8");
          files[`${i + 1}.out`] = Buffer.from(row.output ?? "", "utf8");
        });
        await writeFiles(dir, files);
        return sortedCases(dir);
      }
    } catch (err) {
      log.warn("db testcases failed", { problem_id: pid, error: err });
    }

    const info = await meta(numeric);
    if (info && (info.sampleIn || info.sampleOut)) {
      await writeFiles(dir, {
        "1.in": Buffer.from(info.sampleIn || "", "utf8"),
        "1.out": Buffer.from(info.sampleOut || "", "utf8"),
      });
      return sortedCases(dir);
    }

    return [];
  }

  /**
   * 热门题：排行来自 Redis 的 hot:problems zset，题名回查导航表。
   * Redis 挂了就返回空数组——热度是锦上添花，不该拖垮首页。
   */
  async function hotProblems(limit = 10) {
    const take = Math.max(1, Math.min(Number(limit) || 10, 100));
    const items = await redis.hotProblems(take);
    if (!items.length) return [];

    const titles = new Map();
    try {
      for (const p of await navList()) titles.set(Number(p.id), p.title || "");
    } catch (err) {
      log.warn("hot titles lookup failed", { error: err });
    }
    return items.map((it) => ({
      id: it.id,
      title: titles.get(Number(it.id)) || "",
      hot_score: it.hot_score,
    }));
  }

  return { meta, navList, testData, sortedCases, normalizeProblem, hotProblems };
}
