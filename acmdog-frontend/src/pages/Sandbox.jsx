import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import Editor from '@monaco-editor/react'
import { api, isLoggedIn } from '../api/client'
import { useFetch } from '../hooks/useFetch'
import { getStatusKey, isFinal } from '../utils/judge'
import JudgeResult from '../components/JudgeResult.jsx'
import './Sandbox.css'

const LANGS = {
  c: { name: 'C', monaco: 'c', default: '#include <stdio.h>\n\nint main() {\n    printf("Hello, ACMDOG!\\n");\n    return 0;\n}\n' },
  cpp: { name: 'C++', monaco: 'cpp', default: '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n    cout << "Hello, ACMDOG!" << endl;\n    return 0;\n}\n' },
  python: { name: 'Python', monaco: 'python', default: 'print("Hello, ACMDOG!")\n' },
  java: { name: 'Java', monaco: 'java', default: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, ACMDOG!");\n    }\n}\n' },
  go: { name: 'Go', monaco: 'go', default: 'package main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("Hello, ACMDOG!")\n}\n' },
}

export default function Sandbox() {
  const navigate = useNavigate()
  const { data: problemsData } = useFetch(() => api.problems())
  const problems = Array.isArray(problemsData)
    ? problemsData
    : problemsData?.problems || []

  const [problemId, setProblemId] = useState('')
  const [lang, setLang] = useState('cpp')
  const [code, setCode] = useState('')
  const [judging, setJudging] = useState(false)
  const [result, setResult] = useState(null)
  const [progress, setProgress] = useState('')
  const pollRef = useRef(null)

  // 默认选中第一道题，并加载默认代码
  useEffect(() => {
    if (problems.length > 0 && !problemId) {
      setProblemId(String(problems[0].id))
    }
  }, [problems, problemId])

  useEffect(() => {
    setCode(LANGS[lang].default)
  }, [lang])

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  const run = async () => {
    if (!problemId) {
      setResult({ status: 'SE', error: '请选择一道题目' })
      return
    }
    if (!isLoggedIn()) {
      navigate('/login')
      return
    }
    if (!code.trim()) {
      setResult({ status: 'SE', error: '代码不能为空' })
      return
    }
    setJudging(true)
    setResult(null)
    setProgress('正在提交…')
    try {
      const res = await api.judge({
        code,
        language: lang,
        problemId: Number(problemId),
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
        if (r?.progress != null) {
          setProgress(
            typeof r.progress === 'number' ? `评测中 ${r.progress}%` : String(r.progress),
          )
        } else if (['judging', 'compiling', 'running'].includes(status)) {
          setProgress('评测中…')
        } else {
          setProgress('排队中…')
        }
        if (isFinal(status) || tries > 60) {
          clearInterval(pollRef.current)
          setResult(r)
          setJudging(false)
          setProgress('')
        }
      } catch (e) {
        clearInterval(pollRef.current)
        setResult({ status: 'SE', error: e?.message || String(e) })
        setJudging(false)
        setProgress('')
      }
    }, 500)
  }

  const currentProblem = problems.find((p) => String(p.id) === problemId)

  return (
    <div className="container page">
      <div className="page-head">
        <h1>在线沙盒</h1>
      </div>
      <p className="sandbox-hint">
        选择一道题目，编写代码并在线评测。支持 C / C++ / Python / Java / Go 五种语言。
      </p>

      <div className="sandbox-grid">
        <div className="card sandbox-card">
          <div className="editor-toolbar">
            <select
              className="select problem-select"
              value={problemId}
              onChange={(e) => setProblemId(e.target.value)}
            >
              <option value="" disabled>
                选择题目…
              </option>
              {problems.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.id}. {p.title || p.name}
                </option>
              ))}
            </select>
            <select
              className="select lang-select"
              value={lang}
              onChange={(e) => setLang(e.target.value)}
            >
              {Object.entries(LANGS).map(([key, l]) => (
                <option key={key} value={key}>
                  {l.name}
                </option>
              ))}
            </select>
            <button className="btn btn-primary" onClick={run} disabled={judging}>
              {judging ? '评测中…' : '运行评测'}
            </button>
          </div>

          {currentProblem && (
            <div className="problem-brief">
              <span className="brief-title">
                {currentProblem.id}. {currentProblem.title || currentProblem.name}
              </span>
              <span className="brief-limits">
                时限 {currentProblem.timeMs ?? 1000}ms · 内存 {currentProblem.memMb ?? 256}MB
              </span>
            </div>
          )}

          <div className="editor-wrap sandbox-editor">
            <Editor
              height="420px"
              language={LANGS[lang].monaco}
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
        </div>

        <div className="card sandbox-output">
          <h3 className="output-title">评测结果</h3>
          {!result && !judging && (
            <div className="empty">运行结果将显示在这里</div>
          )}
          {judging && !result && (
            <div className="judge-progress">
              <div className="verdict-badge verdict-judging">
                {progress || '评测中…'}
              </div>
            </div>
          )}
          {result && <JudgeResult result={result} />}
        </div>
      </div>
    </div>
  )
}
