// dsh-context-refiner · 宿主侧重置管线自检
// 用法：node scripts/test-host.mjs   （或 REFINER_SESSION_DIR=<会话目录> node scripts/test-host.mjs）
// 断言：帧切分、header 独立、seq 连续、surfaceOp、备份落盘、简报内容、二次重置、明文日志、缺权限事件不瞎猜。
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeLog, encodeLog } from '../host/log.js'
import { resetSession } from '../host/reset.js'
import { createHash } from 'node:crypto'
import { buildBrief, textOf } from '../host/brief.js'

const HOME = process.env.DSH_HOME || 'E:/DSH/home'

/** 找一个真会话日志当素材：优先环境变量，其次扫 sessions 目录挑 20KB–3MB 的 v4 非 seed 会话。 */
function findFixture() {
  if (process.env.REFINER_SESSION_DIR) {
    return { dir: process.env.REFINER_SESSION_DIR, id: process.env.REFINER_SESSION_DIR.split(/[\\/]/).pop() }
  }
  const root = join(HOME, 'sessions')
  const picked = []
  for (const ws of readdirSync(root)) {
    for (const name of readdirSync(join(root, ws))) {
      const dir = join(root, ws, name)
      for (const file of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        const path = join(dir, file)
        try {
          const size = statSync(path).size
          if (size < 20000 || size > 3 * 1024 * 1024) continue
          const decoded = decodeLog(readFileSync(path))
          if (decoded.header?.version === 4 && !decoded.header.isSeeded) picked.push({ dir, id: name, size })
        } catch { /* 跳过坏日志 */ }
      }
    }
  }
  assert.ok(picked.length, '在 ' + root + ' 下找不到 20KB–3MB 的 v4 会话日志当素材；可用 REFINER_SESSION_DIR 指定')
  picked.sort((a, b) => a.size - b.size)
  return picked[0]
}

const fixture = findFixture()
const SID = fixture.id
const root = mkdtempSync(join(tmpdir(), 'refiner-host-'))
// 断言中途失败时也要删掉临时目录：里面是真实会话的副本。
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ } })
const home = join(root, 'home')
const target = join(home, 'sessions', 'ws', SID)
mkdirSync(target, { recursive: true })
for (const name of readdirSync(fixture.dir)) cpSync(join(fixture.dir, name), join(target, name), { recursive: true })

const logPath = join(target, 'session.v4.jsonl.zstd')
const before = statSync(logPath).size
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')
const originalHash = sha(logPath)
const original = decodeLog(readFileSync(logPath))
assert.ok(original.header.version === 4, '源日志必须是 v4')
assert.ok(original.events.length > 0, '源日志必须有事件')

const dry = await resetSession({ sessionId: SID, home, dryRun: true, purgeBili: false })
assert.equal(dry.ok, true)
assert.equal(dry.bytesBefore, before)
assert.ok(dry.bytesAfter < before, '干跑就应该算出更小的体积')
assert.ok(dry.brief.startsWith('# 交接简报'), '简报要有标题')
assert.ok(dry.brief.includes('## 1. 这个对话在做什么'))
assert.ok(existsSync(logPath), '干跑不能动原文件')
assert.equal(statSync(logPath).size, before, '干跑后原文件体积不变')

const real = await resetSession({ sessionId: SID, home, purgeBili: false, now: 1794753000000 })
assert.equal(real.ok, true)
assert.equal(real.watchdog, 'clean', '写完后 1.2 秒观察窗内不许有人再写这个文件')
assert.ok(existsSync(real.backup), '必须留下备份')
assert.equal(statSync(real.backup).size, before, '备份是原文件')
assert.equal(sha(real.backup), originalHash, '备份必须逐字节等于重置前的日志')
assert.ok(statSync(logPath).size < before, '重置后更小')

const after = decodeLog(readFileSync(logPath))
assert.equal(after.header.id, original.header.id, 'header 保留会话 id')
const seqs = after.events.map((e) => e.seq)
assert.deepEqual(seqs, seqs.map((_, i) => i), 'seq 必须从 0 连续')
assert.equal(after.events.at(-1).type, 'turn/end')
const msgEvent = after.events.find((e) => e.type === 'user/message')
assert.ok(msgEvent, '必须有一条用户消息')
assert.equal(msgEvent.surfaceOp, 'append', 'user/message 必须带 surfaceOp: append，否则宿主加载会抛错')
assert.equal(msgEvent.data.role, 'user')
assert.ok(textOf(msgEvent.data.content).startsWith('# 交接简报'), '简报就是这一回合的用户消息')
assert.deepEqual(msgEvent.data.source, { kind: 'user' }, 'source 只能写真实日志里出现过的形状（只有 kind）')
assert.ok(msgEvent.data.id, '消息要有 id')
assert.equal(after.events.at(-1).data.reason.kind, 'completed')

// 二次重置：不能把日志搞坏
const again = await resetSession({ sessionId: SID, home, purgeBili: false, now: 1794753100000 })
assert.equal(again.ok, true)
const third = decodeLog(readFileSync(logPath))
assert.deepEqual(third.events.map((e) => e.seq), third.events.map((_, i) => i), '二次重置后 seq 仍然连续')

// 缺权限事件：不能自己编 danger-full-access，宁可不写
const bare = join(home, 'sessions', 'ws2', 'session-00000000-0000-0000-0000-0000000000aa')
mkdirSync(bare, { recursive: true })
const bareHeader = JSON.stringify({ type: 'session', version: 4, id: 'session-00000000-0000-0000-0000-0000000000aa', createdAt: 1, cwd: 'C:/tmp', isSeeded: false, delegationDepth: 0 })
const bareEvents = [
  { type: 'system/message', seq: 0, time: 1, surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: '你是测试助手。' }], source: { kind: 'system-prompt' }, id: 's1' } } },
  { type: 'user/message', seq: 1, time: 2, surfaceOp: 'append', data: { content: [{ type: 'text', text: '帮我把这个脚本改成异步的' }], source: { kind: 'user' }, role: 'user', id: 'm1' } },
  { type: 'turn/start', seq: 2, time: 3, data: { turn: 1 } },
]
writeFileSync(join(bare, 'session.v4.jsonl'), encodeLog(bareHeader, bareEvents, true))
const bareReport = await resetSession({ sessionId: 'session-00000000-0000-0000-0000-0000000000aa', home, purgeBili: false })
assert.deepEqual(bareReport.policiesKept, [], '没有权限事件时不能瞎猜权限')
const bareAfter = decodeLog(readFileSync(join(bare, 'session.v4.jsonl')))
assert.deepEqual(bareAfter.events.map((e) => e.type), ['turn/start', 'step/start', 'system/message', 'user/message', 'turn/end'], '明文日志也要能重置，且顺序是 turn/start → step/start → system 头 → 用户简报')
assert.ok(bareAfter.events.find((e) => e.type === 'user/message').surfaceOp === 'append')
assert.equal(bareAfter.events.find((e) => e.surfaceOp).type, 'system/message', '第一个 surface 事件必须是 system 头（宿主硬规则）')

// 没有系统提示的日志必须拒绝：硬写下去，宿主下次追加 system/message 会判整份日志损坏
const nohead = join(home, 'sessions', 'ws6', 'session-00000000-0000-0000-0000-0000000000ee')
mkdirSync(nohead, { recursive: true })
const noheadHeader = JSON.stringify({ type: 'session', version: 4, id: 'session-00000000-0000-0000-0000-0000000000ee', createdAt: 1, cwd: 'C:/tmp', isSeeded: false, delegationDepth: 0 })
writeFileSync(join(nohead, 'session.v4.jsonl'), encodeLog(noheadHeader, [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: 2, surfaceOp: 'append', data: { content: [{ type: 'text', text: '只有一条用户消息' }], source: { kind: 'user' }, role: 'user', id: 'm1' } },
], true))
await assert.rejects(resetSession({ sessionId: 'session-00000000-0000-0000-0000-0000000000ee', home, purgeBili: false }), /系统提示/, '没有系统头的日志要拒绝重置')

// seed / fork 会话必须拒绝
const seeded = join(home, 'sessions', 'ws3', 'session-00000000-0000-0000-0000-0000000000bb')
mkdirSync(seeded, { recursive: true })
writeFileSync(join(seeded, 'session.v4.jsonl'), encodeLog(JSON.stringify({ type: 'session', version: 4, id: 'session-00000000-0000-0000-0000-0000000000bb', isSeeded: true, inheritedEventCount: 3 }), [], true))
await assert.rejects(resetSession({ sessionId: 'session-00000000-0000-0000-0000-0000000000bb', home, purgeBili: false }), /分叉|种子/, 'seed 会话要拒绝')

// 简报生成器：空内容、坏内容都不能抛
assert.ok(buildBrief([]).startsWith('# 交接简报'))
const userMsg = (text, kind = 'user') => ({ type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind } } })
assert.ok(buildBrief([userMsg('记住：一律用中文回答。')]).includes('一律用中文'), '真实用户输入应进简报')
assert.ok(!buildBrief([userMsg('system-reminder 噪音', 'runtime-context')]).includes('噪音'), '注入的上下文不应进简报')
assert.equal(textOf(undefined), '')
assert.equal(textOf('hi'), 'hi')

// 有 seq 洞的日志（宿主用旧游标写坏过）必须拒绝，不能二次伤害
const broken = join(home, 'sessions', 'ws4', 'session-00000000-0000-0000-0000-0000000000cc')
mkdirSync(broken, { recursive: true })
const brokenHeader = JSON.stringify({ type: 'session', version: 4, id: 'session-00000000-0000-0000-0000-0000000000cc', createdAt: 1, cwd: 'C:/tmp', isSeeded: false, delegationDepth: 0 })
const brokenEvents = [
  { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } },
  { type: 'user/message', seq: 45, time: 3, surfaceOp: 'append', data: { content: [{ type: 'text', text: '旧游标写坏的一条' }], source: { kind: 'user' }, role: 'user', id: 'm1' } },
]
writeFileSync(join(broken, 'session.v4.jsonl'), encodeLog(brokenHeader, brokenEvents, true))
await assert.rejects(resetSession({ sessionId: 'session-00000000-0000-0000-0000-0000000000cc', home, purgeBili: false }), /已经坏了|not dense/, '有 seq 洞要拒绝')

// 主日志丢了但备份还在：报错要指出备份，而不是说「可能被删了」
const lostId = 'session-00000000-0000-0000-0000-0000000000dd'
const lostDir = join(home, 'sessions', 'ws5', lostId)
mkdirSync(lostDir, { recursive: true })
const lostHeader = JSON.stringify({ type: 'session', version: 4, id: lostId, createdAt: 1, cwd: 'C:/tmp', isSeeded: false, delegationDepth: 0 })
const lostEvents = [
  { type: 'system/message', seq: 0, time: 1, surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: '你是测试助手。' }], source: { kind: 'system-prompt' }, id: 's1' } } },
  { type: 'user/message', seq: 1, time: 2, surfaceOp: 'append', data: { content: [{ type: 'text', text: '先有一条真实消息' }], source: { kind: 'user' }, role: 'user', id: 'm1' } },
  { type: 'turn/start', seq: 2, time: 3, data: { turn: 1 } },
  { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
]
writeFileSync(join(lostDir, 'session.v4.jsonl'), encodeLog(lostHeader, lostEvents, true))
await resetSession({ sessionId: lostId, home, purgeBili: false })
rmSync(join(lostDir, 'session.v4.jsonl'))
await assert.rejects(resetSession({ sessionId: lostId, home, purgeBili: false }), /备份/, '主日志丢了要指向备份')

// 同一会话并发必须被挡住（409 的源头）
const firstRun = resetSession({ sessionId: SID, home, purgeBili: false, now: 1794753200000 })
let busyErr = null
try { await resetSession({ sessionId: SID, home, purgeBili: false, now: 1794753200001 }) } catch (e) { busyErr = e }
await firstRun
assert.equal(busyErr && busyErr.code, 'RESET_BUSY', '同一会话并发重置要报 RESET_BUSY')

// 坏 id 要拒绝
assert.throws(() => resetSession({ sessionId: '../../etc', home, dryRun: true }), /会话 ID/)
await assert.rejects(resetSession({ sessionId: 'session-00000000-0000-0000-0000-000000000000', home, dryRun: true }), /日志不在/)

rmSync(root, { recursive: true, force: true })
console.log('ok: 帧切分/备份/重写/seq 连续/surfaceOp/明文/缺权限不瞎猜/seed 拒绝/简报 全通过（原 ' + before + ' 字节 → ' + real.bytesAfter + ' 字节，素材 ' + SID + '）')
