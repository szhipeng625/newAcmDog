import { useState } from "react";
import { api } from "../api/client";
import { useFetch } from "../hooks/useFetch";

export default function AdminSubmissions() {
  const [user, setUser] = useState("");
  const [status, setStatus] = useState("");
  const { data, loading, error } = useFetch(() => api.adminSubmissions(user, status));
  return (
    <div className="container page">
      <h1>提交监控</h1>
      <div className="page-head">
        <input className="input search" placeholder="用户名" value={user} onChange={(e) => setUser(e.target.value)} />
        <input className="input search" placeholder="状态" value={status} onChange={(e) => setStatus(e.target.value)} />
      </div>
      {loading && <div className="spinner" />}
      {error && <div className="empty">加载失败：{error}</div>}
      {!loading && !error && (
        <table className="table">
          <thead><tr><th>ID</th><th>用户</th><th>题目</th><th>语言</th><th>提交状态</th><th>判题状态</th><th>AC</th><th>总数</th></tr></thead>
          <tbody>
            {(data || []).map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.id}</td>
                <td>{s.username}</td>
                <td>{s.problem_name}</td>
                <td>{s.language}</td>
                <td>{s.submit_status}</td>
                <td>{s.judge_status}</td>
                <td>{s.ac_count}</td>
                <td>{s.total_cases}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
