import { useState, useEffect, useRef, useCallback } from 'react'
import { api, isLoggedIn } from '../api/client'
import './AiAssistant.css'

const welcomeMsg = '你好！我是 ACMDOG AI 助手，可以帮你解答算法、数据结构、题目思路等问题。'

// AI 助手专用图标（对话气泡 + 关闭）
function RobotIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="8" width="16" height="11" rx="2" />
      <circle cx="9" cy="13.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="13.5" r="1" fill="currentColor" stroke="none" />
      <path d="M12 8V5M8.5 5h7" />
    </svg>
  )
}

function CloseIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

export default function AiAssistant() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([
    { role: 'bot', content: welcomeMsg },
  ])
  const [input, setInput] = useState('')
  const [typing, setTyping] = useState(false)
  const [logged, setLogged] = useState(isLoggedIn())
  const bodyRef = useRef(null)

  const scrollToBottom = useCallback(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [])

  // 打开时加载历史
  useEffect(() => {
    if (!open) return
    let active = true
    setLogged(isLoggedIn())
    if (isLoggedIn()) {
      api
        .aiMessages()
        .then((history) => {
          if (!active) return
          if (Array.isArray(history) && history.length > 0) {
            const msgs = history.map((h) => ({
              role: h.role === 'assistant' ? 'bot' : 'user',
              content: h.content,
            }))
            setMessages([
              { role: 'bot', content: welcomeMsg },
              ...msgs,
            ])
          }
        })
        .catch(() => {})
    }
    scrollToBottom()
    return () => {
      active = false
    }
  }, [open, scrollToBottom])

  useEffect(() => {
    scrollToBottom()
  }, [messages, typing, scrollToBottom])

  const send = async () => {
    const text = input.trim()
    if (!text || typing) return

    setInput('')
    setMessages((prev) => [...prev, { role: 'user', content: text }])
    setTyping(true)

    if (!isLoggedIn()) {
      setMessages((prev) => [
        ...prev,
        { role: 'bot', content: '请先登录后再与 AI 助手对话。' },
      ])
      setTyping(false)
      return
    }

    try {
      const res = await api.aiChat(text)
      const reply = res?.reply || res?.error || '（无回复）'
      setMessages((prev) => [...prev, { role: 'bot', content: reply }])
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: 'bot', content: '发送失败：' + (e?.message || String(e)) },
      ])
    } finally {
      setTyping(false)
    }
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <>
      <button
        className="ai-btn"
        onClick={() => setOpen((v) => !v)}
        title="ACMDOG AI 助手"
      >
        {open ? <CloseIcon /> : <RobotIcon />}
      </button>

      {open && (
        <div className="ai-panel">
          <div className="ai-header">
            <span className="ai-header-title">
              <RobotIcon size={16} />
              <span>ACMDOG AI 助手</span>
            </span>
            <button className="ai-close" onClick={() => setOpen(false)}>
              <CloseIcon size={16} />
            </button>
          </div>

          <div className="ai-messages" ref={bodyRef}>
            {messages.map((m, i) => (
              <div key={i} className={'ai-msg ' + m.role}>
                <span
                  className="ai-msg-content"
                  dangerouslySetInnerHTML={{
                    __html: renderAI(m.content),
                  }}
                />
              </div>
            ))}
            {typing && (
              <div className="ai-typing">
                <span />
                <span />
                <span />
              </div>
            )}
          </div>

          <div className="ai-input-area">
            <textarea
              rows={1}
              placeholder={logged ? '输入问题… (Enter发送)' : '登录后可对话'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <button onClick={send} disabled={typing || !input.trim()}>
              发送
            </button>
          </div>
        </div>
      )}
    </>
  )
}

// 简单渲染：把 markdown 代码块和行内代码转成 HTML，其余纯文本
function renderAI(text) {
  if (!text) return ''
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  return escaped
    .replace(/```([\s\S]*?)```/g, (_, code) => {
      return '<pre>' + code.replace(/^\n/, '') + '</pre>'
    })
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br/>')
}
