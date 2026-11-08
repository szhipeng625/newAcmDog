import { useState, useEffect } from "react";
import { api } from "../api/client";
import { useFetch } from "../hooks/useFetch";

export default function AdminUsers() {
  const [kw, setKw] = useState("");
  const { data, loading, error, reload } = useFetch(() => api.adminUsers(kw));
  const [roleMsg, setRoleMsg] = useState(null);
  const changeRole = async (id, role) => {
    try {
      await api.adminSetRole(id, role);
      setRoleMsg("更新成功");
      reload();
    } catch (e) { setRoleMsg(e.message); }
  };
  return (
    <div className="container page">
      <h1>用户管理</h1>
      <input className="input search" placeholder="搜索用户名/昵称" value={kw} onChange={(e) => setKw(e.target.value)} />
      {roleMsg && <div className="empty">{roleMsg}</div>}
      {loading && <div className="spinner" />}
      {error && <div className="empty">加载失败：{error}</div>}
      {!loading && !error && (
        <table className="table">
          <thead><tr><th>ID</th><th>用户名</th><th>昵称</th><th>角色</th><th>邮箱</th><th>操作</th></tr></thead>
          <tbody>
            {(data || []).map((u) => (
              <tr key={u.id}>
                <td className="mono">{u.id}</td>
                <td>{u.username}</td>
                <td>{u.nickname}</td>
                <td>{u.role}</td>
                <td>{u.email}</td>
                <td>
                  <select value={u.role} onChange={(e) => changeRole(u.id, e.target.value)}>
                    <option value="user">user</option>
                    <option value="author">author</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
