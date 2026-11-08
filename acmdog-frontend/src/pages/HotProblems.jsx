import { Link } from 'react-router-dom'
import { useState } from 'react'
import { api } from '../api/client'
import { useFetch } from '../hooks/useFetch'
import './Problems.css'
export default function HotProblems() {
  const { data, loading, error } = useFetch(() => api.hotProblems(50))
  const [query, setQuery] = useState('')
  const raw = Array.isArray(data) ? data : data?.problems || []
  const items = raw.map((it, i) => ({
    id: it.id ?? it.problem_id ?? i + 1,
    title: it.title || it.name || ('Problem ' + (it.id ?? i + 1)),
    hot: it.hot_score ?? it.score ?? 0,
  }))
  const filtered = items.filter((p) =>
    String(p.title).toLowerCase().includes(query.toLowerCase())
  )
  return (
    <div className="container page">
      <div className="page-head">
        <div>
          <h1>热门题目</h1>
          <p className="sub">按提交次数排行，共 {items.length} 道</p>
        </div>
        <input
          className="input search"
          placeholder="搜索题目…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {loading && <div className="spinner" />}
      {error && <div className="empty">加载失败：{error}</div>}
      {!loading && !error && (
        <div className="card">
          {filtered.length === 0 ? (
            <div className="empty">暂无热门题目</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 80 }}>#</th>
                  <th>标题</th>
                  <th style={{ width: 140 }}>热度</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p, i) => (
                  <tr key={p.id}>
                    <td className="mono">{i + 1}</td>
                    <td>
                      <Link to={`/problem/${p.id}`} className="title-link">
                        {p.title}
                      </Link>
                    </td>
                    <td className="muted">{p.hot}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
