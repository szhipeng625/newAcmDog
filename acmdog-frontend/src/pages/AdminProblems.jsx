import { useState } from "react";
import { api } from "../api/client";
import { useFetch } from "../hooks/useFetch";

export default function AdminProblems() {
  const { data, loading, error, reload } = useFetch(() => api.adminProblems());
  const [msg, setMsg] = useState(null);
  const [form, setForm] = useState({ id: null, title: "", description: "", time_ms: 1000, mem_mb: 256, difficulty: 0, is_public: false, tags: "" });
  const toggle = async (id, cur) => {
    try { await api.adminTogglePublic(id, !cur); setMsg("更新成功"); reload(); } catch (e) { setMsg(e.message); }
  };
  const save = async () => {
    try {
      const payload = { ...form, tags: form.tags ? form.tags.split(",").map((s) => s.trim()) : [] };
      if (form.id) await api.adminUpdateProblem(payload); else await api.adminCreateProblem(payload);
      setMsg("保存成功"); setForm({ id: null, title: "", description: "", time_ms: 1000, mem_mb: 256, difficulty: 0, is_public: false, tags: "" }); reload();
    } catch (e) { setMsg(e.message); }
  };
  const edit = (p) => setForm({ id: p.id, title: p.title, description: "", time_ms: p.time_ms, mem_mb: p.mem_mb, difficulty: p.difficulty, is_public: !!p.is_public, tags: Array.isArray(p.tags) ? p.tags.join(",") : (p.tags || "") });
  const del = async (id) => {
    try { await api.adminDeleteProblem(id); setMsg("删除成功"); reload(); } catch (e) { setMsg(e.message); }
  };
  return (
    <div className="container page">
      <h1>题目管理</h1>
      {msg && <div className="empty">{msg}</div>}
      <div className="card">
        <input className="input" placeholder="标题" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <textarea className="input" placeholder="描述" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <input className="input" placeholder="时间限制(ms)" type="number" value={form.time_ms} onChange={(e) => setForm({ ...form, time_ms: Number(e.target.value) })} />
        <input className="input" placeholder="内存限制(mb)" type="number" value={form.mem_mb} onChange={(e) => setForm({ ...form, mem_mb: Number(e.target.value) })} />
        <input className="input" placeholder="难度" type="number" value={form.difficulty} onChange={(e) => setForm({ ...form, difficulty: Number(e.target.value) })} />
        <input className="input" placeholder="标签(逗号分隔)" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
        <label><input type="checkbox" checked={form.is_public} onChange={(e) => setForm({ ...form, is_public: e.target.checked })} /> 公开发布</label>
        <button className="btn btn-primary btn-sm" onClick={save}>{form.id ? "更新" : "创建"}题目</button>
      </div>
      {loading && <div className="spinner" />}
      {error && <div className="empty">加载失败：{error}</div>}
      {!loading && !error && (
        <table className="table">
          <thead><tr><th>ID</th><th>标题</th><th>难度</th><th>公开</th><th>操作</th></tr></thead>
          <tbody>
            {(data || []).map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.id}</td>
                <td>{p.title}</td>
                <td>{p.difficulty}</td>
                <td>{p.is_public ? "是" : "否"}</td>
                <td>
                  <button className="btn btn-sm" onClick={() => toggle(p.id, p.is_public)}>切换公开</button>
                  <button className="btn btn-sm" onClick={() => edit(p)}>编辑</button>
                  <button className="btn btn-sm" onClick={() => del(p.id)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
