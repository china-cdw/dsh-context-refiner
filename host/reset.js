// dsh-context-refiner · 极致提炼 = 离线重置
//
// 做的事（不调用模型，不花 API 钱）：
//   1. 读会话日志，抽出交接简报；
//   2. 先在旁边写一份校验过的新日志（临时文件），再跟原文件交换；
//   3. 把日志重写成「header 帧 + 一个回合」，seq 从 0 连续；
//   4. 挪走会话的投影缓存（<home>/storages/session_projcache/sessions/<id>.json）；
//   5. 把 billion-context 里提到这个会话的账本文件挪走（不删，加 .bak-refiner 后缀）。
//
// 三个不能忘的硬约束（都是踩过的）：
//   · 第一帧必须恰好只有一行 header；
//   · seq 必须从 0 连续；
//   · user/message 是 surface-eligible 事件，必须带 surfaceOp:"append"，
//     否则宿主加载时抛 "requires a surfaceOp marker"，会话直接打不开。
// 副作用：宿主内存里仍是旧内容与旧 seq 游标，重置后必须在另一个窗口重开，
// 这个窗口里再发消息会按旧游标追加，造出 seq gap。
import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBrief } from './brief.js'
import { decodeLog, encodeLog, eventGap, fileContains, fileSize, findBackupLogs, findSessionLogs, newId, readLogBuffer } from './log.js'

// 主会话是 session-<uuid>，子代理（origin:"subagent"）的目录是裸 uuid，两种都认。
const SESSION_ID = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// 宿主的 header 白名单（app.asar 里 HEADER_KEYS）：多一个键就整份日志加载失败。
const HEADER_KEYS = new Set(['type', 'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth', 'cwd', 'parentSession', 'origin', 'agentPreset'])
const POLICY_TYPES = ['permission/preset', 'sandbox/mode', 'approval/policy']
// 找不到权限事件时不要自己编：宁可少写这几条，让宿主用它自己的默认值。
const inFlight = new Set()

/** 找 DSH home：环境变量 → 插件自身位置推 → ~/.dsh。 */
export function resolveHome(hint) {
  const candidates = []
  if (hint) candidates.push(hint)
  if (process.env.DSH_HOME) candidates.push(process.env.DSH_HOME)
  try {
    const here = fileURLToPath(import.meta.url)
    candidates.push(dirname(dirname(dirname(dirname(here)))))
    candidates.push(dirname(dirname(dirname(dirname(dirname(here))))))
  } catch { /* ignore */ }
  candidates.push(join(homedir(), '.dsh'))
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, 'sessions'))) return dir
  }
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** bili 账本目录（明文 JSON，一个命名空间一个文件）。 */
export function biliLedgerDir() {
  return join(homedir(), '.local', 'share', 'billion-context', 'sessions', 'anthropic')
}

// 校验类错误（400），跟「磁盘写坏了」（500）要分开，否则用户分不清自己填错还是真出故障。
const invalid = (message) => Object.assign(new Error(message), { code: 'RESET_INVALID' })

export function assertSessionId(sessionId) {
  const id = String(sessionId || '')
  if (!SESSION_ID.test(id)) throw invalid('会话 ID 长得不对：' + id)
  return id
}

/** 写完把内容真正刷到盘上再改名（宿主自己也是 fsync 之后才 materialize）。 */
function syncFile(file) {
  const fd = openSync(file, 'r+')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/** 宿主能不能打开这份日志，先按它的规则自查一遍（比写完才发现打不开便宜）。 */
function checkHeader(header, sessionId, file) {
  if (!header || header.type !== 'session') throw invalid('日志第一行不是会话 header：' + file)
  if (header.id !== sessionId) {
    throw invalid('记录里的会话 ID（' + String(header.id) + '）和要重置的不是同一个：' + file + '。可能同名的目录不止一个，先手动确认。')
  }
  for (const key of Object.keys(header)) {
    if (!HEADER_KEYS.has(key)) throw invalid('日志 header 里有宿主不认识的字段 ' + key + '，重写后会话会打不开：' + file)
  }
  if (header.origin !== undefined && header.origin !== 'subagent') throw invalid('日志 header 的 origin 不是宿主允许的值：' + String(header.origin))
  if (typeof header.createdAt !== 'number' || header.createdAt < 0) throw invalid('日志 header 的 createdAt 不对：' + file)
}

/** 每类权限事件只认这一个字段：别的键（source 之类）搬过来宿主可能不认。 */
const POLICY_FIELDS = { 'permission/preset': 'preset', 'sandbox/mode': 'mode', 'approval/policy': 'policy' }

/** 沿用旧事件流里最后出现的权限/沙箱/审批设置；一条都没有就不写（不猜）。 */
function policiesFrom(events) {
  const picked = {}
  for (const ev of events) {
    const field = ev && POLICY_FIELDS[ev.type]
    if (field && ev.data && ev.data[field] !== undefined) picked[ev.type] = { [field]: ev.data[field] }
  }
  return POLICY_TYPES.filter((type) => picked[type]).map((type) => ({ type, data: picked[type] }))
}

function stampOf(now) {
  return new Date(now).toISOString().replace(/[:.]/g, '-')
}

function moveAside(file, stamp) {
  const target = file + '.bak-refiner-' + stamp
  try {
    renameSync(file, target)
    return target
  } catch {
    return null
  }
}

/** 重写完立刻自己解一遍：seq 连续、第一帧单行、surface 事件带标记。 */
function verifyEncoded(buffer, expectEvents) {
  const again = decodeLog(buffer)
  if (again.events.length !== expectEvents) throw new Error('新日志自检失败：事件数不对（' + again.events.length + ' ≠ ' + expectEvents + '）')
  again.events.forEach((ev, i) => {
    if (ev.seq !== i) throw new Error('新日志自检失败：seq 不连续（第 ' + i + ' 条是 ' + ev.seq + '）')
    if ((ev.type === 'user/message' || ev.type === 'assistant/message') && ev.surfaceOp !== 'append') {
      throw new Error('新日志自检失败：' + ev.type + ' 缺 surfaceOp')
    }
  })
  // 宿主的硬规则：日志里出现 system/message 时，第一个 surface 事件必须是 system/message
  // （「受保护的第一个 surface 头」）。少了它，宿主下次追加系统提示就会报 stored log is corrupt。
  const firstSurface = again.events.find((ev) => ev.surfaceOp !== undefined)
  if (!firstSurface || firstSurface.type !== 'system/message') {
    throw new Error('新日志自检失败：第一个 surface 事件必须是 system/message（现在 ' + (firstSurface ? firstSurface.type : '没有') + '）')
  }
  return again
}

/**
 * 重置一个会话。
 * @param {{sessionId:string, home?:string, dryRun?:boolean, now?:number, purgeBili?:boolean, brief?:string}} options
 */
export function resetSession(options = {}) {
  const sessionId = assertSessionId(options.sessionId)
  if (inFlight.has(sessionId)) {
    const busy = new Error('这个会话正在重置，等它结束再点。')
    busy.code = 'RESET_BUSY'
    throw busy
  }
  inFlight.add(sessionId)
  return (async () => {
    try {
      return await runReset({ ...options, sessionId })
    } finally {
      inFlight.delete(sessionId)
    }
  })()
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function runReset(options) {
  const sessionId = options.sessionId
  const home = options.home || resolveHome()
  const now = options.now || Date.now()
  const stamp = stampOf(now)
  const candidates = findSessionLogs(home, sessionId)
  if (!candidates.length) {
    const backups = findBackupLogs(home, sessionId)
    if (backups.length) {
      throw invalid('主日志不在了，但找到重置时留下的备份：' + backups.map((b) => b.file).join('；') +
        '。把文件名里的 .bak-refiner-<时间戳> 去掉、改回 ' + backups[0].original + '，这个会话就能恢复。')
    }
    throw invalid('这个会话的日志不在 ' + join(home, 'sessions') + ' 下面，可能已经被删了')
  }
  let found = null
  let decoded = null
  for (const candidate of candidates) {
    let parsed = null
    try { parsed = decodeLog(readLogBuffer(candidate.file)) } catch { continue }
    if (parsed.header?.id === sessionId) { found = candidate; decoded = parsed; break }
  }
  if (!found) {
    const ids = candidates.map((c) => c.file).join('；')
    throw invalid('找到了同名目录，但里面的 header.id 都对不上，不敢动：' + ids)
  }

  const before = fileSize(found.file)
  if (decoded.header?.version !== 4) throw invalid('不是 v4 会话日志（版本 ' + decoded.header?.version + '），这个版本不支持重置')
  if (decoded.header?.isSeeded || decoded.header?.inheritedEventCount != null) {
    throw invalid('这是从别的会话分叉/种子出来的会话，重置会缺继承标记，宿主可能打不开。请新开一个会话再试。')
  }
  checkHeader(decoded.header, sessionId, found.file)
  // 宿主用旧游标追加过一次就会留下 seq 洞：这种日志宿主已经打不开，不能当成素材再写一次。
  const gap = eventGap(decoded.events)
  if (gap >= 0) {
    throw invalid('这份日志已经坏了：第 ' + gap + ' 条的 seq 是 ' + decoded.events[gap]?.seq +
      '（宿主会报 not dense）。先别重置，把旁边的 .bak-refiner-* 备份改回原名恢复，再试。')
  }
  // 宿主按「配置的压缩方式」解码，而写回按内容嗅探；两边不一致时宁可拒绝，也不要报成功却打不开。
  if (!!found.compressed !== !decoded.plain) {
    throw invalid('这份日志的后缀和内容对不上（' + found.file + '），直接重写会让宿主打不开。先手动确认格式再试。')
  }
  const messages = decoded.events.filter((ev) => ev.type === 'user/message')
  // 只统计真正的用户输入：插件注入的 runtime-context 不算，否则简报会是空的。
  const userTexts = messages
    .filter((ev) => ev.data && ev.data.source && ev.data.source.kind === 'user')
    .map((ev) => (Array.isArray(ev.data.content) ? ev.data.content.map((b) => (b && b.type === 'text' ? b.text : '')).join('') : ''))
  // 上一次极致留下的简报不是「用户说的话」，连续重置时不能再拿它当素材（否则是简报的简报）。
  const priorBrief = userTexts.find((text) => String(text || '').startsWith('# 交接简报（极致提炼')) || ''
  const realMessages = userTexts.filter((text) => !String(text || '').startsWith('# 交接简报（极致提炼'))
  if (!realMessages.length && !priorBrief) throw invalid('这份日志里没有真正的用户消息（只有系统注入），重置没有意义')

  // 已经只剩一份简报时，再点一次就是原样保留它，不能拿它再造一遍简报。
  const brief = String(options.brief || '').trim() || (realMessages.length ? buildBrief(decoded.events, { now, source: sessionId }) : priorBrief)
  const events = []
  const push = (type, data, offset, extra) => events.push({ type, seq: events.length, time: now + offset, ...(extra || {}), data })
  const policies = policiesFrom(decoded.events)
  policies.forEach((p, i) => push(p.type, p.data, i))
  push('turn/start', { turn: 1 }, 10)
  // 第一步必须有系统提示那条消息：宿主把它当作「受保护的第一个 surface 头」。
  // 少了它，日志本身能打开，但宿主下次追加 system/message 时整份日志会被判坏（实测踩过）。
  const sysEvents = decoded.events.filter((ev) => ev.type === 'system/message' && ev.data && ev.data.message)
  const head = sysEvents[sysEvents.length - 1]
  if (!head) {
    throw invalid('这份日志里没有系统提示那条消息，重置后宿主一追加系统提示就会判日志损坏。' +
      '这种会话（还没跑过一整步）请直接新开一个，别重置。')
  }
  push('step/start', { turn: 1, step: 1 }, 15)
  push('system/message', { turn: 1, step: 1, message: JSON.parse(JSON.stringify(head.data.message)) }, 18, { surfaceOp: 'append' })
  // surfaceOp 不能少：宿主 surface 层会校验，缺了会话打不开。
  push('user/message', {
    content: [{ type: 'text', text: brief }],
    // 只写真实日志里出现过的形状（扫描 25 份真实记录，source 一律只有 kind）：
    // 多加 rpcId/clientTimeZone 之类未验证的键，万一 schema 从严就永久打不开。
    source: { kind: 'user' },
    role: 'user',
    id: newId(),
  }, 20, { surfaceOp: 'append' })
  push('turn/end', { turn: 1, reason: { kind: 'completed' } }, 30)

  // 写回格式按内容判断，不按扩展名：万一 .zstd 里其实是明文，按扩展名写会写坏。
  const encoded = encodeLog(decoded.headerLine, events, !!decoded.plain)
  verifyEncoded(encoded, events.length)

  const report = {
    ok: true,
    sessionId,
    home,
    log: found.file,
    dryRun: !!options.dryRun,
    bytesBefore: before,
    bytesAfter: encoded.length,
    framesBefore: decoded.frames,
    eventsBefore: decoded.events.length,
    messagesBefore: realMessages.length,
    briefChars: brief.length,
    brief,
    policiesKept: policies.map((p) => p.type),
    backup: null,
    projcache: 'absent',
    ledgers: [],
    notes: [],
    warnings: [],
    partial: false,
    watchdog: 'skipped',
    restartRequired: true,
  }
  // 旧日志里连权限事件都没有：不猜值（不静默提权），但要告诉用户重置后可能回默认权限。
  if (!policies.length) {
    report.warnings.push('旧日志里没有权限/沙箱/审批事件，重置后会话会按宿主默认权限打开（可能要重新确认一次）')
  }
  report.partial = report.warnings.length > 0
  if (options.dryRun) return report

  // 新日志先写临时文件、自检、fsync；原文件先复制备份，再用一次 rename 原子替换。
  // 不用「先把原文件改名再改名新文件」：那中间有个窗口，进程一死会话就从列表里消失。
  const temp = found.file + '.refiner-new-' + stamp
  try {
    writeFileSync(temp, encoded)
    syncFile(temp)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* ignore */ }
    throw new Error('写临时日志失败，原文件没动：' + String(error?.message ?? error))
  }
  const backup = found.file + '.bak-refiner-' + stamp
  try {
    copyFileSync(found.file, backup)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* ignore */ }
    throw new Error('备份失败，不敢往下写：' + String(error?.message ?? error))
  }
  try {
    if (fileSize(backup) !== before) throw new Error('备份文件大小和原文件对不上')
    // 从读日志到现在可能过去了一会儿：宿主又写了的话，不能拿旧内容覆盖新内容。
    const current = fileSize(found.file)
    if (current !== before) throw new Error('读日志之后它又被写了（' + before + ' → ' + current + ' 字节），这次先不动，稍后再试')
    renameSync(temp, found.file)
    report.backup = backup
  } catch (error) {
    try { unlinkSync(temp) } catch { /* ignore */ }
    throw new Error('新日志就位失败，原文件没动：' + String(error?.message ?? error))
  }

  // 宿主进程里还握着这一轮的旧内存（旧内容 + 旧 seq 游标）。重置完到重开窗口之间，
  // 它可能又按旧游标往这个文件追加（标题、inbox、甚至一条消息），那会造出 seq gap、会话打不开。
  // 这里等一会儿再看一眼：真被写了就立刻把原记录还原，报明确失败，而不是留一个坏文件。
  await sleep(1200)
  let nowBytes = -1
  try { nowBytes = statSync(found.file).size } catch { nowBytes = -1 }
  if (nowBytes !== encoded.length) {
    const drift = found.file + '.drift-refiner-' + stamp
    try { renameSync(found.file, drift) } catch { /* 挪不动也要尝试还原 */ }
    let restored = false
    try { copyFileSync(backup, found.file); restored = true } catch { /* ignore */ }
    throw new Error('新日志刚写完就被宿主又写了一遍（' + nowBytes + ' ≠ ' + encoded.length + ' 字节），说明这一轮还没真的结束。' +
      (restored ? '已经把原始记录还原回去，这次不算重置成功——等这一轮彻底结束、或关掉这个会话窗口再试。' : '原文件没能自动还原，原始记录在：' + backup))
  }
  report.watchdog = 'clean'

  // 后置清理是 best-effort：失败只记 warning，不能把「已经重置成功」报成失败。
  const soft = (label, fn) => {
    try { return fn() } catch (error) {
      report.warnings.push(label + '：' + String(error?.message ?? error))
      return null
    }
  }
  const proj = join(home, 'storages', 'session_projcache', 'sessions', sessionId + '.json')
  if (existsSync(proj)) {
    const moved = soft('投影缓存', () => moveAside(proj, stamp))
    report.projcache = moved ? 'moved' : 'failed'
  }
  if (options.purgeBili !== false) {
    const dir = biliLedgerDir()
    if (existsSync(dir)) {
      soft('bili 账本', () => {
        for (const name of readdirSync(dir)) {
          if (!name.endsWith('.json')) continue
          const file = join(dir, name)
          try {
            if (statSync(file).size > 512 * 1024 * 1024) continue
          } catch { continue }
          if (!fileContains(file, sessionId)) continue
          // 一个账本文件可能同时装着别的会话：整文件挪走会连累它，跳过并说明。
          const ids = new Set()
          try {
            const text = readLogBuffer(file).toString('latin1')
            for (const m of text.matchAll(/session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) ids.add(m[0])
          } catch { /* 读不了就按内容命中处理 */ }
          if (ids.size > 1) {
            report.warnings.push('bili 账本文件里还有别的会话，没动：' + name)
            continue
          }
          const moved = moveAside(file, stamp)
          report.ledgers.push({ name, moved: !!moved, backup: moved })
          if (!moved) report.warnings.push('bili 账本挪不动（可能被占用）：' + name)
        }
      })
    }
  }
  if (options.purgeBili !== false && existsSync(biliLedgerDir())) {
    // 账本文件挪走了，但 index.db（几百 MB 的 sqlite）和 ~/.local/state/billion-context 没动：
    // 里面可能还有旧片段，乱删会连累别的会话。这属于「提示」，不是「失败」，不能把 partial 永久标成 true。
    report.notes.push('bili 的索引库（index.db）与状态目录没动，里面可能还留着旧片段；这部分只能靠重开会话窗口后观察')
  }
  report.partial = report.warnings.length > 0
  return report
}
