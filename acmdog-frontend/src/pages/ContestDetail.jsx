import { useParams } from 'react-router-dom'
import { useState } from 'react'
import { api, isLoggedIn } from '../api/client'
import { useFetch } from '../hooks/useFetch'
import './ContestDetail.css'

export default function ContestDetail() {
  const { id } = useParams()
  const { data, loading, error } = useFetch(() => api.contest(id), [id])
  const [msg, setMsg] = useState(null)

  const contest = data?.contest || data
  const problems = contest?.problems || data?.problems || []

  const register = async () => {
    if (!isLoggedIn()) {
      setMsg('请先登录')
      return
    }
    try {
      await api.contestRegister({ contest_id: Number(id) })
      setMsg('报名成功')
    } catch (e) {
      setMsg(e?.message || '报名失败')
    }
  }

  if (loading) return <div className="spinner" />
  if (error) return <div className="container page empty">加载失败：{error}</div>

  return (
    <div className="container page">
      <div className="page-head">
        <h1>{contest?.title || contest?.name || `竞赛 ${id}`}</h1>
        <button className="btn btn-primary" onClick={register}>
          报名参赛
        </button>
      </div>
      {msg && <div className="toast">{msg}</div>}

      <div className="card contest-info">
        <div className="info-row">
          <span className="info-label">开始时间</span>
          <span>{contest?.start_time || contest?.start || '—'}</span>
        </div>
        <div className="info-row">
          <span className="info-label">时长</span>
          <span>{contest?.duration || '—'}</span>
        </div>
      </div>

      <h2 className="section-title">题目</h2>
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 60 }}>#</th>
              <th>标题</th>
            </tr>
          </thead>
          <tbody>
            {problems.map((p, i) => (
              <tr key={p.id ?? i}>
                <td className="mono">{String.fromCharCode(65 + i)}</td>
                <td>{p.title || p.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
