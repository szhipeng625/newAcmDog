const TOKEN_KEY = 'acmdog_token'

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || ''
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
}

export function isLoggedIn() {
  return !!getToken()
}

async function request(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  const t = token || getToken()
  if (t) headers['Authorization'] = 'Bearer ' + t

  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    throw new Error(data?.message || data?.error || `HTTP ${res.status}`)
  }
  return data
}

export const api = {
  // 认证
  login: (body) => request('/api/cloud_login', { method: 'POST', body }),
  register: (body) => request('/api/cloud_register', { method: 'POST', body }),
  whoami: (token) => request('/api/cloud_whoami', { token }),

  // 题目
  problems: () => request('/api/cloud_problems'),
  problem: (id) => request(`/api/cloud_problem?id=${encodeURIComponent(id)}`),
  // 热门题：按提交次数排行
  hotProblems: (limit = 20) =>
    request(`/api/hot_problems?limit=${encodeURIComponent(limit)}`),

  // 判题：提交代码（需登录），返回 {task_id, status}
  // body: { code, language, problemId }
  judge: (body) => request('/api/cloud_judge', { method: 'POST', body }),
  judgeResult: (taskId) =>
    request(`/api/cloud_judge_result?task_id=${encodeURIComponent(taskId)}`),

  // 提交历史 & 测试点详情
  // 按题目查询提交记录（需登录；后端按角色隔离：普通用户只看自己）
  statusList: (problemId) =>
    request(`/api/judge_status_list?problem_id=${encodeURIComponent(problemId)}&limit=200`),
  statusDetail: (taskId) =>
    request(`/api/judge_status_detail?task_id=${encodeURIComponent(taskId)}`),
  // 单条提交完整详情（含源码 + 测试点）
  submissionDetail: (taskId) =>
    request(`/api/submission_detail?task_id=${encodeURIComponent(taskId)}`),

  // 竞赛
  contests: () => request('/api/cloud_contests'),
  contest: (id) => request(`/api/cloud_contest?id=${encodeURIComponent(id)}`),
  contestBoard: (cid) =>
    request(`/api/cloud_contest_board?cid=${encodeURIComponent(cid)}`),
  contestRegister: (body) =>
    request('/api/cloud_contest_register', { method: 'POST', body }),

  // AI 助手
  aiHealth: () => request('/api/ai/health'),
  aiMessages: (token) => request('/api/ai/messages', { token }),
  aiChat: (message) => request('/api/ai/chat', { method: 'POST', body: { message } }),
  aiJudgeEvent: (body) => request('/api/ai/judge_event', { method: 'POST', body }),
}

