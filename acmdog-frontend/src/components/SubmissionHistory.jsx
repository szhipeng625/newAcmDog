import { useState, useEffect, useCallback } from 'react'
import Editor from '@monaco-editor/react'
import { api } from '../api/client'
import { verdictInfo } from '../utils/judge'
import './SubmissionHistory.css'

const langMap = { c: 'c', cpp: 'cpp', python: 'python', java: 'java', go: 'go' }

// 将 submit 记录映射为展示状态
function statusOf(item) {
  return item.judge_status || item.submit_status || 'pending'
}

export default function SubmissionHistory({ problemId, onSubmitted }) {
  const [expanded, setExpanded] = useState(false)
  const [loaded, setLoaded] = useState(false) // 是否已首次加载
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [detailTaskId, setDetailTaskId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailError, setDetailError] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.statusList(problemId)
      setList(Array.isArray(data) ? data : [])
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [problemId])

  // 懒加载：仅当展开时触发首次查询
  useEffect(() => {
    if (expanded && !loaded) {
      setLoaded(true)
      load()
    }
  }, [expanded, loaded, load])

  // 提交成功后（onSubmitted 变化）刷新列表
  useEffect(() => {
    if (expanded && onSubmitted) load()
  }, [onSubmitted])

  const toggleExpand = () => {
    setExpanded((v) => !v)
  }

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
    <div className="submission-history">
      <div className="sh-head" onClick={toggleExpand}>
        <h3>提交记录</h3>
        <span className={'sh-toggle-icon' + (expanded ? ' open' : '')}>
          {expanded ? '▾' : '▸'}
        </span>
      </div>

      {expanded && (
        <div className="sh-body">
          {loading && <div className="sh-loading">加载中…</div>}
          {error && <div className="sh-error">{error}</div>}

          {!loading && !error && list.length === 0 && (
            <div className="sh-empty">暂无提交记录</div>
          )}

          {!loading && !error && list.length > 0 && (
            <div className="sh-list">
              {list.map((item) => {
                const st = statusOf(item)
                const info = verdictInfo(st)
                return (
                  <div key={item.task_id || item.id} className="sh-item-wrap">
                    <div
                      className="sh-item"
                      onClick={() => openDetail(item.task_id)}
                    >
                      <span className={'sh-verdict ' + info.cls}>{info.label}</span>
                      <span className="sh-user">{item.username || '—'}</span>
                      <span className="sh-lang">{item.language || '—'}</span>
                      <span className="sh-time">{formatTime(item.submit_time)}</span>
                      {item.total_cases != null && (
                        <span className="sh-cases">
                          {item.ac_count ?? 0}/{item.total_cases}
                        </span>
                      )}
                      <span className="sh-arrow">
                        {detailTaskId === item.task_id ? '▾' : '▸'}
                      </span>
                    </div>

                    {detailTaskId === item.task_id && (
                      <DetailPanel loading={detailLoading} detail={detail} detailError={detailError} />
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DetailPanel({ loading, detail, detailError }) {
  if (loading) return <div className="sh-detail sh-detail-loading">加载测试详情…</div>
  if (detailError) return <div className="sh-detail sh-error">{detailError}</div>
  if (!detail) return null

  const cases = Array.isArray(detail) ? detail : detail.cases || []
  const judging = detail.judging
  const progress = detail.progress
  const code = !Array.isArray(detail) && detail && detail.code ? detail.code : ''
  const lang = langMap[detail && detail.language] || 'cpp'
  const summaryError = !Array.isArray(detail) && detail && detail.error ? detail.error : ''

  return (
    <div className="sh-detail">
      <div className="sub-code">
        <div className="sub-code-header">源码 · {lang.toUpperCase()}</div>
        {code ? (
          <div className="sub-code-editor">
            <Editor
              height="260px"
              theme="vs-light"
              language={lang}
              value={code}
              options={{ readOnly: true, fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true }}
            />
          </div>
        ) : (
          <div className="sub-no-code">（无源码）</div>
        )}
      </div>
      {summaryError && (
        <div className="sh-detail-summary-error">判题信息：{summaryError}</div>
      )}
      {judging && progress != null && (
        <div className="sh-progress">
          <span className="verdict-badge verdict-judging">评测中 {progress}%</span>
        </div>
      )}
      {cases.length === 0 ? (
        <div className="sh-detail-empty">暂无测试点数据</div>
      ) : (
        <div className="sh-case-grid">
          {cases.map((c, i) => {
            const st = c.status
            const info = verdictInfo(st)
            return (
              <div className="sh-case" key={i}>
                <span className="sh-case-name">{c.case_name || `#${c.case_index ?? i + 1}`}</span>
                <span className={'sh-case-status ' + info.cls}>{info.label}</span>
                {c.cpu_ms != null && (
                  <span className="sh-case-time">{c.cpu_ms}ms</span>
                )}
                {c.error && (
                  <span className="sh-case-error" title={c.error}>
                    {c.error}
                  </span>
                )}
              </div>
            )
          })}
        </div>
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
