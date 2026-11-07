import { Link } from 'react-router-dom'
import { useState } from 'react'
import { api } from '../api/client'
import { useFetch } from '../hooks/useFetch'
import './Problems.css'

const diffMap = {
  1: { label: '简单', cls: 'badge-easy' },
  2: { label: '中等', cls: 'badge-medium' },
  3: { label: '困难', cls: 'badge-hard' },
}

export default function Problems() {
  const { data, loading, error } = useFetch(() => api.problems())
  const [query, setQuery] = useState('')

  const problems = Array.isArray(data) ? data : data?.problems || []

  const filtered = problems.filter((p) => {
    const title = String(p.title || p.name || '')
    return title.toLowerCase().includes(query.toLowerCase())
  })

  return (
    <div className="container page">
      <div className="page-head">
        <div>
          <h1>题目列表</h1>
          <p className="sub">共 {problems.length} 道题目</p>
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
            <div className="empty">暂无题目</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 80 }}>#</th>
                  <th>标题</th>
                  <th style={{ width: 260 }}>标签</th>
                  <th style={{ width: 90 }}>难度</th>
                  <th style={{ width: 110 }}>通过率</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p, i) => {
                  const id = p.id ?? p.problem_id ?? i + 1
                  const diff = diffMap[p.difficulty] || {
                    label: '—',
                    cls: 'badge-easy',
                  }
                  const accept = p.accepted ?? p.ac
                  const total = p.submissions ?? p.submit_total
                  const rate =
                    accept && total ? Math.round((accept / total) * 100) : null
                  return (
                    <tr key={id}>
                      <td className="mono">{id}</td>
                      <td>
                        <Link to={`/problem/${id}`} className="title-link">
                          {p.title || p.name}
                        </Link>
                      </td>
                      <td>
                        <div className="tag-list">
                          {Array.isArray(p.tags) && p.tags.length > 0 ? (
                            p.tags.map((t) => (
                              <span key={t} className="tag">
                                {t}
                              </span>
                            ))
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </div>
                      </td>
                      <td>
                        <span className={'badge ' + diff.cls}>{diff.label}</span>
                      </td>
                      <td className="muted">
                        {rate === null ? '—' : `${rate}%`}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
