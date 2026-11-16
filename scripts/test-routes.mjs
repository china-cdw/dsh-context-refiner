import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { decodeLog, encodeLog } from '../host/log.js'

// 用临时 home，绝不碰真实会话与真实 bili 账本。
const here = path.dirname(fileURLToPath(import.meta.url))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'refiner-home-'))
const realHome = process.env.DSH_HOME || 'E:/DSH/home'
const donor = path.join(realHome, 'sessions')

// 找一个小会话当素材，复制到临时 home，并换成一个不存在的 ID（防止账本匹配到真会话）。
function findDonor() {
  const projects = fs.readdirSync(donor)
  let best = null
  for (const project of projects) {
    const dir = path.join(donor, project)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const sid of fs.readdirSync(dir)) {
      const log = path.join(dir, sid, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(log)) continue
      const size = fs.statSync(log).size
      if (size > 20000 && size < 300000) { best = { sid, log, size }; break }
    }
    if (best) break
  }
  if (!best) throw new Error('找不到可用的小会话')
  return best
}
const donorInfo = findDonor()
const sessionId = 'session-00000000-0000-0000-0000-0000000000aa'
const targetDir = path.join(home, 'sessions', '--temp-project--', sessionId)
fs.mkdirSync(targetDir, { recursive: true })
const copied = path.join(targetDir, 'session.v4.jsonl.zstd')
fs.copyFileSync(donorInfo.log, copied)
// 目录名和 header.id 必须一致（插件会核对 header.id），所以把素材的 id 换成这个假 ID。
const donorLog = decodeLog(fs.readFileSync(copied))
const donorHeader = JSON.parse(donorLog.headerLine)
donorHeader.id = sessionId
fs.writeFileSync(copied, encodeLog(JSON.stringify(donorHeader), donorLog.events, !!donorLog.plain))
const projDir = path.join(home, 'storages', 'session_projcache', 'sessions')
fs.mkdirSync(projDir, { recursive: true })
fs.writeFileSync(path.join(projDir, sessionId + '.json'), '{"version":7}')

process.env.DSH_HOME = home
const { registerRefinerRoutes } = await import('../host/routes.js')

const routes = new Map()
const disposers = []
const ctx = {
  webServer: {
    register(spec) { routes.set(spec.path, spec.handler); const d = () => routes.delete(spec.path); disposers.push(d); return d },
  },
}
const dispose = registerRefinerRoutes(ctx)
assert.ok(routes.has('/dsh-context-refiner/state'), '应注册 state')
assert.ok(routes.has('/dsh-context-refiner/reset'), '应注册 reset')

function call(method, routePath, { headers = {}, body = null, origin = null } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = routePath
  req.headers = Object.assign({ host: '127.0.0.1:10942' }, origin ? { origin } : {}, headers)
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) { this.headers[k] = v },
    end(text) { this.body = text; resolve({ status: this.statusCode, headers: this.headers, json: JSON.parse(text) }) },
  }
  let resolve
  const done = new Promise((r) => { resolve = r })
  const handler = routes.get(routePath.split('?')[0])
  handler(req, res)
  if (method === 'POST') {
    setTimeout(() => {
      if (body !== null) req.emit('data', Buffer.from(body))
      req.emit('end')
    }, 0)
  }
  return done
}

// 1) 缺少自定义头 → 403
let r = await call('GET', '/dsh-context-refiner/state?sessionId=' + sessionId)
assert.equal(r.status, 403)

// 2) 带自定义头 → 200，拿到令牌与日志信息
r = await call('GET', '/dsh-context-refiner/state?sessionId=' + sessionId, { headers: { 'x-dsh-context-refiner': '1' } })
assert.equal(r.status, 200)
assert.equal(r.json.ok, true)
assert.match(r.json.token, /^[0-9a-f]{32}$/)
assert.equal(r.json.log.found, true, '应找到会话日志')
assert.equal(r.json.log.bytes, fs.statSync(path.join(targetDir, 'session.v4.jsonl.zstd')).size)
const token = r.json.token

// 3) 跨源 → 403
r = await call('GET', '/dsh-context-refiner/state?sessionId=' + sessionId, { headers: { 'x-dsh-context-refiner': '1' }, origin: 'https://evil.example' })
assert.equal(r.status, 403)

// 4) POST 缺令牌 → 403
r = await call('POST', '/dsh-context-refiner/reset', {
  headers: { 'x-dsh-context-refiner': '1', 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId, confirm: 'reset', dryRun: true }),
})
assert.equal(r.status, 403)

// 5) Content-Type 不对 → 415
r = await call('POST', '/dsh-context-refiner/reset', {
  headers: { 'x-dsh-context-refiner': '1', 'x-dsh-context-refiner-token': token, 'content-type': 'text/plain' },
  body: 'x',
})
assert.equal(r.status, 415)

// 6) 没有 confirm → 400，且文件没被动
const logFile = path.join(targetDir, 'session.v4.jsonl.zstd')
const before = fs.statSync(logFile).size
r = await call('POST', '/dsh-context-refiner/reset', {
  headers: { 'x-dsh-context-refiner': '1', 'x-dsh-context-refiner-token': token, 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId }),
})
assert.equal(r.status, 400)
assert.equal(fs.statSync(logFile).size, before)

// 7) 干跑 → ok 但不写盘
r = await call('POST', '/dsh-context-refiner/reset', {
  headers: { 'x-dsh-context-refiner': '1', 'x-dsh-context-refiner-token': token, 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId, confirm: 'reset', dryRun: true }),
})
assert.equal(r.status, 200)
assert.equal(r.json.ok, true)
assert.equal(r.json.dryRun, true)
assert.equal(fs.statSync(logFile).size, before, '干跑不应改文件')

// 8) 真跑 → 备份存在、日志变小、projcache 挪走
r = await call('POST', '/dsh-context-refiner/reset', {
  headers: { 'x-dsh-context-refiner': '1', 'x-dsh-context-refiner-token': token, 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId, confirm: 'reset' }),
})
assert.equal(r.status, 200)
assert.equal(r.json.ok, true)
assert.ok(fs.existsSync(r.json.backup), '应留下备份')
assert.ok(fs.statSync(logFile).size < before / 10, '日志应大幅变小')
assert.ok(r.json.log && r.json.bytesAfter > 0)
assert.ok(r.json.projcache && r.json.projcache !== 'absent', '投影缓存应被挪走')
assert.ok(!fs.existsSync(path.join(projDir, sessionId + '.json')), 'projcache 应已移走')

// 9) 坏 ID → 400（校验类错误不该报 500）且给出原因，不要把别的会话写坏
r = await call('POST', '/dsh-context-refiner/reset', {
  headers: { 'x-dsh-context-refiner': '1', 'x-dsh-context-refiner-token': token, 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: '../etc', confirm: 'reset' }),
})
assert.equal(r.status, 400)
assert.match(r.json.error, /会话 ID/)

// 10) dispose 注销路由
dispose()
assert.equal(routes.size, 0, 'dispose 应注销两条路由')

fs.rmSync(home, { recursive: true, force: true })
console.log('ok: 路由鉴权/干跑/真跑/备份/坏 ID/dispose 通过')
