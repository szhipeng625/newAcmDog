import { useState } from "react";
import { api } from "../api/client";
import { useFetch } from "../hooks/useFetch";

export default function AdminProblems() {
  const { data, loading, error, reload } = useFetch(() => api.adminProblems());
  const [msg, setMsg] = useState(null);
  const toggle = async (id, cur) => {
    try {
      await api.adminTogglePublic(id, !cur);
      setMsg("更新成功");
      reload();
    } catch (e) { setMsg(e.message); }
  };
  return (
    <div className="container page">
      <h1>题目管理</h1>
      {msg && <div className="empty">{msg}</div>}
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
                <td><button className="btn btn-sm" onClick={() => toggle(p.id, p.is_public)}>切换公开</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
