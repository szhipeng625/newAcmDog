import {
  getStatusKey,
  verdictInfo,
  extractStats,
  extractAiMessage,
} from '../utils/judge'
import './JudgeResult.css'

export default function JudgeResult({ result }) {
  const status = getStatusKey(result)
  const info = verdictInfo(status)
  const stats = extractStats(result)
  const aiMsg = extractAiMessage(result)
  const stderr = result?.stderr || result?.error || result?.message
  const acCount = result?.ac_count
  const totalCases = result?.total_cases

  return (
    <div className="result">
      <div className="verdict-line">
        <span className={'verdict-badge ' + info.cls}>{info.label}</span>
        {totalCases != null && (
          <span className="progress-text">
            {acCount ?? 0} / {totalCases} 个测试点通过
          </span>
        )}
      </div>
      {(stats.timeMs != null || stats.memMb != null) && (
        <div className="result-meta">
          {stats.timeMs != null && <span>耗时 {stats.timeMs}ms</span>}
          {stats.memMb != null && <span>内存 {stats.memMb}MB</span>}
        </div>
      )}
      {stderr && <pre className="result-output result-err">{stderr}</pre>}
      {result?.stdout && <pre className="result-output">{result.stdout}</pre>}
      {aiMsg && (
        <div className="ai-feedback">
          <span className="ai-feedback-label">AI 助手</span>
          <span>{aiMsg}</span>
        </div>
      )}
    </div>
  )
}
