import { useParams, useNavigate, Link } from 'react-router-dom'
import { useState, useEffect, useRef } from 'react'
import Editor from '@monaco-editor/react'
import { marked } from 'marked'
import { api, isLoggedIn } from '../api/client'
import { useFetch } from '../hooks/useFetch'
import { getStatusKey, isFinal } from '../utils/judge'
import JudgeResult from '../components/JudgeResult.jsx'
import './ProblemDetail.css'

function renderMarkdown(md) {
  if (!md) return ''
  // 后端返回的可能是 Markdown 或已有 HTML，安全起见用 marked 渲染
  try {
    return marked.parse(md)
  } catch {
    return md
  }
}

const LANG = [
  { id: 'c', name: 'C', default: '#include <stdio.h>\n\nint main() {\n    printf("Hello, ACMDOG!\\n");\n    return 0;\n}\n' },
  { id: 'cpp', name: 'C++', default: '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n    cout << "Hello, ACMDOG!" << endl;\n    return 0;\n}\n' },
  { id: 'python', name: 'Python', default: 'print("Hello, ACMDOG!")\n' },
  { id: 'java', name: 'Java', default: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, ACMDOG!");\n    }\n}\n' },
  { id: 'go', name: 'Go', default: 'package main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("Hello, ACMDOG!")\n}\n' },
]

const langLabel = {
  c: 'c',
  cpp: 'cpp',
  python: 'python',
  java: 'java',
  go: 'go',
}

export default function ProblemDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data, loading, error } = useFetch(() => api.problem(id), [id])

  const [code, setCode] = useState('')
  const [lang, setLang] = useState('cpp')
  const [judging, setJudging] = useState(false)
  const [result, setResult] = useState(null)
  const [progress, setProgress] = useState('')
  const [submitTick, setSubmitTick] = useState(0)
  const pollRef = useRef(null)

  useEffect(() => {
    const l = LANG.find((x) => x.id === lang)
    if (l) setCode(l.default)
  }, [lang])

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  const problem = data?.problem || data

  const submit = async () => {
    if (!isLoggedIn()) {
      navigate('/login')
      return
    }
    if (!code.trim()) {
      setResult({ status: 'CE', error: '代码不能为空' })
      return
    }
    setJudging(true)
    setResult(null)
    setProgress('正在提交…')
    try {
      const res = await api.judge({
        code,
        language: langLabel[lang],
        problemId: Number(id),
      })
      const taskId = res?.task_id || res?.taskId
      if (taskId) {
        pollResult(taskId)
      } else {
        throw new Error(res?.error || '提交失败，未返回任务 ID')
      }
    } catch (e) {
      setResult({ status: 'SE', error: e?.message || String(e) })
      setJudging(false)
      setProgress('')
    }
  }

  const pollResult = (taskId) => {
    let tries = 0
    pollRef.current = setInterval(async () => {
      tries += 1
      try {
        const r = await api.judgeResult(taskId)
        const status = getStatusKey(r)
        // 提取进度提示
        if (r?.progress != null) {
          const pct =
            typeof r.progress === 'number' ? r.progress : null
          setProgress(
            pct != null
              ? `评测中 ${pct}%`
              : r.progress === ''
                ? '评测中…'
                : String(r.progress),
          )
        } else if (status === 'judging' || status === 'compiling' || status === 'running') {
          setProgress('评测中…')
        }
        if (isFinal(status) || tries > 60) {
          clearInterval(pollRef.current)
          setResult(r)
          setJudging(false)
          setProgress('')
          // 通知提交记录刷新
          setSubmitTick((t) => t + 1)
        }
      } catch (e) {
        clearInterval(pollRef.current)
        setResult({ status: 'SE', error: e?.message || String(e) })
        setJudging(false)
        setProgress('')
      }
    }, 500)
  }

  if (loading) return <div className="spinner" />
  if (error)
    return <div className="container page empty">加载失败：{error}</div>

  const difficulty = problem?.difficulty
  const diffLabel =
    difficulty === 1 ? '简单' : difficulty === 2 ? '中等' : difficulty === 3 ? '困难' : null

  return (
    <div className="container page problem-page">
      <div className="problem-head">
        <div className="problem-head-left">
          <h1>
            {id}. {problem?.title || problem?.name}
          </h1>
          {diffLabel && <span className="badge badge-medium">{diffLabel}</span>}
        </div>
        <Link to={`/problem/${id}/submissions`} className="btn btn-outline btn-sm">
          查看提交记录
        </Link>
      </div>
      {Array.isArray(problem?.tags) && problem.tags.length > 0 && (
        <div className="tag-list detail-tags">
          {problem.tags.map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}
        </div>
      )}

      <div className="problem-body">
        <div className="card statement">
          <div
            className="statement-content"
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(
                problem?.description ||
                  problem?.statement ||
                  problem?.content ||
                  '暂无题目描述',
              ),
            }}
          />
          {problem?.sample && (
            <div className="samples">
              <h3>样例</h3>
              <pre className="sample-block">{problem.sample}</pre>
            </div>
          )}
        </div>

        <div className="card editor-card">
          <div className="editor-toolbar">
            <select
              className="select lang-select"
              value={lang}
              onChange={(e) => setLang(e.target.value)}
            >
              {LANG.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <button
              className="btn btn-primary"
              onClick={submit}
              disabled={judging}
            >
              {judging ? '评测中…' : '提交评测'}
            </button>
          </div>
          <div className="editor-wrap">
            <Editor
              height="420px"
              language={langLabel[lang]}
              value={code}
              onChange={(v) => setCode(v || '')}
              theme="vs-light"
              options={{
                fontSize: 14,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: true,
              }}
            />
          </div>
          {judging && (
            <div className="result">
              <div className="verdict-line">
                <span className="verdict-badge verdict-judging">评测中…</span>
                {progress && <span className="progress-text">{progress}</span>}
              </div>
            </div>
          )}
          {result && <JudgeResult result={result} />}
        </div>
      </div>
    </div>
  )
}
