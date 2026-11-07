import { useParams, Link } from 'react-router-dom'
import { useState, useEffect, useCallback } from 'react'
import Editor from '@monaco-editor/react'
import { api } from '../api/client'
import { verdictInfo } from '../utils/judge'
import './Submissions.css'

function statusOf(item) {
  return item.judge_status || item.submit_status || 'pending'
}

export default function Submissions() {
  const { id } = useParams()
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [detailTaskId, setDetailTaskId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailError, setDetailError] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.statusList(id)
      setList(Array.isArray(data) ? data : [])
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  const openDetail = async (taskId) => {
    if (!taskId) return
    if (detailTaskId === taskId) {
      setDetailTaskId(null)
      setDetail(null)
      setDetailError(null)
      return
    }
    setDetailTaskId(taskId)
    setDetailLoading(true)
    setDetail(null)
    setDetailError(null)
    try {
      const d = await api.submissionDetail(taskId)
      setDetail(d)
    } catch (e) {
      setDetailError(e?.message || String(e))
    } finally {
      setDetailLoading(false)
    }
  }

  return (
    <div className="container page submissions-page">
      <div className="page-head">
        <div>
          <h1>提交记录</h1>
          <p className="sub">
            <Link to={`/problem/${id}`} className="back-link">
              ← 返回题目 {id}
            </Link>
          </p>
        </div>
      </div>

      {loading && <div className="spinner" />}
      {error && <div className="empty">加载失败：{error}</div>}

      {!loading && !error && list.length === 0 && (
        <div className="empty">暂无提交记录</div>
      )}

      {!loading && !error && list.length > 0 && (
        <div className="card sub-list">
          {list.map((item) => {
            const st = statusOf(item)
            const info = verdictInfo(st)
            return (
              <div key={item.task_id || item.id} className="sub-item-wrap">
                <div
                  className="sub-item"
                  onClick={() => openDetail(item.task_id)}
                >
                  <span className={'sub-verdict ' + info.cls}>{info.label}</span>
                  <span className="sub-user">{item.username || '—'}</span>
                  <span className="sub-lang">{item.language || '—'}</span>
                  <span className="sub-time">{formatTime(item.submit_time)}</span>
                  {item.total_cases != null && (
                    <span className="sub-cases">
                      {item.ac_count ?? 0}/{item.total_cases}
                    </span>
                  )}
                  <span className="sub-arrow">
                    {detailTaskId === item.task_id ? '▾' : '▸'}
                  </span>
                </div>

                {detailTaskId === item.task_id && (
                  <SubDetail loading={detailLoading} detail={detail} detailError={detailError} />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SubDetail({ loading, detail, detailError }) {
  if (loading) return <div className="sub-detail sub-detail-loading">加载详情…</div>
  if (detailError) return <div className="sub-detail sub-error">{detailError}</div>
  if (!detail) return null

  const langMap = { c: 'c', cpp: 'cpp', python: 'python', java: 'java', go: 'go' }
  const lang = langMap[detail.language] || 'cpp'
  const cases = detail.cases || []
  const summaryError = detail.error || ''

  return (
    <div className="sub-detail">
      <div className="sub-detail-meta">
        <span className={'sub-verdict ' + (verdictInfo(detail.judge_status || detail.submit_status).cls)}>
          {verdictInfo(detail.judge_status || detail.submit_status).label}
        </span>
        {detail.cpu_ms != null && <span>耗时 {detail.cpu_ms}ms</span>}
        {detail.mem_mb != null && <span>内存 {detail.mem_mb}MB</span>}
        {detail.total_cases != null && (
          <span>
            {detail.ac_count ?? 0}/{detail.total_cases} 通过
          </span>
        )}
      </div>

      {summaryError && (
        <div className="sub-detail-summary-error">判题信息：{summaryError}</div>
      )}


      {/* 源码 */}
      {detail.code ? (
        <div className="sub-code">
          <div className="sub-code-header">提交源码</div>
          <div className="sub-code-editor">
            <Editor
              height="260px"
              language={lang}
              value={detail.code}
              theme="vs-light"
              options={{
                readOnly: true,
                fontSize: 13,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: true,
              }}
            />
          </div>
        </div>
      ) : (
        <div className="sub-no-code">（无源码）</div>
      )}

      {/* 测试点详情 */}
      {cases.length > 0 ? (
        <div className="sub-cases-block">
          <div className="sub-code-header">测试点</div>
          <div className="sub-cases-grid">
            {cases.map((c, i) => {
              const cinfo = verdictInfo(c.status)
              return (
                <div className="sub-case" key={i}>
                  <span className="sub-case-name">
                    {c.case_name || `#${c.case_index ?? i + 1}`}
                  </span>
                  <span className={'sub-case-status ' + cinfo.cls}>{cinfo.label}</span>
                  {c.cpu_ms != null && (
                    <span className="sub-case-time">{c.cpu_ms}ms</span>
                  )}
                  {c.error && (
                    <span className="sub-case-error" title={c.error}>
                      {c.error}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="sub-no-code">暂无测试点数据</div>
      )}
    </div>
  )
}

function formatTime(t) {
  if (!t) return '—'
  try {
    // 后端返回无时区 datetime 字符串（如 2026-11-07 06:36:49），按 UTC 解析后显示为服务器时区（Asia/Shanghai）
    const s = String(t).trim().replace(' ', 'T')
    const d = /Z$/.test(s) ? new Date(s) : new Date(s + 'Z')
    if (isNaN(d.getTime())) return String(t)
    return d.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return String(t)
  }
}
