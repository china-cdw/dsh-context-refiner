// dsh-context-refiner · 宿主 HTTP 接口
//
// 只有两条：
//   GET  /dsh-context-refiner/state?sessionId=…  看一眼能不能重置、日志多大、bili 报的占用
//   POST /dsh-context-refiner/reset              真做重置（离线，不花模型）
//
// 安全模型与 dsh-soul-memory 的设置页一致：只接受本机回环 Host、同源 Origin、
// 自定义头 x-dsh-context-refiner: 1，写接口还要求令牌（state 里下发）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { decodeLog, eventGap, findSessionLog, fileSize, readLogBuffer } from './log.js'
import { assertSessionId, biliLedgerDir, resetSession, resolveHome } from './reset.js'

const PREFIX = '/dsh-context-refiner/'
const GUARD_HEADER = 'x-dsh-context-refiner'
const TOKEN_HEADER = 'x-dsh-context-refiner-token'
const BODY_LIMIT = 256 * 1024
// 缓存要带上 home：换 home/开测试实例时不能把别处的令牌当自己的。
let cachedToken = { home: '', token: '' }

/** 写令牌：持久化在 <home>/context-refiner/.token，热重载后页面不用刷新。 */
function writeToken(home) {
  if (cachedToken.home === home && cachedToken.token) return cachedToken.token
  const file = join(home, 'context-refiner', '.token')
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{32}$/.test(existing)) {
      cachedToken = { home, token: existing }
      return existing
    }
  } catch { /* 第一次运行 */ }
  const token = randomBytes(16).toString('hex')
  try {
    mkdirSync(join(home, 'context-refiner'), { recursive: true })
    writeFileSync(file, token, 'utf8')
  } catch (error) {
    console.error('dsh-context-refiner: 写令牌存不下来，只在本次运行内有效', error?.message ?? error)
  }
  cachedToken = { home, token }
  return token
}

function sendJson(res, code, payload) {
  try {
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  } catch { /* 已发出 */ }
}

function isLoopbackHost(req) {
  const host = String(req.headers.host || '').toLowerCase()
  if (!host) return true
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '')
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(name)
}

function guard(req, res, needsJson) {
  if (!isLoopbackHost(req)) { sendJson(res, 403, { error: '仅允许本机页面访问' }); return false }
  if (req.method !== 'GET' && req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); sendJson(res, 405, { error: '仅支持 GET / POST' }); return false }
  const origin = req.headers.origin
  if (origin) {
    let same = false
    try { same = new URL(origin).host === req.headers.host } catch { same = false }
    if (!same) { sendJson(res, 403, { error: '跨源请求被拒绝' }); return false }
  }
  if (String(req.headers[GUARD_HEADER] || '') !== '1') { sendJson(res, 403, { error: '缺少 ' + GUARD_HEADER + ': 1 请求头' }); return false }
  if (needsJson && !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) { sendJson(res, 415, { error: 'Content-Type 必须是 application/json' }); return false }
  return true
}

function requireToken(req, res, home) {
  if (String(req.headers[TOKEN_HEADER] || '') !== writeToken(home)) {
    sendJson(res, 403, { error: '写操作令牌不对，刷新一次页面再试' })
    return false
  }
  return true
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) { resolve({ tooLarge: true }); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) { resolve({ value: {} }); return }
      try { resolve({ value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) } catch { resolve({ value: null }) }
    })
    req.on('error', () => resolve({ value: null }))
  })
}

/** 从 bili 的 proxy-origin 文件里拿代理地址（拿不到就不探测）。 */
function biliOrigin() {
  const file = join(homedir(), '.local', 'state', 'billion-context', 'proxy-origin')
  for (const path of [file]) {
    try {
      const text = readFileSync(path, 'utf8').trim()
      if (/^https?:\/\//.test(text)) return text.replace(/\/$/, '')
      // 现在这个文件是 JSON：{"origin":"http://127.0.0.1:18789","instanceId":…}
      try {
        const parsed = JSON.parse(text)
        const origin = typeof parsed?.origin === 'string' ? parsed.origin : ''
        if (/^https?:\/\//.test(origin)) return origin.replace(/\/$/, '')
      } catch { /* 不是 JSON，继续返回 null */ }
    } catch { /* 没有这个文件 */ }
  }
  return null
}

async function biliStatus(sessionId) {
  const origin = biliOrigin()
  if (!origin) return { ok: false, reason: '找不到 billion-context 的代理地址' }
  try {
    const res = await fetch(origin + '/__bili/plugin/status?conversationId=' + encodeURIComponent(sessionId) + '&fallback=latest', { signal: AbortSignal.timeout(2500) })
    if (!res.ok) return { ok: false, reason: '状态接口返回 ' + res.status }
    const body = await res.json()
    return { ok: true, contextTokens: body.contextTokens ?? null, contextLimit: body.contextLimit ?? null, model: body.model ?? null }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

/**
 * 注册两条路由。
 * @param {any} ctx 宿主 context（需要有 webServer 服务）
 */
export function registerRefinerRoutes(ctx) {
  const home = resolveHome()
  const disposers = []
  const mounted = []
  const route = (spec) => {
    try {
      const dispose = ctx.webServer.register(spec)
      mounted.push(dispose)
      return dispose
    } catch (error) {
      for (const stop of mounted.splice(0).reverse()) { try { stop() } catch { /* best effort */ } }
      throw error
    }
  }

  disposers.push(route({
    kind: 'exact',
    path: PREFIX + 'state',
    async handler(req, res) {
      try {
        if (!guard(req, res, false)) return
        if (req.method !== 'GET') { sendJson(res, 405, { error: '该接口只支持 GET' }); return }
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const sessionId = url.searchParams.get('sessionId') || ''
        if (!sessionId) { sendJson(res, 400, { error: '缺 sessionId' }); return }
        try { assertSessionId(sessionId) } catch (error) { sendJson(res, 400, { error: String(error?.message ?? error) }); return }
        let log = { found: false }
        try {
          const found = findSessionLog(home, sessionId)
          if (found) {
            log = { found: true, file: found.file, bytes: fileSize(found.file) }
            // 宿主用旧游标追加过（seq 有洞）的日志已经打不开，前端要拦住，不能报「健康」。
            try {
              const parsed = decodeLog(readLogBuffer(found.file))
              const at = eventGap(parsed.events)
              log.events = parsed.events.length
              log.contiguous = at < 0
              if (at >= 0) { log.gapAt = at; log.damaged = true }
            } catch (error) {
              log.damaged = true
              log.error = String(error?.message ?? error)
            }
          }
        } catch (error) { log = { found: false, error: String(error?.message ?? error) } }
        sendJson(res, 200, {
          ok: true,
          token: writeToken(home),
          home,
          biliLedgerDir: biliLedgerDir(),
          exists: existsSync(biliLedgerDir()),
          log,
          bili: sessionId ? await biliStatus(sessionId) : null,
        })
      } catch (error) {
        console.error('dsh-context-refiner: state 出错', error)
        sendJson(res, 500, { error: '读状态失败：' + String(error?.message ?? error) })
      }
    },
  }))

  disposers.push(route({
    kind: 'exact',
    path: PREFIX + 'reset',
    async handler(req, res) {
      try {
        if (!guard(req, res, true)) return
        if (req.method !== 'POST') { sendJson(res, 405, { error: '该接口只支持 POST' }); return }
        if (!requireToken(req, res, home)) return
        const body = await readJsonBody(req)
        if (body.tooLarge) { sendJson(res, 413, { error: '请求体太大' }); return }
        if (!body.value) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
        const { sessionId, confirm, dryRun, brief } = body.value
        if (confirm !== 'reset') { sendJson(res, 400, { error: '缺 confirm: "reset"，重置会丢旧记录，必须确认' }); return }
        const report = await resetSession({ sessionId, home, dryRun: !!dryRun, brief })
        sendJson(res, 200, report)
      } catch (error) {
        if (error?.code === 'RESET_BUSY') {
          sendJson(res, 409, { error: String(error?.message ?? error) })
          return
        }
        if (error?.code === 'RESET_INVALID') {
          sendJson(res, 400, { error: String(error?.message ?? error) })
          return
        }
        console.error('dsh-context-refiner: reset 失败', error)
        sendJson(res, 500, { error: String(error?.message ?? error) })
      }
    },
  }))

  return () => {
    for (const stop of disposers.splice(0).reverse()) { try { stop() } catch { /* best effort */ } }
  }
}
