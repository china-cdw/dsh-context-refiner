# dsh-context-refiner

给 [billion-context](https://github.com/ranxianglei/billion-context) 配的输入框按钮：**上下文快满时不用开新窗口**，点一下把前面的对话压缩提炼，然后接着聊。

压缩摘要必须由模型写（只有 billion-context 的 `compress` 能做），所以「轻度 / 标准 / 深度」三档是**替你把指令发出去**；
「极致」档不一样：**离线重置，不花模型调用**——宿主直接把会话日志换成一回合的交接简报。

## 四档

| 档位 | 怎么压 | 保留什么 |
| --- | --- | --- |
| 轻度 | 让模型压最早、工具输出最密的少量区间 | 最近 20 条 + 用户的要求与结论 |
| 标准 | 按主题提炼，日常用这个 | 最近 8 轮 + 结论/决策/路径/数字 |
| 深度 | 只留结论清单 | 最近 3 轮 + 长期约束/未完成目标 |
| 极致 | **离线重置**：丢弃全部旧记录，重写成「header + 权限设置 + 一回合简报」 | 交接简报（在做什么/要求/偏好/结论/进展/路径/下一步），旧日志留备份 |

三档模型压缩会花 1 轮调用；极致不花。

## 怎么用

1. 点输入框下方的「提炼」（在记忆徽标右边）。
2. 选档位，点「开始提炼」。
3. 三档：指令会塞进输入框并替你回车；输入框里还有附件时会拒发（不然附件会跟着指令发出去）；
   你原来的草稿会在宿主真正把指令发出去、输入框清空之后才放回去。3 秒内没看到这一轮开跑会提示你手动兜底。
4. 极致分两步：
   - 第一步点「先看交接简报」：只读，不写盘；弹窗显示「旧记录多大 → 新记录约多大 / 真实用户消息几条 / 简报多少字」和简报前 4000 字；
   - 看完点「确认重置并丢弃旧记录」才真写。
   成功后会锁住弹窗并禁用「提炼」按钮，只留一条「我知道风险，先用这个窗口」的退路。

**重置后必须完全退出 DeepSeek Harness，再重新打开它**（不是只按 F5，也不是只关这个标签页）。
原因：宿主进程内存里还留着这个会话的 seq 游标和文件句柄，只重载页面的话，新写的消息会按旧游标追加，
造出 `seq gap`，会话就打不开了。锁定和解锁按钮只能挡住同一个页面，挡不住后台回合和另一个窗口。

## 宿主接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/dsh-context-refiner/state?sessionId=…` | 日志多大、在不在、seq 是否连续、写令牌、bili 报的占用 |
| POST | `/dsh-context-refiner/reset` | 真重置（body 必须带 `confirm: "reset"`；`dryRun: true` 只出简报） |

鉴权：只接受回环 Host、同源 Origin、`x-dsh-context-refiner: 1` 请求头；写接口再校验
`x-dsh-context-refiner-token`（令牌在 `<home>/context-refiner/.token`）。校验类错误返回 400，
同一会话并发重置返回 409。

重置做了什么（`host/reset.js`）：

1. 在 `<home>/sessions/*/<sessionId>/` 里找 `session.v4.jsonl.zstd`（明文 `.jsonl` 也支持），
   按 zstd 帧或明文解码；`session-` 前缀和裸 UUID 两种会话 id 都认，且必须和文件里的 `header.id` 对上；
2. 拒绝：seed/分叉会话、日志后缀与内容格式对不上、**seq 不连续（已经被写坏的日志）**、没有任何真实用户消息；
3. 只取 `source.kind === "user"` 的消息生成七节简报（注入的 runtime-context 不入简报，上一次的交接简报也不会被
   当成用户要求再提炼一遍）；
4. 写临时文件 → fsync → 自检（seq 从 0 连续、第一帧只有一行 header、`user/message` 带 `surfaceOp`、
   第一个 surface 事件是 `system/message`）→
   把原文件复制成 `*.bak-refiner-<时间戳>` 并核对字节数 → 原子 rename 覆盖；
   中途失败只删临时文件，原日志不动；
5. 交换后观察 1.2 秒，如果文件又变长了，说明有人在写，改名为 `.drift-refiner-*` 并还原备份，报告失败；
6. 顺手把 `session_projcache` 的投影缓存和 billion-context 里含这个会话名的账本文件改名挪走（都留备份）。

**宿主校验很严，四条硬约束**（都踩过）：第一帧必须恰好只有一行 header；`seq` 必须从 0 连续；
`user/message` 必须带 `surfaceOp: "append"`；**第一个 surface 事件必须是 `system/message`**
（宿主叫它「受保护的第一个 surface 头」，从原日志里原样复制，不自己编）。前两条少一个会话直接打不开；
第四条更阴——日志当场能打开，等宿主下一次追加系统提示才报
`system/message requires a protected first surface head`，整份日志被判损坏。

因为要原样保留系统提示，重置后的日志不是只有几 KB，而是大约「系统提示大小 + 简报」（常见 30–100 KB），
仍比原来几 MB 小两个数量级。

## 出事了怎么还原

原日志在 `*.bak-refiner-<时间戳>`。把当前主日志改名或删掉，再把备份改回原名即可：

```
session.v4.jsonl.zstd.bak-refiner-2026-11-16T...  →  session.v4.jsonl.zstd
```

如果主日志已经不见了，重置会直接报错并告诉你备份文件名（不会当成「会话不存在」）。

## 装配

`package.json` 声明 `dsh.bundle.patch` 与 `dsh.client`。浏览器侧注册两个插槽：

- `conversation.composer.dock`（order 32）：输入框下面的「提炼」按钮；
- `shell.overlay`（order 41）：弹窗（挂在根上避开 composer 的 transform/overflow 裁剪）。

**改宿主代码（index.js / host/）后需要重启一次 DSH**；只改 `client.js` 刷新页面即可。

## 测试

```bash
node scripts/test.mjs        # 迷你 React：四档文案、两步预览、草稿恢复/附件/弹窗归属、锁定态
node scripts/test-host.mjs   # 真会话副本：帧切分/备份 sha256/seq 洞拒绝/并发/明文/seed 拒绝/简报
node scripts/test-routes.mjs # HTTP 层：鉴权/干跑/真跑/备份/坏 ID(400)/dispose
```

`test-host.mjs` 会自动在 `$DSH_HOME/sessions` 里挑一个 20KB–3MB 的 v4 会话当素材，也可以用
`REFINER_SESSION_DIR=<会话目录>` 指定。所有测试都在临时 home 里跑，不碰真实会话，退出时清理临时目录。

## 限制

- 三档依赖 profile 装了 billion-context；极致不依赖（纯本地改日志）。
- 会话正在跑时按钮禁用，等这一轮结束。
- 上下文已经超过模型窗口时，三档会直接报「payload 过大」——那一轮连发都没发出去，只有极致能救。
- 极致是破坏性的：会话内只剩简报，细节只在备份文件里。
- 没有系统提示的日志（还没跑过一整步的会话）会被拒绝重置——硬写出来，宿主下次追加系统提示时同样会判损坏。
- bili 的索引库 `index.db` 和 `~/.local/state/billion-context/` 没有动，只挪了按会话名命名的账本文件；
  报告里会把这条写进 notes，别把「挪走几个文件」当成旧上下文已经彻底清空。

## 许可证

AGPL-3.0-or-later（完整原文见 [LICENSE](LICENSE)），另提供商业授权：需要闭源分发的，
来信说明用途即可，不必换掉插件本身。第三方与上游声明见 [NOTICE](NOTICE)。
