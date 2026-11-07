import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { useFetch } from '../hooks/useFetch'
import './Contests.css'

export default function Contests() {
  const { data, loading, error } = useFetch(() => api.contests())
  const contests = Array.isArray(data) ? data : data?.contests || []

  return (
    <div className="container page">
      <div className="page-head">
        <h1>竞赛列表</h1>
      </div>

      {loading && <div className="spinner" />}
      {error && <div className="empty">加载失败：{error}</div>}

      {!loading && !error && (
        <div className="contest-grid">
          {contests.length === 0 ? (
            <div className="empty">暂无竞赛</div>
          ) : (
            contests.map((c) => {
              const id = c.id ?? c.contest_id
              return (
                <Link to={`/contest/${id}`} key={id} className="card contest-card">
                  <h3>{c.title || c.name}</h3>
                  <div className="contest-meta">
                    <span>{c.start_time || c.start || '—'}</span>
                    <span>时长 {c.duration || '—'}</span>
                  </div>
                  <div className="contest-status">
                    <span className="badge badge-easy">
                      {c.status || '进行中'}
                    </span>
                  </div>
                </Link>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
