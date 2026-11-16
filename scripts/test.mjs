import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(dir, '..', 'client.js')
const source = fs.readFileSync(file, 'utf8')

// ---------------------------------------------------------------- 静态检查
assert.match(source, /id: 'context-refiner'/, '缺少 dock 注册')
assert.match(source, /id: 'context-refiner-dialog'/, '缺少 overlay 注册')
assert.match(source, /order: 32/, 'order 应为 32')
assert.match(source, /shell\.overlay/, '弹窗应注册在 shell.overlay')
assert.match(source, /showModal/, '弹窗应使用原生 dialog.showModal')
assert.match(source, /attachmentIds/, '提交前应检查附件')
assert.match(source, /epoch/, '提交校验应按弹窗 epoch 归属')
assert.doesNotMatch(source, /包括已经压过的旧摘要块/, '极致档不应再承诺合并旧摘要块')
for (const id of ['light', 'standard', 'deep', 'max']) assert.ok(source.includes("id: '" + id + "'"), '缺少档位 ' + id)
assert.match(source, /已经压过的区间不要重复压/, '普通档应保留防重复压缩的约束')
assert.match(source, /已经折叠成摘要块的旧内容保持原样/, '极致档应把旧摘要块排除在外')
assert.match(source, /acp_status/, '指令应要求先看可压缩范围')
assert.match(source, /\/dsh-context-refiner\/state/, '应查宿主状态')
assert.match(source, /\/dsh-context-refiner\/reset/, '应调宿主重置接口')
assert.match(source, /x-dsh-context-refiner-token/, '重置应带写令牌')
assert.match(source, /RESET_PREVIEW/, '极致档应有离线重置的说明')
assert.match(source, /confirm:\s*'reset'/, '重置请求应带确认标记')
assert.match(source, /showModal/, '弹窗应使用原生 dialog')

// ---------------------------------------------------------------- 迷你 React
function createHarness() {
  const instances = new Map()
  const mounted = new Map()
  const dirty = new Set()
  const current = { inst: null }
  const fakeEl = (tag) => ({
    tag,
    focus() {},
    disabled: false,
    open: false,
    querySelectorAll: () => [],
    showModal() { this.open = true },
    close() { this.open = false },
    setAttribute() {},
  })

  const React = {
    createElement(type, props, ...children) {
      const merged = Object.assign({}, props || {})
      if (children.length) merged.children = children.length === 1 ? children[0] : children
      return { type, props: merged }
    },
    Component: class Component {
      constructor(props) { this.props = props; this.state = {} }
    },
    useState(initial) {
      const inst = current.inst
      const slot = inst.slot++
      if (!(slot in inst.state)) inst.state[slot] = typeof initial === 'function' ? initial() : initial
      const set = (value) => {
        const next = typeof value === 'function' ? value(inst.state[slot]) : value
        if (Object.is(next, inst.state[slot])) return
        inst.state[slot] = next
        dirty.add(inst.rootKey)
      }
      return [inst.state[slot], set]
    },
    useRef(initial) {
      const inst = current.inst
      const slot = inst.slot++
      if (!(slot in inst.refs)) inst.refs[slot] = { current: initial }
      return inst.refs[slot]
    },
    useEffect(fn, deps) {
      const inst = current.inst
      const slot = inst.slot++
      const prev = inst.effects[slot]
      const changed = !prev || !deps || !prev.deps || prev.deps.length !== deps.length
        || deps.some((dep, index) => !Object.is(dep, prev.deps[index]))
      if (changed) inst.effects[slot] = { fn, deps, pending: true, cleanup: prev && prev.cleanup }
    },
    useCallback(fn, deps) {
      const inst = current.inst
      const slot = inst.slot++
      const prev = inst.callbacks[slot]
      const changed = !prev || !deps || !prev.deps || prev.deps.length !== deps.length
        || deps.some((dep, index) => !Object.is(dep, prev.deps[index]))
      if (changed) inst.callbacks[slot] = { fn, deps }
      return inst.callbacks[slot].fn
    },
  }

  function instantiate(key, rootKey) {
    let inst = instances.get(key)
    if (!inst) {
      inst = { key, rootKey, slot: 0, state: {}, refs: {}, effects: {}, callbacks: {}, mounted: true }
      instances.set(key, inst)
    }
    return inst
  }

  function renderNode(node, keyPath, rootKey) {
    if (node === null || node === undefined || node === false || node === true) return null
    if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
    if (Array.isArray(node)) return node.map((child, index) => renderNode(child, keyPath + '.' + index, rootKey))
    const { type, props } = node
    if (typeof type === 'string') {
      const el = fakeEl(type)
      if (typeof props.ref === 'function') props.ref(el)
      const children = renderNode(props.children, keyPath + '/' + type, rootKey)
      return { tag: type, props, children: Array.isArray(children) ? children : children == null ? [] : [children], el }
    }
    if (typeof type === 'function') {
      // 迷你 React 也要认 key：换 key = 卸载重挂，状态清零（真实的弹窗每次都重新挂载）。
      const keyed = keyPath + '#' + String(props.key === undefined ? '' : props.key)
      if (type.prototype && typeof type.prototype.render === 'function') {
        const inst = new type(props)
        return renderNode(inst.render(), keyed + '/' + (type.name || 'class'), rootKey)
      }
      const inst = instantiate(keyed, rootKey)
      inst.slot = 0
      const previous = current.inst
      current.inst = inst
      let output
      try { output = type(props) } finally { current.inst = previous }
      return renderNode(output, keyed + '/out', rootKey)
    }
    return null
  }

  function flush() {
    for (let round = 0; round < 40; round += 1) {
      let changed = false
      for (const inst of instances.values()) {
        for (const [slot, effect] of Object.entries(inst.effects)) {
          if (!effect.pending) continue
          changed = true
          effect.pending = false
          if (effect.cleanup) { try { effect.cleanup() } catch (error) { /* ignore */ } }
          const cleanup = effect.fn()
          effect.cleanup = typeof cleanup === 'function' ? cleanup : null
          effect.cleanupSlot = slot
        }
      }
      for (const [key, entry] of mounted) {
        if (!dirty.has(key)) continue
        dirty.delete(key)
        changed = true
        entry.tree = renderNode(React.createElement(entry.fn, entry.props), key, key)
      }
      if (!changed) return
    }
    throw new Error('flush 未收敛')
  }

  return {
    React,
    mount(key, fn, props) {
      const entry = { key, fn, props }
      mounted.set(key, entry)
      entry.tree = renderNode(React.createElement(fn, props), key, key)
      flush()
      return entry.tree
    },
    update(key, props) {
      const entry = mounted.get(key)
      entry.props = props
      entry.tree = renderNode(React.createElement(entry.fn, props), key, key)
      flush()
      return entry.tree
    },
    tree(key) { return mounted.get(key).tree },
    flush,
    act(fn) { fn(); flush() },
    dispose() {
      for (const inst of instances.values()) {
        for (const effect of Object.values(inst.effects)) {
          if (effect.cleanup) { try { effect.cleanup() } catch (error) { /* ignore */ } }
        }
      }
    },
  }
}

// ---------------------------------------------------------------- DOM 与宿主桩
const styleNodes = []
const listeners = []
const fakeDocument = {
  activeElement: null,
  head: { appendChild(node) { styleNodes.push(node) } },
  getElementById(id) { return styleNodes.find((node) => node.id === id) || null },
  createElement(tag) { return { tag, id: '', textContent: '' } },
  addEventListener(type, fn) { listeners.push([type, fn]) },
  removeEventListener(type, fn) { const i = listeners.findIndex(([t, f]) => t === type && f === fn); if (i >= 0) listeners.splice(i, 1) },
  querySelector() { return null },
  querySelectorAll() { return [] },
}

const harness = createHarness()
const React = harness.React
const registrations = []
let factory = null
const windowStub = { __ModuleLoader__: { load(spec) { factory = spec.factory } } }
const load = new Function('window', 'document', 'console', 'setTimeout', 'clearTimeout', source)
load(windowStub, fakeDocument, console, setTimeout, clearTimeout)
const api = factory((name) => {
  if (name !== 'react') throw new Error('unexpected require ' + name)
  return React
})
assert.equal(api.name, 'dsh-context-refiner')
assert.deepEqual(api.inject, ['slots'])

api.apply({
  effect(fn) { const cleanup = fn(); return cleanup },
  slots: {
    inject(name, fn) { const descriptor = fn(); descriptor.slotName = name; registrations.push(descriptor) },
    register(options, render) { return { options, render } },
  },
})
assert.equal(registrations.length, 2, '应注册两个插槽')
const dockEntry = registrations.find((item) => item.slotName === 'conversation.composer.dock')
const overlayEntry = registrations.find((item) => item.slotName === 'shell.overlay')
assert.ok(dockEntry && overlayEntry, '缺少 dock 或 overlay 注册')
assert.equal(styleNodes.length, 1, '样式应只注入一次')

// ---------------------------------------------------------------- 行为测试
const state = { draft: '我原来的草稿', phase: 'plain', attachmentIds: [] }
const calls = []
const actions = {
  setDraft(text) { calls.push(['setDraft', text]); state.draft = text },
  submit() { calls.push(['submit']) },
}
const inputProps = (extra) => Object.assign({
  sessionId: 'session-test',
  inputActions: actions,
  useInput: (selector) => selector(state),
  useConversation: () => ({}),
}, extra || {})

const fetchLog = []
let fetchImpl = async () => jsonResponse({ ok: false, error: '没有桩' }, false, 500)
let resolveReset = null
const jsonResponse = (body, ok = true, status = 200) => Promise.resolve({ ok, status, json: async () => body })
const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); harness.flush() }
const requestCloseOf = () => find(harness.tree('overlay'), (node) => node.tag === 'button' && textOf(node) === '取消')

const find = (node, predicate) => {
  if (!node) return null
  if (Array.isArray(node)) { for (const child of node) { const hit = find(child, predicate); if (hit) return hit } return null }
  if (node.text !== undefined) return null
  if (predicate(node)) return node
  for (const child of node.children || []) { const hit = find(child, predicate); if (hit) return hit }
  return null
}
const collect = (node, predicate, out = []) => {
  if (!node) return out
  if (Array.isArray(node)) { node.forEach((child) => collect(child, predicate, out)); return out }
  if (node.text !== undefined) return out
  if (predicate(node)) out.push(node)
  for (const child of node.children || []) collect(child, predicate, out)
  return out
}
const textOf = (node) => {
  if (!node) return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node.text !== undefined) return node.text
  return (node.children || []).map(textOf).join('')
}
const primaryOf = () => find(harness.tree('overlay'), (node) => node.tag === 'button' && /开始提炼|重置中|提交中|先看交接简报|正在生成简报|确认重置并丢弃旧记录/.test(textOf(node)))
const dialogOf = () => find(harness.tree('overlay'), (node) => node.props && node.props.role === 'dialog')
const alertOf = () => find(harness.tree('overlay'), (node) => node.props && node.props.role === 'alert')
const openButton = () => find(harness.tree('dock'), (node) => node.tag === 'button' && textOf(node).includes('提炼'))

// 1) 按钮渲染
harness.mount('dock', dockEntry.render, inputProps())
harness.mount('overlay', overlayEntry.render, {})
assert.ok(openButton(), '应渲染提炼按钮')
assert.equal(openButton().props.disabled, false)

// 2) 点开弹窗
harness.act(() => openButton().props.onClick())
assert.ok(dialogOf(), '点击后应打开弹窗')
assert.equal(dialogOf().tag, 'dialog', '弹窗应是原生 dialog')
let radios = collect(harness.tree('overlay'), (node) => node.props && node.props.role === 'radio')
assert.equal(radios.length, 4, '应有四个档位')
assert.equal(radios[1].props['aria-checked'], 'true', '默认选中标准')

// 3) 标准档提交
harness.act(() => primaryOf().props.onClick())
const draftCall = calls.find(([kind]) => kind === 'setDraft')
assert.ok(draftCall, '提交应写入指令')
assert.match(draftCall[1], /【上下文提炼】/)
assert.match(draftCall[1], /已经压过的区间不要重复压/)
assert.ok(calls.some(([kind]) => kind === 'submit'), '提交应调用 submit')

// 4) 还没真正开始跑时不关闭
harness.update('dock', inputProps())
assert.ok(dialogOf(), '还没生效时弹窗应留着')

// 5) 宿主开始跑（phase 先变）→ 关窗；此时不抢草稿，等输入框被清空
const marksBefore = calls.length
state.phase = 'sending'
harness.update('dock', inputProps())
assert.equal(harness.tree('overlay'), null, '提交生效后弹窗应关闭')
assert.equal(calls.length, marksBefore, '还没清空输入框时不应恢复草稿')

// 6) 宿主结算完（输入框被清空、phase 回 plain）→ 恢复原草稿
state.phase = 'plain'
state.draft = ''
harness.update('dock', inputProps())
assert.ok(calls.some(([kind, text]) => kind === 'setDraft' && text === '我原来的草稿'), '应恢复原来的草稿')

// 7) 忙时按钮禁用
state.phase = 'sending'
state.draft = '我原来的草稿'
harness.update('dock', inputProps())
assert.equal(openButton().props.disabled, true, '会话忙时按钮应禁用')
assert.equal(openButton().props['aria-busy'], 'true')

// 8) 附件在场时拒绝自动提交
state.phase = 'plain'
state.attachmentIds = ['file-1']
harness.update('dock', inputProps())
harness.act(() => openButton().props.onClick())
const submitsBefore = calls.filter(([kind]) => kind === 'submit').length
harness.act(() => primaryOf().props.onClick())
assert.ok(alertOf(), '有附件时应给出提示')
assert.match(textOf(alertOf()), /附件/)
assert.equal(calls.filter(([kind]) => kind === 'submit').length, submitsBefore, '有附件时不应提交')
state.attachmentIds = []
harness.act(() => dialogOf().props.onCancel({ preventDefault() {} }))
assert.equal(harness.tree('overlay'), null, '取消后弹窗应关闭')

// 9) 极致档是离线重置：预览讲重置流程，确认后调宿主接口，不发指令
globalThis.fetch = async (url, options) => {
  fetchLog.push([String(url), options])
  return fetchImpl(String(url), options)
}
state.draft = '用户先打的字'
state.phase = 'plain'
harness.update('dock', inputProps())
harness.act(() => openButton().props.onClick())
radios = collect(harness.tree('overlay'), (node) => node.props && node.props.role === 'radio')
harness.act(() => radios[3].props.onClick())
const preview = find(harness.tree('overlay'), (node) => node.tag === 'pre')
assert.match(textOf(preview), /离线重置/, '极致档应说明是离线重置')
assert.match(textOf(preview), /交接简报/, '极致档应说明会留一份简报')
assert.doesNotMatch(textOf(preview), /包括已经压过的旧摘要块/)
assert.doesNotMatch(textOf(preview), /【上下文提炼】/, '极致档不应再提交指令给模型')

const draftsBefore = calls.filter(([kind]) => kind === 'setDraft').length
const submitsBeforeMax = calls.filter(([kind]) => kind === 'submit').length
fetchImpl = async (url, options) => {
  if (url.includes('/state')) return jsonResponse({ ok: true, token: 'tok-9', home: 'E:/DSH/home', log: { found: true, file: 'session.v4.jsonl.zstd', bytes: 3384291 } })
  if (String((options && options.body) || '').includes('"dryRun":true')) {
    return jsonResponse({ ok: true, sessionId: 'session-test', dryRun: true, bytesBefore: 3384291, bytesAfter: 4006, messagesBefore: 101, briefChars: 2132, brief: '## 1. 这个对话在做什么\n把插件做成四档提炼。' })
  }
  return new Promise((resolve) => { resolveReset = resolve })
}
harness.act(() => primaryOf().props.onClick())
await settle()
harness.flush()
assert.match(textOf(primaryOf()), /确认重置并丢弃旧记录/, '第一次点只做预览，按钮要变成确认')
const previewPanel = find(harness.tree('overlay'), (node) => node.tag === 'div' && textOf(node).includes('真实用户消息 101 条'))
assert.ok(previewPanel, '应显示真实简报预览')
assert.match(textOf(previewPanel), /这个对话在做什么/, '预览里要有简报正文')
assert.equal(calls.filter(([kind]) => kind === 'setDraft').length, draftsBefore, '极致档不应改草稿')
assert.equal(calls.filter(([kind]) => kind === 'submit').length, submitsBeforeMax, '极致档不应提交')
harness.act(() => primaryOf().props.onClick())
harness.flush()
assert.match(textOf(primaryOf()), /重置中/)

// 10) 重置进行中不能关弹窗
let prevented = false
harness.act(() => dialogOf().props.onCancel({ preventDefault() { prevented = true } }))
assert.equal(prevented, true, 'Esc 应 preventDefault')
assert.ok(dialogOf(), '重置中弹窗不应被关掉')

// 11) 重置成功 → 弹窗里显示报告，并进入「已重置」锁定态：关不掉、也不让再提炼
await settle()
assert.ok(fetchLog.some(([url]) => url.includes('/state')), '应先用 /state 拿令牌')
assert.ok(fetchLog.some(([url]) => url.includes('/reset')), '应调用 /reset')
resolveReset(await jsonResponse({ ok: true, sessionId: 'session-test', bytesBefore: 3384291, bytesAfter: 4006, backup: 'session.v4.jsonl.zstd.bak-refiner-1', ledgers: [{ name: 'api.deepseek.com_aa.json', moved: true }], projcache: 'moved' }))
await settle()
harness.flush()
assert.equal(harness.tree('overlay') !== null, true, '成功后弹窗应保留报告')
const report = find(harness.tree('overlay'), (node) => node.tag === 'div' && textOf(node).includes('已重置'))
assert.ok(report, '应显示重置报告')
assert.match(textOf(report), /3\.2 MB → 3\.9 KB/)
assert.match(textOf(report), /完全退出 DeepSeek Harness/)
const resetCall = fetchLog.find(([url]) => url.includes('/reset'))
assert.ok(resetCall, '应调用 /reset')
assert.equal(resetCall[1].headers['x-dsh-context-refiner-token'], 'tok-9', '应带写令牌')
assert.match(resetCall[1].body, /"confirm":"reset"/)
assert.equal(state.draft, '用户先打的字', '重置不应动输入框')
assert.equal(primaryOf(), null, '锁定态不该再有「开始提炼」')
assert.equal(requestCloseOf(), null, '锁定态不该有「取消」')
assert.equal(find(harness.tree('overlay'), (n) => n.tag === 'button' && textOf(n) === '重新加载这个页面'), null, '不能把「刷新页面」当解药')
assert.ok(find(harness.tree('overlay'), (n) => n.tag === 'button' && textOf(n) === '我知道风险，先用这个窗口'), '应保留明说风险的退路')
assert.equal(openButton().props.disabled, true, '重置后入口按钮应禁用，直到刷新/解锁')
harness.act(() => dialogOf().props.onCancel({ preventDefault() {} }))
assert.ok(dialogOf(), '重置成功后不能被 Esc/取消关掉')
harness.act(() => find(harness.tree('overlay'), (n) => n.tag === 'button' && textOf(n) === '我知道风险，先用这个窗口').props.onClick())
harness.act(() => requestCloseOf().props.onClick())
assert.equal(harness.tree('overlay'), null, '显式解锁后才能关闭')
assert.equal(openButton().props.disabled, false, '解锁后入口恢复')

// 12) 重置失败 → 保留弹窗并说明原因，可重试
harness.act(() => openButton().props.onClick())
radios = collect(harness.tree('overlay'), (node) => node.props && node.props.role === 'radio')
harness.act(() => radios[3].props.onClick())
fetchImpl = async (url, options) => {
  if (url.includes('/state')) return jsonResponse({ ok: true, token: 'tok-9', home: 'E:/DSH/home', log: { found: true, file: 'session.v4.jsonl.zstd', bytes: 3384291 } })
  if (String((options && options.body) || '').includes('"dryRun":true')) {
    return jsonResponse({ ok: true, dryRun: true, bytesBefore: 3384291, bytesAfter: 4006, messagesBefore: 101, briefChars: 2132, brief: '## 1. 这个对话在做什么\n测试用简报' })
  }
  return jsonResponse({ ok: false, error: '宿主忙，等一会再试' }, false, 500)
}
harness.act(() => primaryOf().props.onClick())
await settle()
harness.act(() => primaryOf().props.onClick())
await settle()
harness.flush()
assert.ok(dialogOf(), '失败后弹窗应保留')
assert.ok(alertOf(), '失败应给出提示')
assert.match(textOf(alertOf()), /宿主忙/)

// 12b) 宿主说没找到日志 → 说清楚原因，也不能发 /reset
fetchImpl = async (url) => {
  if (url.includes('/state')) return jsonResponse({ ok: true, token: 'tok-9', home: 'E:/DSH/home', log: { found: false } })
  return jsonResponse({ ok: false, error: '不该走到这里' }, false, 500)
}
const resetCallsBefore = fetchLog.filter(([url]) => url.includes('/reset')).length
harness.act(() => primaryOf().props.onClick())
await settle()
harness.flush()
assert.ok(dialogOf(), '没找到日志时弹窗应保留')
assert.match(textOf(alertOf()), /没找到这个会话的日志文件/)
assert.equal(fetchLog.filter(([url]) => url.includes('/reset')).length, resetCallsBefore, '没找到日志时不该发 /reset')

// 13) 取消后重开：上一轮的校验状态不能影响新弹窗
harness.act(() => dialogOf().props.onCancel({ preventDefault() {} }))
assert.equal(harness.tree('overlay'), null, '取消后应关闭')
state.draft = '用户先打的字'
harness.update('dock', inputProps())
harness.act(() => openButton().props.onClick())
const fresh = dialogOf()
assert.ok(fresh, '再次打开应工作')
state.phase = 'sending'
harness.update('dock', inputProps())
assert.ok(dialogOf(), '没有待校验的提交时，忙起来不应关掉新弹窗')
state.phase = 'plain'
harness.act(() => dialogOf().props.onCancel({ preventDefault() {} }))

// 14) 拿不到输入框接口时给出可操作的错误文案
harness.act(() => openButton().props.onClick())
const bare = { sessionId: 'session-test', useInput: (selector) => selector(state) }
harness.act(() => dialogOf().props.onCancel({ preventDefault() {} }))
harness.update('dock', bare)
harness.act(() => openButton().props.onClick())
harness.act(() => primaryOf().props.onClick())
assert.ok(alertOf(), '拿不到接口时应显示错误')
assert.match(textOf(alertOf()), /拿不到输入框接口/)

harness.dispose()
console.log('ok: 2 个插槽注册，四档指令齐全，提交/草稿恢复/附件/弹窗归属/离线重置 通过')
