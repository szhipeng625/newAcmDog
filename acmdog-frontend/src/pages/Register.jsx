import { useState } from 'react'
import { useNavigate, Link, useOutletContext } from 'react-router-dom'
import { api, setToken } from '../api/client'
import './Auth.css'

export default function Register() {
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const { refreshAuth } = useOutletContext()

  const submit = async (e) => {
    e.preventDefault()
    if (password !== confirm) {
      setError('两次输入的密码不一致')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await api.register({ username, email, password })
      const token = res?.token || res?.data?.token
      if (token) {
        setToken(token)
        refreshAuth()
        navigate('/')
      } else {
        setError('注册失败：未返回 token')
      }
    } catch (err) {
      setError(err?.message || '注册失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="container auth-page">
      <form className="card auth-card" onSubmit={submit}>
        <h1 className="auth-title">注册</h1>
        <p className="auth-sub">创建你的 ACMDOG 账号</p>

        <div className="field">
          <label>用户名</label>
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="用户名"
            required
          />
        </div>
        <div className="field">
          <label>邮箱</label>
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </div>
        <div className="field">
          <label>密码</label>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码"
            required
          />
        </div>
        <div className="field">
          <label>确认密码</label>
          <input
            className="input"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="再次输入密码"
            required
          />
        </div>

        {error && <div className="auth-error">{error}</div>}

        <button className="btn btn-primary auth-submit" disabled={loading}>
          {loading ? '注册中…' : '注册'}
        </button>

        <p className="auth-switch">
          已有账号？<Link to="/login">去登录</Link>
        </p>
      </form>
    </div>
  )
}
