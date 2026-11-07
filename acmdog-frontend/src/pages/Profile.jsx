import { useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { api, getToken, clearToken } from '../api/client'
import { useFetch } from '../hooks/useFetch'
import './Profile.css'

export default function Profile() {
  const navigate = useNavigate()
  const token = getToken()
  const { data, loading, error } = useFetch(() => api.whoami(token), [token])
  const [msg, setMsg] = useState(null)

  const user = data?.user || data

  const logout = () => {
    clearToken()
    navigate('/')
  }

  if (loading) return <div className="spinner" />
  if (error)
    return (
      <div className="container page empty">
        <p>{error}</p>
        <button className="btn btn-outline" onClick={() => navigate('/login')}>
          去登录
        </button>
      </div>
    )

  return (
    <div className="container page profile-page">
      <div className="page-head">
        <h1>个人中心</h1>
      </div>
      {msg && <div className="toast">{msg}</div>}

      <div className="card profile-card">
        <div className="avatar">{String(user?.username || user?.name || '?')[0]?.toUpperCase()}</div>
        <div className="profile-info">
          <h2>{user?.username || user?.name || '未知用户'}</h2>
          <p className="muted">{user?.email || '—'}</p>
          {user?.solved !== undefined && (
            <p className="muted">已解决题目：{user.solved}</p>
          )}
        </div>
      </div>

      <button
        className="btn btn-outline"
        onClick={() => setMsg('（演示）暂无更多资料')}
      >
        刷新资料
      </button>
    </div>
  )
}
