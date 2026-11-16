// dsh-context-refiner · 会话日志读写
//
// DSH v4 会话日志是「多个 zstd 帧首尾拼接」的，不是单个 zstd 流：
// 读的时候必须按 magic(28 b5 2f fd) 切帧再逐帧解压；写的时候也一样拼。
//
// 校验规则（宿主 dsh-session-persistence-jsonl）：
//   1. 第一帧必须恰好只有 header 一行 —— 否则报 "first frame is not exactly one header line"；
//   2. 后续帧里每行一个事件 JSON；
//   3. seq 必须从 0 连续递增 —— 否则报 "has seq gap (expected N, got M)"。
// 这三条都踩过，改动这里的编码逻辑前先读一遍。
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 把整份日志按 magic 切成帧。 */
export function splitFrames(buf) {
  const frames = []
  let pos = 0
  while (pos < buf.length) {
    const next = buf.indexOf(MAGIC, pos + 4)
    const end = next < 0 ? buf.length : next
    frames.push(buf.subarray(pos, end))
    pos = end
  }
  return frames
}

/**
 * 解码一份会话日志。
 * @returns {{header:object, headerLine:string, events:object[], frames:number}}
 */
export function decodeLog(buf) {
  // 明文 JSONL（未压缩存储）与 zstd 帧格式都要支持：老会话可能没压缩。
  if (!buf.subarray(0, 4).equals(MAGIC)) return decodePlain(buf)
  const frames = splitFrames(buf)
  if (!frames.length) throw new Error('日志是空的，里面没有 zstd 帧')
  const headerText = zstdDecompressSync(frames[0]).toString('utf8')
  if (headerText.indexOf('\n') !== headerText.length - 1) {
    throw new Error('第一帧不是「只有一行 header」，这份日志已经不合法了')
  }
  const headerLine = headerText.slice(0, -1)
  const header = JSON.parse(headerLine)
  const events = []
  for (let i = 1; i < frames.length; i += 1) {
    const text = zstdDecompressSync(frames[i]).toString('utf8')
    for (const line of text.split('\n')) {
      if (!line) continue
      events.push(JSON.parse(line))
    }
  }
  return { header, headerLine, events, frames: frames.length, plain: false }
}

/** 明文格式：第一行 header，后面每行一个事件。 */
function decodePlain(buf) {
  const lines = buf.toString('utf8').split('\n').filter((line) => line.trim() !== '')
  if (!lines.length) throw new Error('日志是空的')
  const headerLine = lines[0]
  const header = JSON.parse(headerLine)
  const events = lines.slice(1).map((line) => JSON.parse(line))
  return { header, headerLine, events, frames: 1, plain: true }
}

/** 编码：第一帧独立 header，第二帧一次放全部事件。plain=true 写明文 JSONL。 */
export function encodeLog(headerLine, events, plain) {
  const bodyText = events.length ? events.map((e) => JSON.stringify(e)).join('\n') + '\n' : ''
  if (plain) return Buffer.from(headerLine + '\n' + bodyText, 'utf8')
  const head = zstdCompressSync(Buffer.from(headerLine + '\n', 'utf8'))
  const body = bodyText ? zstdCompressSync(Buffer.from(bodyText, 'utf8')) : Buffer.alloc(0)
  return Buffer.concat(body.length ? [head, body] : [head])
}

/** 写临时文件再 rename，避免读到半截。 */
export function atomicWrite(path, buffer) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp-' + process.pid + '-' + Date.now()
  writeFileSync(tmp, buffer)
  renameSync(tmp, path)
}

/** 会话日志路径（<home>/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd）。 */
export function findSessionLogs(home, sessionId) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return []
  const out = []
  for (const workspace of readdirSafe(root)) {
    const candidate = join(root, workspace, sessionId)
    for (const name of ['session.v4.jsonl.zstd', 'session.jsonl.zstd', 'session.v4.jsonl']) {
      const file = join(candidate, name)
      if (existsSync(file)) {
        out.push({ file, dir: candidate, workspace, compressed: name.endsWith('.zstd') })
        break
      }
    }
  }
  return out
}

/** 交换到一半被打断时留下的备份：<dir>/<日志名>.bak-refiner-<时间戳>。 */
export function findBackupLogs(home, sessionId) {
  const out = []
  const root = join(home, 'sessions')
  for (const workspace of readdirSafe(root)) {
    const dir = join(root, workspace, sessionId)
    for (const name of readdirSafe(dir)) {
      const m = /^(session[^/]*\.jsonl(?:\.zstd)?)\.bak-refiner-/.exec(name)
      if (m) out.push({ file: join(dir, name), dir, workspace, name, original: m[1] })
    }
  }
  return out
}

/** 官方恢复器要求 seq 从 0 连续；有洞就是「已被旧游标写坏」，不能再往里写。 */
export function eventGap(events) {
  for (let i = 0; i < events.length; i += 1) {
    if (events[i]?.seq !== i) return i
  }
  return -1
}

/** 兼容旧调用：只取第一个候选（header.id 对不对得上由调用方校验）。 */
export function findSessionLog(home, sessionId) {
  return findSessionLogs(home, sessionId)[0] || null
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

export function fileSize(path) {
  try { return statSync(path).size } catch { return 0 }
}

export function readLogBuffer(path) {
  return readFileSync(path)
}

export function newId() {
  return randomUUID()
}

/** 逐块扫描大文件里是否出现某段 ASCII 文本；命中即返回，不整读。 */
export function fileContains(path, needle, chunk = 1 << 20) {
  const target = Buffer.from(needle, 'utf8')
  const size = fileSize(path)
  if (!size) return false
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(Math.min(chunk, size) + target.length)
    let carry = 0
    let pos = 0
    while (pos < size) {
      const want = Math.min(chunk, size - pos)
      const got = readSync(fd, buf, carry, want, pos)
      if (got <= 0) break
      const slice = buf.subarray(0, carry + got)
      if (slice.indexOf(target) >= 0) return true
      carry = Math.min(target.length - 1, slice.length)
      if (carry > 0) slice.copy(buf, 0, slice.length - carry)
      pos += got
    }
    return false
  } finally {
    closeSync(fd)
  }
}
