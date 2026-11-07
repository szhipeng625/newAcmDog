// 判题结果（verdict）的中文显示与颜色映射
export const VERDICT_MAP = {
  AC: { label: '通过', color: '#1c8755', cls: 'verdict-ac' },
  Accepted: { label: '通过', color: '#1c8755', cls: 'verdict-ac' },
  WA: { label: '答案错误', color: '#c0392b', cls: 'verdict-wa' },
  'Wrong Answer': { label: '答案错误', color: '#c0392b', cls: 'verdict-wa' },
  TLE: { label: '超时', color: '#c07d1e', cls: 'verdict-tle' },
  'Time Limit Exceeded': { label: '超时', color: '#c07d1e', cls: 'verdict-tle' },
  MLE: { label: '内存超限', color: '#c07d1e', cls: 'verdict-tle' },
  'Memory Limit Exceeded': { label: '内存超限', color: '#c07d1e', cls: 'verdict-tle' },
  RE: { label: '运行时错误', color: '#c0392b', cls: 'verdict-wa' },
  'Runtime Error': { label: '运行时错误', color: '#c0392b', cls: 'verdict-wa' },
  CE: { label: '编译错误', color: '#8b5cf6', cls: 'verdict-ce' },
  'Compile Error': { label: '编译错误', color: '#8b5cf6', cls: 'verdict-ce' },
  SE: { label: '系统错误', color: '#c0392b', cls: 'verdict-wa' },
  'System Error': { label: '系统错误', color: '#c0392b', cls: 'verdict-wa' },
  OLE: { label: '输出超限', color: '#c07d1e', cls: 'verdict-tle' },
  PE: { label: '格式错误', color: '#c07d1e', cls: 'verdict-tle' },
  pending: { label: '排队中', color: '#7a828e', cls: 'verdict-pending' },
  queued: { label: '排队中', color: '#7a828e', cls: 'verdict-pending' },
  judging: { label: '评测中', color: '#3b82c4', cls: 'verdict-judging' },
  compiling: { label: '编译中', color: '#3b82c4', cls: 'verdict-judging' },
  running: { label: '运行中', color: '#3b82c4', cls: 'verdict-judging' },
}

export function getStatusKey(result) {
  const s = result?.status || result?.verdict || result?.result
  if (!s) return 'pending'
  return s
}

export function isFinal(status) {
  return status && !['pending', 'judging', 'compiling', 'running', 'queued'].includes(status)
}

export function verdictInfo(status) {
  return VERDICT_MAP[status] || { label: status || '未知', color: '#7a828e', cls: 'verdict-pending' }
}

// 从结果中提取耗时（ms）与内存
export function extractStats(result) {
  let timeMs =
    result?.timeMs ??
    result?.time_ms ??
    result?.cpu_ms ??
    null
  if (timeMs == null && result?.cpu_ns != null) {
    timeMs = Math.round(result.cpu_ns / 1e6)
  }
  let memMb =
    result?.memMb ??
    result?.mem_mb ??
    null
  if (memMb == null && result?.mem_bytes != null) {
    memMb = (result.mem_bytes / 1024 / 1024).toFixed(1)
  }
  return { timeMs, memMb }
}

// AI 反馈消息
export function extractAiMessage(result) {
  return result?.ai_message?.reply || null
}
