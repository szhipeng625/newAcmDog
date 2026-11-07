import { useState } from 'react'
import { useNavigate, Link, useOutletContext } from 'react-router-dom'
import { api, setToken } from '../api/client'
import './Auth.css'

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const { refreshAuth } = useOutletContext()

  const submit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const res = await api.login({ username, password })
      const token = res?.token || res?.data?.token
      if (token) {
        setToken(token)
        refreshAuth()
        navigate('/')
      } else {
        setError('登录失败：未返回 token')
      }
    } catch (err) {
      setError(err?.message || '登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="container auth-page">
      <form className="card auth-card" onSubmit={submit}>
        <h1 className="auth-title">登录</h1>
        <p className="auth-sub">欢迎回到 ACMDOG</p>

        <div className="field">
          <label>用户名</label>
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="用户名 / 邮箱"
            required
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

        {error && <div className="auth-error">{error}</div>}

        <button className="btn btn-primary auth-submit" disabled={loading}>
          {loading ? '登录中…' : '登录'}
        </button>

        <p className="auth-switch">
          还没有账号？<Link to="/register">立即注册</Link>
        </p>
      </form>
    </div>
  )
}
