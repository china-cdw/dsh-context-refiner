// dsh-context-refiner — 输入框下方的「上下文提炼」按钮（billion-context 的配套 UI）
//
// 压缩本身由 billion-context 的 compress 工具完成（摘要必须由模型写），
// 这里只负责三件事：选档位 -> 拼一条固定指令 -> 提交到当前会话。
// 弹窗注册在 shell.overlay：composer.dock 附近的祖先带 transform/overflow 时，
// position:fixed 会被裁剪或错位，浮层必须挂到根上。
window.__ModuleLoader__.load({
  id: 'dsh-context-refiner',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    // ------------------------------------------------------------ 样式
    // 只用宿主主题 token，跟随浅色/深色自动换色。
    const STYLE_ID = 'dsh-context-refiner-style'
    const CSS = ".dcr-root{display:inline-flex;align-items:center}\n.dcr-btn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}\n.dcr-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}\n.dcr-btn:disabled{opacity:.55;cursor:default}\n.dcr-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warning-primary,#e6a23c)}\n.dcr-modal{margin:auto;width:min(600px,calc(100vw - 48px));max-height:min(84vh,760px);overflow:auto;box-sizing:border-box;padding:18px 20px 16px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);border:1px solid var(--dsw-alias-border-l3,#ddd);border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.24);font-size:13px;line-height:1.6}\n.dcr-modal::backdrop{background:rgba(0,0,0,.32)}\n.dcr-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}\n.dcr-title{margin:0;font-size:15px;font-weight:600}\n.dcr-sub{margin:2px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary)}\n.dcr-close{border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:18px;line-height:1;cursor:pointer;padding:2px 6px}\n.dcr-modes{display:flex;flex-direction:column;gap:8px;margin:14px 0}\n.dcr-mode{display:flex;gap:10px;align-items:flex-start;text-align:left;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-base,#fff);padding:10px 12px;cursor:pointer;font:inherit;color:inherit}\n.dcr-mode[data-active=\"1\"]{border-color:var(--dsw-alias-brand-primary,#4c8dff);background:var(--dsw-alias-interactive-bg-hover-accent,rgba(76,141,255,.08))}\n.dcr-radio{width:14px;height:14px;margin-top:3px;border-radius:50%;border:1px solid var(--dsw-alias-border-l4,#bbb);flex:none}\n.dcr-mode[data-active=\"1\"] .dcr-radio{border-color:var(--dsw-alias-brand-primary,#4c8dff);box-shadow:inset 0 0 0 3px var(--dsw-alias-brand-primary,#4c8dff)}\n.dcr-mode b{display:block;font-size:13px}\n.dcr-mode em{display:block;font-style:normal;font-size:12px;color:var(--dsw-alias-label-secondary);margin:2px 0}\n.dcr-keep{display:block;font-size:11px;color:var(--dsw-alias-label-tertiary)}\n.dcr-check{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:var(--dsw-alias-label-secondary);margin:2px 0 10px;cursor:pointer}\n.dcr-check input{margin-top:2px}\n.dcr-details{font-size:12px;color:var(--dsw-alias-label-secondary);margin:6px 0}\n.dcr-details summary{cursor:pointer}\n.dcr-pre{margin:8px 0 0;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto}\n.dcr-note{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:8px 0 0}\n.dcr-err{margin:10px 0 0;padding:8px 10px;border-radius:8px;font-size:12px;background:var(--dsw-alias-bg-error,rgba(220,38,38,.08));color:var(--dsw-alias-state-error-primary,#b91c1c)}\n.dcr-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}\n.dcr-ghost,.dcr-primary{font:inherit;font-size:12px;height:30px;padding:0 14px;border-radius:8px;cursor:pointer}\n.dcr-ghost{border:1px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary)}\n.dcr-primary{border:1px solid transparent;background:var(--dsw-alias-brand-primary,#4c8dff);color:#fff}\n.dcr-primary:disabled{opacity:.6;cursor:default}"

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
      // 故意不在 dispose 里移除：热重载时新旧实例共用同一个 <style>，
      // 谁先卸载谁删掉它，会让还在用的实例没有样式。固定 id 只增不删。
    }

    // ------------------------------------------------------------ 弹窗状态
    // dock 与 overlay 是两个插槽，靠这个极小的订阅桥通信。
    // epoch 每次打开自增：关闭后重开时，上一轮的校验定时器/回调会因 epoch 不符而失效。
    const dialog = {
      state: { open: false, busy: false, note: '', ctrl: null, epoch: 0, result: null, lockedSession: '', dialogSession: '' },
      listeners: new Set(),
      update(patch) {
        dialog.state = Object.assign({}, dialog.state, patch)
        dialog.listeners.forEach((fn) => {
          try { fn() } catch (error) { console.error('[context-refiner] listener', error) }
        })
      },
      subscribe(fn) {
        dialog.listeners.add(fn)
        return () => { dialog.listeners.delete(fn) }
      },
      open(ctrl, sessionId) {
        dialog.update({ open: true, busy: false, note: '', ctrl, epoch: dialog.state.epoch + 1, result: null, dialogSession: sessionId || '' })
      },
      close() {
        // lockedSession 要留给 dock 判断「这个会话还没重开」，dialogSession 只属于当前弹窗。
        dialog.update({ open: false, busy: false, note: '', ctrl: null, result: null, dialogSession: '' })
      },
    }

    // ------------------------------------------------------------ 焦点
    // 关闭时原按钮可能已变成 disabled（正是 phase 变化导致关窗），对 disabled 元素
    // focus() 是空操作，焦点会掉到 body；退回到输入区，别让键盘用户从页首重来。
    function focusComposer() {
      if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return
      try {
        const el = document.querySelector('[contenteditable="true"], textarea, [role="textbox"]')
        if (el && typeof el.focus === 'function') el.focus()
      } catch (error) { /* 找不到落点就放弃 */ }
    }

    function formatBytes(n) {
      const value = Number(n) || 0
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      return (value / 1024 / 1024).toFixed(1) + ' MB'
    }

    function restoreFocus(target) {
      try {
        if (target && target.isConnected !== false && !target.disabled && typeof target.focus === 'function') {
          target.focus()
          if (typeof document === 'undefined' || document.activeElement === target || !document.activeElement) return
        }
      } catch (error) { /* 继续兜底 */ }
      focusComposer()
    }

    // ------------------------------------------------------------ 档位与指令
    const MODES = [
      { id: 'light', name: '轻度', desc: '只压最早那几段，最近的原话都留着', keep: '保留：最近 20 条 + 用户的要求与结论' },
      { id: 'standard', name: '标准', desc: '按主题提炼，日常用这个', keep: '保留：最近 8 轮 + 结论/决策/路径/数字' },
      { id: 'deep', name: '深度', desc: '只留结论清单', keep: '保留：最近 3 轮 + 长期约束/未完成目标' },
      { id: 'max', name: '极致', desc: '旧记录整个丢掉，只留一份交接简报（离线，不花模型）', keep: '保留：交接简报 + 当前权限设置；旧记录备份在旁边' },
    ]

    const BRIEF = [
      '## 用户习惯与长期约束',
      '## 这个对话在做什么',
      '## 已确认的结论与决策',
      '## 未完成目标与下一步',
      '## 关键路径与数字',
    ]

    const TAIL = '完成后只回一行统计：压了 N 项、省约 X tokens、剩余 Y%。'

    const PREFIX = {
      normal: '【上下文提炼】现在只做上下文压缩这一件事：不要问我、不要解释过程、不要在回复里复述摘要。'
        + '先调 acp_status 看当前可压缩范围；如果 acp_status 不可用，就按消息顺序自己判断最早的区间。'
        + '已经压过的区间不要重复压。',
      // 极致档压的范围更大，但仍不能碰已折叠的块：compress 只接受消息区间，块级没有合并入口。
      max: '【上下文提炼】现在只做上下文压缩这一件事：不要问我、不要解释过程、不要在回复里复述摘要。'
        + '先调 acp_status 看当前可压缩范围；如果 acp_status 不可用，就按消息顺序自己判断最早的区间。'
        + '已经折叠成摘要块的旧内容保持原样、不要重复压；只处理还没压过的较早区间。',
    }

    // 极致档不走模型：点下去以后由宿主把会话日志重写成「header + 一回合简报」。
    // 这段文字只是「看看会发什么」里的说明，不会提交。
    const RESET_PREVIEW = '极致 = 离线重置（不花模型调用）\n'
      + '1. 先干跑：读这个会话的日志，用规则抽一份交接简报（在做什么 / 你提过的要求 / 长期偏好 / 已确认结论 / 最近进展 / 关键路径 / 下一步），给你过目；\n'
      + '2. 你点确认后：把原日志复制一份备份，再把记录原子替换成「原来的会话标识 + 三条权限设置 + 一个回合」，那一回合的用户消息就是这份简报；\n'
      + '3. 顺手把这个会话的投影缓存和 billion-context 的旧账挪走（都留备份）。\n\n'
      + '结果：旧内容彻底不占上下文，也不会再被发给模型。\n'
      + '代价：细枝末节真的没了（只在备份文件里）；重置后要完全退出并重新打开 DeepSeek Harness，只刷新页面不够。'

    const BODY = {
      light: '模式：轻度。只处理最早、工具输出最密集的少量区间，一次最多 8 段，从最老的开始。'
        + '压缩时保留用户消息里的要求和结论（可以改写成要点，不要整条丢弃），最近 20 条消息原文不动。'
        + '摘要里保留结论、文件路径和数字。',
      standard: '模式：标准。把较早、还没压过的对话按主题压成 6–10 段摘要，每段不超过 8 条消息；保留最近 8 轮原文不动。'
        + '摘要必须保留：结论、决策及理由、文件路径、关键数字、未完成事项；可以丢弃：日志、重复探索、失败尝试的细节。',
      deep: '模式：深度。把较早、还没压过的对话整体压成一份结论清单，不超过 40 行；只保留最近 3 轮原文。'
        + '必须保留：用户的长期约束与偏好、未完成目标、关键路径与数字、已确认的结论及理由；过程日志全部丢弃。',
      max: '模式：极致。把还没压过的较早区间全部压掉、压到最薄，只保留最近 2 轮原文。'
        + 'compress 的 content 只写一份「交接简报」，严格按下面五个标题，每节 1–6 条，总长度不超过 60 行：\n\n'
        + BRIEF.join('\n') + '\n\n'
        + '简报要让一个没读过原文的人能直接接着干。',
    }

    function instructionFor(modeId, wantMemory) {
      const body = BODY[modeId] || BODY.standard
      const prefix = modeId === 'max' ? PREFIX.max : PREFIX.normal
      const memory = wantMemory
        ? ' 压缩完成后调用 memory_write，标题「对话交接：<一句话主题>」，内容就是这份交接简报，标签用 ["交接","上下文提炼"]。'
        : ''
      return prefix + '\n\n' + body + TAIL + memory
    }

    // ------------------------------------------------------------ 弹窗
    function RefineDialog(props) {
      const [mode, setMode] = useState('standard')
      const radios = useRef([])
      const dialogRef = useRef(null)
      const returnFocus = useRef(null)
      const closeRef = useRef(props.onClose)
      closeRef.current = props.onClose
      // 极致是破坏性操作：先干跑拿真实简报给用户看，第二次点才真写盘。
      const [preview, setPreview] = useState(null)
      const [previewing, setPreviewing] = useState(false)
      const [previewError, setPreviewError] = useState('')
      useEffect(() => {
        setPreview(null)
        setPreviewing(false)
        setPreviewError('')
      }, [mode])

      // 原生 <dialog> + showModal：自带背景 inert、焦点限制和 Esc 语义；
      // 不支持时退化成普通面板，下面的 Tab 兜底仍然有效。
      useEffect(() => {
        returnFocus.current = typeof document !== 'undefined' ? document.activeElement : null
        const el = dialogRef.current
        let modal = false
        try {
          if (el && typeof el.showModal === 'function') { el.showModal(); modal = true }
          else if (el && typeof el.setAttribute === 'function') el.setAttribute('open', '')
        } catch (error) { /* 退化成普通面板 */ }
        const first = radios.current[MODES.findIndex((item) => item.id === 'standard')] || radios.current[0]
        if (first && typeof first.focus === 'function') { try { first.focus() } catch (error) { /* 焦点进不去不算错 */ } }
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          closeRef.current()
        }
        if (typeof document !== 'undefined') document.addEventListener('keydown', onKey, true)
        return () => {
          if (typeof document !== 'undefined') document.removeEventListener('keydown', onKey, true)
          try { if (el && typeof el.close === 'function') el.close() } catch (error) { /* 已经关了 */ }
          restoreFocus(returnFocus.current)
          void modal
        }
      }, [])

      const moveMode = (delta) => {
        const current = Math.max(0, MODES.findIndex((item) => item.id === mode))
        const next = (current + delta + MODES.length) % MODES.length
        setMode(MODES[next].id)
        const el = radios.current[next]
        if (el && el.focus) el.focus()
      }

      const jumpMode = (index) => {
        const next = Math.max(0, Math.min(MODES.length - 1, index))
        setMode(MODES[next].id)
        const el = radios.current[next]
        if (el && el.focus) el.focus()
      }

      // 焦点圈在对话框里：Tab 到最后一个之后回到第一个（原生 dialog 已拦一层，这里兜底）。
      const onModalKeyDown = (event) => {
        if (event.key !== 'Tab') return
        const root = dialogRef.current
        if (!root || typeof root.querySelectorAll !== 'function') return
        const nodes = Array.prototype.slice.call(root.querySelectorAll('button, input, summary, [tabindex]:not([tabindex="-1"])'))
          .filter((node) => !node.disabled)
        if (!nodes.length) return
        const first = nodes[0]
        const last = nodes[nodes.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }

      const confirm = () => {
        if (props.busy || props.locked || previewing) return
        if (mode !== 'max') { props.onSubmit(mode); return }
        // 第二次点才真重置：第一次先让宿主干跑一遍，把真正的简报拿回来给用户看。
        if (preview) { props.onReset(); return }
        setPreviewing(true)
        setPreviewError('')
        Promise.resolve(props.onPreview ? props.onPreview() : { ok: false, error: '这个窗口拿不到宿主接口。' })
          .then((out) => {
            if (out && out.ok) setPreview(out)
            else setPreviewError((out && out.error) || '没拿到预览，再试一次。')
          }, (error) => {
            setPreviewError('预览失败：' + (error && error.message ? error.message : String(error)))
          })
          .finally(() => setPreviewing(false))
      }

      return h('dialog', {
        className: 'dcr-modal',
        ref: dialogRef,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '上下文提炼',
        onKeyDown: onModalKeyDown,
        onCancel: (event) => { event.preventDefault(); closeRef.current() },
        onClick: (event) => {
          // showModal 下点遮罩的事件目标就是 dialog 本身。
          if (event && event.target === event.currentTarget) closeRef.current()
        },
      },
        h('div', { className: 'dcr-head' },
          h('div', null,
            h('h3', { className: 'dcr-title' }, '上下文提炼'),
            h('p', { className: 'dcr-sub' }, mode === 'max'
              ? '极致会丢掉旧记录、只留一份交接简报；重置后要完全退出并重新打开 DeepSeek Harness。'
              : '挑一个档位，确定后自动提交一条提炼指令；压缩完还在这个窗口继续聊。'),
          ),
          h('button', { type: 'button', className: 'dcr-close', 'aria-label': '关闭', onClick: props.onClose }, '×'),
        ),
        h('div', {
          className: 'dcr-modes',
          role: 'radiogroup',
          'aria-label': '提炼档位',
          onKeyDown: (event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); moveMode(1) }
            else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); moveMode(-1) }
            else if (event.key === 'Home') { event.preventDefault(); jumpMode(0) }
            else if (event.key === 'End') { event.preventDefault(); jumpMode(MODES.length - 1) }
          },
        },
          MODES.map((item, index) => h('button', {
            key: item.id,
            type: 'button',
            className: 'dcr-mode',
            role: 'radio',
            'aria-checked': mode === item.id ? 'true' : 'false',
            'data-active': mode === item.id ? '1' : '0',
            tabIndex: mode === item.id ? 0 : -1,
            ref: (node) => { radios.current[index] = node },
            onClick: (event) => {
              setMode(item.id)
              // Safari 点击按钮不给焦点，roving tabindex 会和实际焦点脱节。
              if (event && event.currentTarget && event.currentTarget.focus) event.currentTarget.focus()
            },
          },
            h('span', { className: 'dcr-radio', 'aria-hidden': 'true' }),
            h('span', { style: { flex: 1, minWidth: 0 } },
              h('b', null, item.name),
              h('em', null, item.desc),
              h('span', { className: 'dcr-keep' }, item.keep),
            ),
          )),
        ),
        mode === 'max'
          ? h('p', { className: 'dcr-note' }, '极致会把这个会话的旧记录整个换掉（备份留在旁边），不需要再花模型调用。')
          : null,
        h('details', { className: 'dcr-details' },
          h('summary', null, '看看会发什么'),
          h('pre', { className: 'dcr-pre' }, mode === 'max' ? RESET_PREVIEW : instructionFor(mode, false)),
        ),
        mode === 'max' && preview && !props.result
          ? h('div', { className: 'dcr-pre', role: 'status' },
              '旧记录 ' + formatBytes(preview.bytesBefore) + ' → 新记录约 ' + formatBytes(preview.bytesAfter)
              + '；真实用户消息 ' + preview.messagesBefore + ' 条；简报 ' + preview.briefChars + ' 字\n\n'
              + String(preview.brief || '').slice(0, 4000)
              + (String(preview.brief || '').length > 4000 ? '\n…（这里只显示前 4000 字，真正写进去的是完整版）' : '')
              + '\n\n确认后：旧记录改名备份，这个会话只保留上面这份简报和一个回合。',
            )
          : null,
        previewError ? h('div', { className: 'dcr-err', role: 'alert' }, previewError) : null,
        props.result
          ? h('div', { className: 'dcr-pre', role: 'status' },
              '已重置：' + formatBytes(props.result.bytesBefore) + ' → ' + formatBytes(props.result.bytesAfter) + '\n'
              + '备份：' + props.result.backup + '\n'
              + 'billion-context 账本：' + ((props.result.ledgers || []).filter((x) => x.moved).length) + ' 个挪走'
              + (((props.result.ledgers || []).length !== (props.result.ledgers || []).filter((x) => x.moved).length) ? '，' + ((props.result.ledgers || []).length - (props.result.ledgers || []).filter((x) => x.moved).length) + ' 个失败' : '') + '\n'
              + '投影缓存：' + props.result.projcache + '\n'
              + (props.result.notes && props.result.notes.length ? '提示：' + props.result.notes.join('；') + '\n' : '')
              + (props.result.warnings && props.result.warnings.length ? '有 ' + props.result.warnings.length + ' 个收尾步骤没成功（日志已重置）：' + props.result.warnings.join('；') + '\n' : '')
              + '\n'
              + '下一步：完全退出 DeepSeek Harness，再重新打开它。只按 F5 / 刷新页面不够——宿主进程里还记着旧记录，继续发消息会把记录写坏。',
            )
          : h('div', { className: 'dcr-note' }, mode === 'max'
            ? '不花模型调用；先干跑给你看真实简报，确认后才写盘。旧记录会改名备份在日志旁边，重置后要完全退出并重开 DeepSeek Harness。'
            : '会花 1 轮模型调用；原文不会被删，之后仍能找回，但找回会重新占满上下文。'),
        props.note ? h('div', { className: 'dcr-err', role: 'alert' }, props.note) : null,
        props.locked
          // 重置完这个窗口里的会话游标还是旧的，再发消息会写坏记录：这里不给「开始提炼」，
          // 只留一条明说风险的退路（重新加载页面不算数，必须退出宿主进程）。
          ? h('div', { className: 'dcr-locked', role: 'alert' },
              h('p', null, '这个会话已经重置。请完全退出 DeepSeek Harness 再重新打开（只刷新页面不够：宿主进程还记着旧记录，继续发消息会把记录写坏）。'),
              h('div', { className: 'dcr-actions' },
                h('button', { type: 'button', className: 'dcr-ghost', onClick: props.onUnlock }, '我知道风险，先用这个窗口'),
              ),
            )
          : h('div', { className: 'dcr-actions' },
              h('button', { type: 'button', className: 'dcr-ghost', onClick: props.onClose }, '取消'),
              h('button', { type: 'button', className: 'dcr-primary', disabled: props.busy || previewing, onClick: confirm },
                props.busy
                  ? (mode === 'max' ? '重置中…' : '提交中…')
                  : mode === 'max'
                    ? (preview ? '确认重置并丢弃旧记录' : (previewing ? '正在生成简报…' : '先看交接简报'))
                    : '开始提炼'),
            ),
      )
    }

    // ------------------------------------------------------------ 浮层（根插槽）
    function OverlayEntry() {
      const [, setTick] = useState(0)
      useEffect(() => dialog.subscribe(() => setTick((n) => n + 1)), [])
      const state = dialog.state
      if (!state.open) return null
      const requestClose = () => {
        // 提交已经开始了，关闭会让人以为取消了；这里直接不让关。
        if (dialog.state.busy) return
        // 刚重置完这个会话：关掉弹窗就能继续发消息，会按旧游标写坏记录，所以锁住。
        if (dialog.state.lockedSession && dialog.state.lockedSession === dialog.state.dialogSession) return
        dialog.close()
      }
      const go = (mode) => {
        if (dialog.state.busy) return
        dialog.update({ busy: true, note: '', result: null })
        const failure = state.ctrl && typeof state.ctrl.run === 'function'
          ? state.ctrl.run(mode)
          : '这个窗口拿不到输入框状态，先把指令复制出来手动发。'
        if (failure) dialog.update({ busy: false, note: failure })
      }
      // 极致：异步调宿主接口。epoch 变了说明弹窗已关/已重开，旧结果不能再写进去。
      const goPreview = () => {
        if (dialog.state.busy) return Promise.resolve({ ok: false, error: '上一件事还没结束，等它一下。' })
        return state.ctrl && typeof state.ctrl.preview === 'function'
          ? state.ctrl.preview()
          : Promise.resolve({ ok: false, error: '这个窗口拿不到宿主接口，刷新一次页面再试' })
      }
      const goReset = () => {
        if (dialog.state.busy) return
        const epoch = state.epoch
        dialog.update({ busy: true, note: '', result: null })
        const task = state.ctrl && typeof state.ctrl.reset === 'function'
          ? state.ctrl.reset()
          : Promise.reject(new Error('这个窗口拿不到宿主接口，刷新一次页面再试'))
        Promise.resolve(task).then((out) => {
          if (dialog.state.epoch !== epoch) return
          if (out && out.ok) dialog.update({ busy: false, result: out, lockedSession: out.sessionId || '', dialogSession: out.sessionId || '' })
          else dialog.update({ busy: false, note: (out && out.error) || '重置没有成功，原因不明。' })
        }, (error) => {
          if (dialog.state.epoch !== epoch) return
          dialog.update({ busy: false, note: '重置失败：' + (error && error.message ? error.message : String(error)) })
        })
      }
      // key=epoch：每次打开都是新实例，错误边界失败后重开即可恢复，不会永久空白。
      return h(Guard, { key: 'dialog-' + state.epoch },
        h(RefineDialog, { busy: state.busy, note: state.note, result: state.result, locked: !!(state.lockedSession && state.lockedSession === state.dialogSession), onUnlock: () => dialog.update({ lockedSession: '' }), onClose: requestClose, onSubmit: go, onPreview: goPreview, onReset: goReset }),
      )
    }

    // ------------------------------------------------------------ 入口按钮
    const NOOP_HOOK = () => undefined
    const EMPTY_ATTACHMENTS = []
    const selectDraft = (state) => (state ? state.draft : '')
    const selectPhase = (state) => (state ? state.phase : 'plain')
    const selectAttachments = (state) => (state && Array.isArray(state.attachmentIds) ? state.attachmentIds : EMPTY_ATTACHMENTS)

    function RefinerDock(props) {
      const sessionId = props ? props.sessionId : ''
      const actions = props ? props.inputActions : null
      const useInput = (props && props.useInput) || NOOP_HOOK
      const draft = useInput(selectDraft) || ''
      const phase = useInput(selectPhase) || 'plain'
      const attachments = useInput(selectAttachments) || EMPTY_ATTACHMENTS
      const [pending, setPending] = useState('')
      const [, setDialogTick] = useState(0)
      const draftRef = useRef(draft)
      const savedRef = useRef('')
      const savedAtRef = useRef(0)
      const pendingRef = useRef('')
      const epochRef = useRef(-1)
      const mineRef = useRef(null)
      const submitRef = useRef(null)
      const resetRef = useRef(null)
      const previewRef = useRef(null)

      // ref 只在提交/校验/恢复回调里读，渲染里不写。
      useEffect(() => { draftRef.current = draft }, [draft])

      useEffect(() => () => {
        if (mineRef.current && dialog.state.ctrl === mineRef.current) dialog.close()
      }, [])

      // 弹窗被关掉（取消/提交成功/换会话）时，这一轮的校验状态一起作废，
      // 否则旧定时器会去改下一次打开的弹窗。
      useEffect(() => dialog.subscribe(() => {
        // lockedSession 变化要立刻反映到按钮的 disabled 上，所以整体重渲染一次。
        setDialogTick((n) => n + 1)
        if (!dialog.state.open && pendingRef.current) {
          setPending('')
          pendingRef.current = ''
        }
      }), [])

      const submit = useCallback((mode) => {
        if (!actions || typeof actions.setDraft !== 'function' || typeof actions.submit !== 'function') {
          return '这个版本拿不到输入框接口，没法自动提交；可以先复制「看看会发什么」里的指令手动发。'
        }
        if (phase !== 'plain') return '这一轮还在跑，等它结束再点。'
        if (attachments && attachments.length) {
          return '输入框里还有 ' + attachments.length + ' 个附件。先发掉或删掉它们再提炼，不然附件会跟着这条指令一起发出去。'
        }
        const text = instructionFor(mode, false)
        const current = String(draftRef.current || '')
        // 只保存「用户自己的草稿」：上一次没发出去时输入框里留着的是指令，
        // 不能拿它覆盖原草稿（否则原草稿就永久丢了）。
        if (current.trim() && current.trim() !== String(pendingRef.current || '').trim()) {
          savedRef.current = current
          savedAtRef.current = Date.now()
        }
        epochRef.current = dialog.state.epoch
        pendingRef.current = text
        try {
          actions.setDraft(text)
          actions.submit()
        } catch (error) {
          pendingRef.current = ''
          const saved = savedRef.current
          savedRef.current = ''
          if (saved.trim()) try { actions.setDraft(saved) } catch (restoreError) { /* 连草稿都恢复不了就保持原样 */ }
          return '提交失败：' + (error && error.message ? error.message : String(error))
        }
        setPending(text)
        return ''
      }, [actions, phase, attachments])

      useEffect(() => { submitRef.current = submit }, [submit])

      // 极致档：本地算不了，交给宿主的 /dsh-context-refiner/reset。
      // 两道前置检查与普通档一致：这一轮没在跑、输入框里没附件。
      const resetViaHost = useCallback(async (dryRun = false) => {
        if (phase !== 'plain') return { ok: false, error: '这一轮还在跑，等它结束再重置。' }
        if (attachments && attachments.length) return { ok: false, error: '输入框里还有 ' + attachments.length + ' 个附件，先处理掉再重置。' }
        const guard = { 'x-dsh-context-refiner': '1' }
        let info = null
        try {
          const stateRes = await fetch('/dsh-context-refiner/state?sessionId=' + encodeURIComponent(sessionId), { headers: guard, credentials: 'same-origin', signal: AbortSignal.timeout(6000) })
          info = await stateRes.json().catch(() => null)
          if (!stateRes.ok || !info || !info.ok) return { ok: false, error: '宿主没有回应：' + ((info && info.error) || ('HTTP ' + stateRes.status)) }
          if (!info.log || !info.log.found) return { ok: false, error: '没找到这个会话的日志文件（' + (info.home || 'home') + '）。极致重置要重写那份记录，没有它做不了。' }
          if (info.log.damaged) return { ok: false, error: '这个会话的日志已经坏了（第 ' + (info.log.gapAt == null ? '?' : info.log.gapAt) + ' 条 seq 断了，宿主会说 not dense）。先别重置：把日志旁边的 .bak-refiner-* 备份去掉时间戳改回原名，恢复好再试。' }
        } catch (error) {
          return { ok: false, error: '连不上宿主接口（' + (error && error.message ? error.message : String(error)) + '），重启一次 DeepSeek Harness 再试。' }
        }
        try {
          const res = await fetch('/dsh-context-refiner/reset', {
            method: 'POST',
            credentials: 'same-origin',
            headers: Object.assign({}, guard, { 'content-type': 'application/json', 'x-dsh-context-refiner-token': info.token }),
            body: JSON.stringify(Object.assign({ sessionId, confirm: 'reset' }, dryRun ? { dryRun: true } : {})),
            // 重写几 MB 日志 + 1.2 秒观察窗，给足时间；超时不会重试，只报错。
            signal: AbortSignal.timeout(30000),
          })
          const out = await res.json().catch(() => null)
          if (!res.ok || !out || !out.ok) return { ok: false, error: (out && out.error) || ('重置失败，HTTP ' + res.status) }
          return out
        } catch (error) {
          return { ok: false, error: '重置请求失败：' + (error && error.message ? error.message : String(error)) }
        }
      }, [sessionId, phase, attachments])

      useEffect(() => { resetRef.current = resetViaHost }, [resetViaHost])
      useEffect(() => { previewRef.current = () => resetViaHost(true) }, [resetViaHost])

      // 提交后校验：只认「这一轮真的开始跑」（phase 离开 plain）。
      // 3 秒没动静就说明被拦住了；弹窗留着，草稿保留，让用户手动兜底。
      useEffect(() => {
        if (!pending) return
        const epoch = epochRef.current
        if (!dialog.state.open || dialog.state.epoch !== epoch) {
          setPending('')
          pendingRef.current = ''
          return
        }
        if (phase !== 'plain') {
          setPending('')
          pendingRef.current = ''
          if (dialog.state.epoch === epoch) dialog.update({ open: false, busy: false, note: '', ctrl: null, result: null })
          return
        }
        const timer = setTimeout(() => {
          if (dialog.state.epoch !== epoch) return
          setPending('')
          pendingRef.current = ''
          dialog.update({ busy: false, note: '没看到这一轮开始跑：输入框里还是那条指令。如果界面上出现「本轮运行失败」或 payload 过大的报错，说明上下文已经超过模型窗口，这一轮根本没发出去——先把模型换成窗口更大的，或者开新窗口用记忆接着聊；否则再点一次「开始提炼」，或复制指令手动发。' })
        }, 3000)
        return () => clearTimeout(timer)
      }, [pending, phase])

      // 草稿恢复：不在提交成功的那一刻抢着写回去。
      // 宿主是在消息真正结算后才清空输入框的（排队/慢网可能 >900ms），
      // 所以等「输入框空了 + 这一轮已经不是 plain」时再恢复，最多等 60 秒。
      useEffect(() => {
        if (!savedRef.current) return
        if (phase !== 'plain') return
        if (String(draft || '').trim() !== '') return
        if (Date.now() - savedAtRef.current > 60000) {
          savedRef.current = ''
          return
        }
        const saved = savedRef.current
        savedRef.current = ''
        pendingRef.current = ''
        try {
          if (actions && typeof actions.setDraft === 'function') actions.setDraft(saved)
        } catch (error) { /* 草稿恢复失败不影响提炼 */ }
      }, [draft, phase, actions])

      useEffect(() => {
        mineRef.current = {
          run: (mode) => (submitRef.current ? submitRef.current(mode) : '还没准备好，再点一次。'),
          preview: () => (previewRef.current ? previewRef.current() : Promise.reject(new Error('还没准备好，再点一次。'))),
          reset: () => (resetRef.current ? resetRef.current(false) : Promise.reject(new Error('还没准备好，再点一次。'))),
        }
      }, [])

      if (!sessionId) return null

      const openDialog = () => {
        if (!mineRef.current) {
          mineRef.current = {
            run: (mode) => (submitRef.current ? submitRef.current(mode) : '还没准备好，再点一次。'),
            preview: () => (previewRef.current ? previewRef.current() : Promise.reject(new Error('还没准备好，再点一次。'))),
            reset: () => (resetRef.current ? resetRef.current(false) : Promise.reject(new Error('还没准备好，再点一次。'))),
          }
        }
        dialog.open(mineRef.current, sessionId)
      }

      const busyNow = phase !== 'plain'
      const hasAttachments = !!(attachments && attachments.length)
      const locked = dialog.state.lockedSession === sessionId
      return h('div', { className: 'dcr-root', 'data-refiner': '1' },
        h('button', {
          type: 'button',
          className: 'dcr-btn',
          disabled: busyNow || locked,
          'aria-busy': busyNow ? 'true' : 'false',
          title: locked
            ? '这个会话刚重置过：关掉窗口重开后再提炼，别在这个窗口里继续聊'
            : busyNow
              ? '这一轮还在跑，等它结束再提炼'
              : hasAttachments
                ? '输入框里有附件：先处理掉附件再提炼'
                : '把前面的对话压缩提炼，然后在同一个窗口继续聊',
          onClick: openDialog,
        },
          h('span', null, '提炼'),
          busyNow ? h('span', { className: 'dcr-dot', role: 'status', 'aria-label': '这一轮还在跑' }) : null,
          hasAttachments ? h('span', { className: 'dcr-dot', role: 'status', 'aria-label': '输入框里有附件' }) : null,
          locked ? h('span', { className: 'dcr-dot', role: 'status', 'aria-label': '会话已重置，需要重开窗口' }) : null,
        ),
      )
    }

    // 组件内出错时不要把整个输入框带崩；出错打日志，换会话自动重试。
    class Guard extends React.Component {
      constructor(p) { super(p); this.state = { failed: false } }
      static getDerivedStateFromError() { return { failed: true } }
      componentDidCatch(error) { console.error('[context-refiner]', error) }
      render() { return this.state.failed ? null : this.props.children }
    }

    // ------------------------------------------------------------ 注册
    return {
      name: 'dsh-context-refiner',
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ensureStyle())

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'context-refiner',
          order: 32,
        }, (props) => h(Guard, { key: props ? props.sessionId : 'none' }, h(RefinerDock, props))))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'context-refiner-dialog',
          order: 41,
        }, () => h(Guard, { key: 'overlay-root' }, h(OverlayEntry))))
      },
    }
  },
})
