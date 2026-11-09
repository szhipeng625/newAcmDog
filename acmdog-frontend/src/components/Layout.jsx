import { NavLink, Link, Outlet, useNavigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { isLoggedIn, clearToken, getToken, api } from '../api/client'
import AiAssistant from './AiAssistant.jsx'
import './Layout.css'

const navItems = [
  { to: '/', label: '首页', end: true },
  { to: '/problems', label: '题目' },
  { to: '/contests', label: '竞赛' },
  { to: '/sandbox', label: '沙盒' },
  { to: '/hot-problems', label: '热门题' },
  { to: '/author', label: '作者' },
]

export default function Layout() {
  const [logged, setLogged] = useState(isLoggedIn())
  const [role, setRole] = useState('')
  const [checking, setChecking] = useState(true)
  const navigate = useNavigate()

  // 进入网站先校验登录态：用 whoami 验证 token 是否有效
  useEffect(() => {
    const token = getToken()
    if (!token) {
      setLogged(false)
      setChecking(false)
      return
    }
    api
      .whoami(token)
      .then((d) => {
        if (d?.ok === false || !d?.username) {
          // token 失效，清除
          clearToken()
          setLogged(false)
        } else {
          setLogged(true)
          setRole(d?.role || 'user')
        }
      })
      .catch(() => {
        clearToken()
        setLogged(false)
      })
      .finally(() => setChecking(false))
  }, [])

  const logout = () => {
    clearToken()
    setLogged(false)
    navigate('/')
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="container topbar-inner">
          <Link to="/" className="brand">
            <img className="brand-logo" src="/logo.png" alt="ACMDOG" />
            <span className="brand-name">ACMDOG</span>
          </Link>
          <nav className="nav">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  'nav-link' + (isActive ? ' active' : '')
                }
              >
                {item.label}
              </NavLink>
            ))}
            {role === 'admin' && (
              <NavLink to="/admin/users" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>后台</NavLink>
            )}
            {(role === 'admin' || role === 'author') && (
              <NavLink to="/admin/problems" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>管理</NavLink>
            )}
          </nav>
          <div className="topbar-actions">
            {checking ? null : logged ? (
              <>
                <Link to="/profile" className="btn btn-outline btn-sm">
                  个人中心
                </Link>
                <button className="btn btn-ghost btn-sm" onClick={logout}>
                  退出
                </button>
              </>
            ) : (
              <>
                <Link to="/login" className="btn btn-outline btn-sm">
                  登录
                </Link>
                <Link to="/register" className="btn btn-primary btn-sm">
                  注册
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="main">
        <Outlet context={{ refreshAuth: () => setLogged(isLoggedIn()) }} />
      </main>

      <footer className="footer">
        <div className="container">
          <span>ACMDOG · 算法竞赛综合平台</span>
          <span className="footer-right">React 19 · Powered by ACMDOG</span>
        </div>
      </footer>

      <AiAssistant />
    </div>
  )
}
