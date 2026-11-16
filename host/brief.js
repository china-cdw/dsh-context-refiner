// dsh-context-refiner · 极致提炼用的「交接简报」
//
// 极致提炼 = 离线重置：不花模型调用，直接读会话日志、用规则抽出一份简报，
// 再把日志重写成「header + 一个回合（简报就是这一回合的用户消息）」。
//
// 结构按五段式：Goal / Done / Next / Open questions / Key facts，
// 外加「先读这段」里的 5 条重置信号和一句交接指令。
//
// 这里是纯函数，不碰文件系统，方便单测。
const NL = String.fromCharCode(10)
const MAX_TOTAL = 7000

/** 上一次极致生成的简报开头：连续重置时不能再拿它当「用户要求」。 */
export const BRIEF_MARK = '# 交接简报（极致提炼'

/** 从 content 数组里取 text 块拼起来。 */
export function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(NL).trim()
}

const cut = (text, max) => {
  const s = String(text || '').split(NL).join(' ').replace(/ +/g, ' ').trim()
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…'
}

const BS = String.fromCharCode(92)
const PATH_CHARS = new Set(('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./@+:-' + BS).split(''))

const isExt = (s) => {
  if (!s || s.length > 8) return false
  for (const ch of s) {
    const ok = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')
    if (!ok) return false
  }
  return true
}

const looksLikePath = (token) => {
  if (token.length < 4) return false
  if (!token.includes('/') && !token.includes(BS)) return false
  const parts = token.split('.')
  if (parts.length < 2) return false
  return isExt(parts[parts.length - 1])
}

/** 从一段文字里挑出像文件路径的片段（不靠正则，避免 Windows 反斜杠转义歧义）。 */
function pathsIn(text, into) {
  let cur = ''
  const flush = () => {
    if (cur && looksLikePath(cur)) into.add(cur)
    cur = ''
  }
  for (const ch of String(text || '')) {
    if (PATH_CHARS.has(ch)) cur += ch
    else flush()
  }
  flush()
}

const SENT_SEP = new Set(['。', '！', '？', NL])

/** 按句号/感叹号/问号/换行切句。 */
function sentences(text) {
  const out = []
  let cur = ''
  for (const ch of String(text || '')) {
    cur += ch
    if (SENT_SEP.has(ch)) {
      const s = cur.trim()
      if (s) out.push(s)
      cur = ''
    }
  }
  const rest = cur.trim()
  if (rest) out.push(rest)
  return out
}

const PREF_RE = /必须|不要|别用|以后|一律|记住|每次|优先|禁止|只允许|不能|一定要|直接部署/
const DECISION_RE = /结论|决定|最终|方案|改成|采用|确认|定下来|就这样|结论是/
const FAIL_RE = /失败过|试过不行|行不通|没跑通|走不通|报错|被拒|还是错|不работа/
const OPEN_RE = /待确认|不确定|要问|未定|还没|待定|需要确认|问一下|风险|复测/
const NEXT_RE = /下一步|接下来|现在要|先做|需要做|再去/

const TOOL_KEYS = ['file_path', 'path', 'cwd', 'command', 'cmd', 'query', 'url', 'pattern', 'fp', 'name']

const targetOf = (args) => {
  if (typeof args === 'string') return cut(args, 160)
  if (!args || typeof args !== 'object') return ''
  for (const k of TOOL_KEYS) {
    const v = args[k]
    if (typeof v === 'string' && v.trim()) return cut(v, 160)
  }
  return ''
}

/**
 * 从事件流生成交接简报。
 * @param {object[]} events 会话日志事件
 * @param {{now?:number, source?:string, stats?:object}} options
 * @returns {string}
 */
export function buildBrief(events, options = {}) {
  const users = []
  const assistants = []
  const paths = new Set()
  const toolHits = new Map()
  const commands = []
  for (const ev of events || []) {
    if (!ev || !ev.type) continue
    if (ev.type === 'user/message') {
      // 只认真的用户输入：注入的运行时上下文、时间戳、插件提示的 source.kind 不是 user
      if (ev.data?.source?.kind !== 'user') continue
      const text = textOf(ev.data?.content)
      // 连续重置时，上一次的简报不是用户说的话，跳过。
      if (text.startsWith(BRIEF_MARK)) continue
      if (text) users.push(text)
      pathsIn(text, paths)
      continue
    }
    if (ev.type === 'assistant/message') {
      const text = textOf(ev.data?.message?.content)
      if (text) assistants.push(text)
      continue
    }
    if (ev.type === 'tool/call') {
      const raw = ev.data?.arguments ?? ev.data?.input ?? ev.data?.args ?? ''
      let args = raw
      if (typeof raw === 'string') {
        try { args = JSON.parse(raw) } catch { args = raw }
      }
      const argText = typeof args === 'string' ? args : JSON.stringify(args)
      pathsIn(argText, paths)
      const name = String(ev.data?.name || ev.data?.toolName || ev.data?.tool || '')
      if (!name) continue
      const target = targetOf(args)
      if (/bash|shell/i.test(name) && target) commands.push(target)
      const key = name + '|' + target
      const row = toolHits.get(key) || { name, target, count: 0 }
      row.count += 1
      toolHits.set(key, row)
    }
  }

  const first = users[0] || ''
  const tail = assistants.length ? assistants[assistants.length - 1] : ''
  const allAssistant = assistants.join(NL)
  const userText = users.join(NL)

  const asks = users.slice(1).map((t, i) => (i + 2) + '. ' + cut(t, 140)).slice(-10)

  const userPrefs = []
  for (const sent of sentences(userText)) {
    if (sent && PREF_RE.test(sent)) userPrefs.push('- ' + cut(sent, 140))
  }

  const decisions = []
  for (const sent of sentences(allAssistant)) {
    if (sent && DECISION_RE.test(sent)) decisions.push('- ' + cut(sent, 160))
  }

  const fails = []
  for (const sent of sentences(allAssistant)) {
    if (sent && FAIL_RE.test(sent)) fails.push('- ' + cut(sent, 160))
  }

  const openQs = []
  for (const sent of sentences(allAssistant)) {
    if (!sent) continue
    if (OPEN_RE.test(sent) || sent.includes('？') || sent.includes('?')) openQs.push('- ' + cut(sent, 160))
  }

  const nextBits = sentences(tail).filter((s) => NEXT_RE.test(s))
  const nextLine = nextBits.length ? cut(nextBits[nextBits.length - 1], 260) : ''

  const out = []
  out.push('# 交接简报（极致提炼 · 离线生成）')
  out.push('')
  out.push('> 这份简报是上一个窗口留下的全部内容。旧的对话记录已经被丢弃，需要细节就按下面的线索重新做。')
  out.push('> 生成时间：' + new Date(options.now || Date.now()).toISOString() + (options.source ? '｜原记录：' + options.source : ''))
  out.push('')

  out.push('## 0. 先读这段（怎么用这份简报）')
  out.push('- 这是「上一个窗口」写的交接，不是用户现在说的话；它记录的是过去。')
  out.push('- 出现任意一条，就该停下来重读这份简报，不要硬往下做：')
  out.push('  1. 开始重复回答已经答过的问题')
  out.push('  2. 忘了第 5 节写着的事实，凭印象说话')
  out.push('  3. 又在试第 5 节里标了「失败过」的做法')
  out.push('  4. 同一个文件被反复重读')
  out.push('  5. 上下文过半')
  out.push('- 交接指令：读这份简报与 git log -5，先跑第 2 节最后一条 Done 的验收检查，确认现状没变，再做第 3 节 Next 的第一条。')
  out.push('')

  out.push('## 1. 这个对话在做什么（Goal）')
  out.push(cut(first, 700) || '（没有找到用户的第一条消息）')
  out.push('')
  if (asks.length) {
    out.push('后续追加的要求：')
    out.push(asks.join(NL))
    out.push('')
  }
  out.push('整体验收检查：（原记录里没写，动手前先补一条能跑的命令或能打开的结果）')
  out.push('')

  out.push('## 2. 做完了什么（Done：动作 + 可重跑的线索）')
  out.push('（这些是「做过什么动作」，不是「已经做对了」；要确认得重跑下面的检查。）')
  const rows = [...toolHits.values()].slice(-14)
  if (rows.length) {
    for (const row of rows) {
      out.push('- ' + row.name + (row.target ? '：' + row.target : '') + '（' + row.count + ' 次）')
    }
  } else {
    out.push('- （原记录里没有工具调用）')
  }
  if (commands.length) out.push('- 最后一条命令（重跑它确认现状还在）：' + commands[commands.length - 1])
  out.push('')

  out.push('## 3. 接下来（Next）')
  out.push('- 第一条（最具体的一步）：' + (nextLine || '从第 1 节的目标推一个最小动作，先告诉用户你要做什么再动手。'))
  if (tail) {
    out.push('- 上一个窗口最后说到的位置：' + cut(tail, 600))
  }
  out.push('')

  out.push('## 4. 还没定的事（Open questions）')
  const openUniq = [...new Set(openQs)].slice(-6)
  if (openUniq.length) out.push(openUniq.join(NL))
  else out.push('（没有记录到待定项；如果确实有，先问用户，不要自己替用户决定。）')
  out.push('')

  out.push('## 5. 关键事实（Key facts）')
  const pathList = [...paths].filter((p) => p.length > 3).slice(0, 12)
  let hasFacts = false
  if (pathList.length) {
    out.push('文件与路径：')
    out.push(pathList.map((p) => '- ' + p).join(NL))
    out.push('')
    hasFacts = true
  }
  if (commands.length) {
    out.push('跑过的命令（可重跑）：')
    out.push([...new Set(commands)].slice(-6).map((c) => '- ' + c).join(NL))
    out.push('')
    hasFacts = true
  }
  if (decisions.length) {
    out.push('已经定下来的做法：')
    out.push([...new Set(decisions)].slice(-4).join(NL))
    out.push('')
    hasFacts = true
  }
  if (fails.length) {
    out.push('失败过的做法（别再试，除非有证据说原因变了）：')
    out.push([...new Set(fails)].slice(-3).join(NL))
    out.push('')
    hasFacts = true
  }
  if (userPrefs.length) {
    out.push('用户的硬约束与偏好：')
    out.push([...new Set(userPrefs)].slice(-6).join(NL))
    out.push('')
    hasFacts = true
  }
  if (!hasFacts) out.push('（原记录里没抽出确定的事实；先跑第 1 节的验收检查再动手。）')
  out.push('')

  out.push('---')
  out.push('上面就是全部上下文。请接着做，不要复述这份简报。')

  let text = out.join(NL)
  if (text.length > MAX_TOTAL) {
    // 超预算：保住第 5 节的关键事实和结尾，砍掉中间展开的部分。
    const kfStart = text.indexOf('## 5. 关键事实')
    const kf = kfStart > 0 ? text.slice(kfStart) : ''
    const head = kfStart > 0 ? text.slice(0, kfStart) : text
    const room = Math.max(1200, MAX_TOTAL - kf.length - 40)
    text = head.slice(0, room).trimEnd() + NL + NL + '…（中间省略）' + NL + NL + kf
  }
  if (text.length > MAX_TOTAL) text = text.slice(0, MAX_TOTAL - 1) + '…'
  return text
}
