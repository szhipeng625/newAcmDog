/**
 * 判题状态内存仓。
 * 原实现用两个全局 dict（_results / _task_meta），_task_meta 从不清理会无限增长；
 * 这里统一带上写入时间，按 TTL 一起回收。
 */
export function createResultHub(config) {
  const events = new Map(); // task_id -> { data, ts }
  const metas = new Map();  // task_id -> { data, ts }

  function touch(map, taskId, data, merge) {
    const prev = map.get(taskId);
    map.set(taskId, {
      data: merge && prev ? { ...prev.data, ...data } : data,
      ts: Date.now(),
    });
  }

  function sweep() {
    const cutoff = Date.now() - config.http.resultTtlMs;
    for (const [id, hit] of events) {
      if (hit.ts < cutoff) events.delete(id);
    }
    for (const [id, hit] of metas) {
      if (hit.ts < cutoff || !events.has(id)) metas.delete(id);
    }
  }

  return {
    setMeta(taskId, meta) {
      touch(metas, taskId, meta, true);
    },

    getMeta(taskId) {
      return metas.get(taskId)?.data || null;
    },

    /** 写入一条状态/结果事件，同时可合并 meta 字段。 */
    push(taskId, event, extraMeta) {
      touch(events, taskId, event, false);
      if (extraMeta) touch(metas, taskId, extraMeta, true);
      sweep();
    },

    /** 轮询接口读最后一条事件；没有则视为排队中。 */
    latest(taskId) {
      const hit = events.get(taskId);
      return hit ? hit.data : { task_id: taskId, status: "pending", phase: "queued" };
    },

    stats() {
      return { events: events.size, metas: metas.size };
    },
  };
}
