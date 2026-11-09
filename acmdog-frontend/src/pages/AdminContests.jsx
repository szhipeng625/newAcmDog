import { useState } from "react";
import { api } from "../api/client";
import { useFetch } from "../hooks/useFetch";

export default function AdminContests() {
  const { data, loading, error, reload } = useFetch(() => api.adminContests());
  const [form, setForm] = useState({ id: null, title: "", content: "" });
  const [msg, setMsg] = useState(null);
  const save = async () => {
    try {
      const payload = { id: form.id, content: { title: form.title, detail: form.content } };
      if (form.id) await api.adminUpdateContest(payload);
      else await api.adminCreateContest(payload);
      setMsg("保存成功"); setForm({ id: null, title: "", content: "" }); reload();
    } catch (e) { setMsg(e.message); }
  };
  const edit = (c) => setForm({ id: c.id, title: (c.title || ""), content: JSON.stringify(c.detail || {}) });
  const del = async (id) => {
    try { await api.adminDeleteContest(id); setMsg("删除成功"); reload(); } catch (e) { setMsg(e.message); }
  };
  return (
    <div className="container page">
      <h1>比赛管理</h1>
      {msg && <div className="empty">{msg}</div>}
      <div className="card">
        <input className="input" placeholder="比赛标题" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <textarea className="input" placeholder="比赛内容(JSON)" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
        <button className="btn btn-primary btn-sm" onClick={save}>{form.id ? "更新" : "创建"}比赛</button>
      </div>
      {loading && <div className="spinner" />}
      {error && <div className="empty">加载失败：{error}</div>}
      {!loading && !error && (
        <table className="table">
          <thead><tr><th>ID</th><th>标题</th><th>操作</th></tr></thead>
          <tbody>
            {(data || []).map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.id}</td>
                <td>{c.title}</td>
                <td><button className="btn btn-sm" onClick={() => edit(c)}>编辑</button> <button className="btn btn-sm" onClick={() => del(c.id)}>删除</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
