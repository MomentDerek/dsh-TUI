# 独立宿主（方案 B）设计

[文档索引](README.md) · [架构与限制](architecture.md) · [多后端架构](agent-backend-design.md)

状态：Phase 0、Phase 1 完成；Phase 2 主体（2.0–2.7）完成，根模型**已裁定为单根（D1）**并落地
（原型分支 `feat/standalone-host`）。**5.7 的轻量 profile
已落地（2026-10-09）**：形状取「往入口那个裸根里按清单装配」，**Claude 内核**下第三方插件
三样例（主题、面板、`tui/input` 拦截）与 `/settings` 的 `dsh-tui` 分节**已有验收用例并通过**；
Codex 内核走同一条入口组合路径，但**未验收**（新增用例只跑 Claude，见 5.7 末条遗留）。剩余是组合成本与上游插件契约归属。基于 `main`（ec48de22）与
`@deepseek-ai/dsh` 0.2.0-rc.2 的代码阅读。2026-10-06 修订分期：Phase 1 只做「DSH 无关」，
TuiHost 推迟到 Phase 2（见 5.1、第 7 节）。

**2026-10-09 维护者裁定三项**（详见第 10 节）：

1. **定位**：改写成「拥有入口的终端应用」；**DSH 仍是首要适配目标与首方后端**，只因 DSH 自身的
   启动成本（1.2）而以独立后端形态存在。
2. **插件扩展**：Claude 内核下第三方 Cordis 插件扩展的缺失**不可接受**；轻量 profile 由「可选」
   转为 Claude 内核路径的必备件，纳入 Phase 2（5.7、6.2、第 7 节）。
3. **预载**：PR #1216 关闭、分支作废（第 8 节）。它要换来的快速启动已由 Phase 1/2 的入口路径覆盖，
   那三个文件从未进 `main`——Phase 3 因此没有 `main` 上的代码可删，只剩分支清理。

**2026-10-09 追加裁定四项**（详见第 10 节）：

1. **根模型 D1「单根」**（第 10 节第 3 条）：实际落地已是单根（入口自建运行时，DSH 内核也走本包
   入口）。第 10 节第 3 条的 D1 / D2 并列**作废**，D2 不再是备选。
2. **`dsh --profile dsh-tui` 直启路径保留**（第 10 节第 4 条）：继续支持；「没有 TuiHost 时自建并
   渲染」的兼容路径**实现待补**（不是已完成）。
3. **观感两项**：DSH home 的两步切换（接管后 1–2s 才弹）**已判定需改，证据待补**（仍在测量
   归因）；Claude 占位期那句 `Starting …` **保留**（不删）。
4. **预载分支清理已授权**：先摘 worktree 备份成 patch，再从分支清单验收删；远端分支删除需单独
   授权，尚未执行（第 7 节 Phase 3）。

**下一步（可直接接手）**：Phase 2 的剩余项——轻量 profile 的组合成本计入 Claude 内核首帧基线
（5.7 末条），以及与上游插件契约对齐注册表归属（上游 issue #1247）。5.7 的实现形状与接线
**已落地（2026-10-09）**，见 5.7；收口的验收边界为
**Claude 已验收、Codex 未验**，另有两条遗留（`/theme` 交互路径、`trimmed=false` 的继续组合）
见 5.7 末条。
上游 #1380 的后端注册表**已吸收**（`main` `bc890963` 进本分支）。

## 一句话

dsh-TUI 从「DSH 的一个 Cordis 插件」变成「自己拥有入口与组装根的终端应用」：先挂界面与
后端中立的 channel 核心，再把后端打开。**DSH 仍是首要适配目标与首方后端**——`native.dsh`
与 DSH specialist 能力保持首方特权不变（第 10 节第 9 条）——但它不再是把 TUI 装进去的那层
宿主：它像 claude / codex 一样作为后端之一按需在进程内加载，原因是 DSH 自身的启动成本
（1.2）。Claude 内核不组合 dsh-base；它仍组合一个只装本包行与第三方插件的轻量 profile，
第三方插件扩展在两个内核下都保持可用（5.7）。

**整个方案只有一道门闩：channel 核心能在没有 Cordis `ctx` 的情况下构造。**Phase 0
做的就是这件事；它做不下来，方案 B 就停在 Phase 0，不影响现状。

## 1. 背景

### 1.1 旧启动链（Phase 0 之前；1.2–1.4 讨论的就是这条链）

```text
dsh-tui（全局启动器）
  └─ spawn node <profile 内的 bin/dsh-tui.js>        （profile 启动器：对齐、安全模式重试）
       └─ spawn dsh --profile dsh-tui -- <app args>    （DSH 宿主进程）
            runProfile → composeProfile → boot(~94 行 dsh-base + 本包 20 行)
              └─ dsh-tui 行 apply → plugin.ts
                   选内核 → 打开后端 → createChannel(ctx, …) → render(Chat)
```

界面在「整个 profile 组合完、dsh-tui 行跑到 apply、后端打开」之后才出现。预载分支
（PR #1216，`dst`）用 `--import` 在 dsh 加载前先画一棵树，再在 apply 里原地换上 live
channel，把首帧从约 2 秒提前到约 0.6–0.7 秒。

**现状（Phase 1/2 之后，单根）**：profile 启动器默认 spawn `node <本包
lib/types/dsh-adapter/host-entry.js>`（`bin/dsh-tui.js` 的分流；`DSH_TUI_HOST_ENTRY=0` 把全部
内核、`DSH_TUI_HOST_ENTRY_DSH=0` 把 DSH 内核退回上面的 `dsh --profile`）。入口用已装 `dsh` 的
模块（realpath）建 Cordis 根（5.4），先挂本包运行时并渲染——**首帧不再等任何后端**；Claude /
Codex 内核到此为止，DSH 内核再把 profile 组合进**同一个根**（第 3 节）。`dsh --profile dsh-tui`
直启路径仍在（第 10 节第 4 条）：没有入口槽时，`dsh-tui` 行照常自己渲染（`entry-slot.ts` 头注释）。

### 1.2 预载方案的结构性成本

预载方案能工作，但它是在「TUI 是插件」这个前提下的补丁：

- **镜像维护税。**启动态 channel（`src/preboot/bootChannel.ts`）按 `ChannelUi` 端口
  逐项手写；设置、落地页、内核、品牌的判定在 preload 里各算一遍，与 plugin 保持一致。
  PR #1216 在 main 走了一周后 rebase，需要补 22 个端口、4 个 Schema 字段、一处 kernel
  切换交接冲突（详见 PR 记录）。main 的改动越快，这笔税越高。
- **Claude 内核白等 dsh-base。**Claude 后端（`src/backends/claude/`）不依赖 Cordis，但进程
  仍要先组合完**整份** DSH profile（约 1–2 秒、约 750 个模块，其中主体是 dsh-base），才轮到
  它启动 CLI。轻量 profile（5.7）省下的是 dsh-base 那一段：Cordis 与本包的行仍要组合，
  所以收益是「少组合」而不是「不组合 Cordis」，能省多少由 Phase 2 实测。
- **交接是两套状态机的对接。**启动态 channel 与真实 channel 是两个对象，靠
  `deferred.ts` 迁移监听；任何一方新增行为都要在另一方补中性值。

### 1.3 已有的有利条件

多后端重构（#1312、#1313、#1322、#1323）已经把一半路走完：

- `src/agent/` 与 `src/backends/claude/` 不 import Cordis。
- channel 核心后端中立，DSH 专属部分只在会话带 `native.dsh` 时由
  `channel/extensions.ts` 挂载。
- `core/host.ts` 的 `CoreHost` 已经把 `tui*` 接缝从 `ctx` 后面抽了出来。
- 会话绑定（`channel/binding.ts`）与「后端开会话后接管」的尾段
  （`core/session-switch.ts` 的 `adoptWith`）都已后端中立。
- 所有 `tui*` 服务都由**本包自己**的行提供（`dsh-tui-extensions`、`dsh-tui-panels`、
  `dsh-tui-plugin-host` 等），DSH 核心一个都不提供。
- DSH 有稳定的嵌入入口：`@deepseek-ai/dsh/profile-boot` 导出 `runProfile`，
  `RunProfileOptions.resolvedProfile` 明确支持「应用自有 profile」。

### 1.4 方案 B 不是「入口互换」

「我们的入口先画、再调 `runProfile`、`dsh-tui` 行经 globalThis slot 接管」看起来像
方案 B，实质仍是预载：channel 核心还是在行的 apply 里建，启动态 channel 的手写镜像一个
都不少，Claude 内核照样跑完 `runProfile`。它只换了谁是入口，不解决 1.2 的任何一条。
本文的方案 B 指 channel 核心离开 Cordis。

## 2. 目标与非目标

目标：

- 首帧不依赖任何后端：界面在进程启动后立即以**真实** channel 核心挂载。
- Claude 内核启动时不加载 dsh-base（DSH 的核心行）；它仍组合一个轻量 profile 承载第三方
  插件（5.7）。
- 启动期没有第二套 channel：「启动中」是一个尚未就绪的会话，就绪时走 channel 现有的
  接管路径。
- 第三方 Cordis 插件现有的 `tui*` 扩展能力**在两个内核下都保持可用**（2026-10-09 裁定：
  Claude 内核下的缺失不可接受，见 5.7）。

非目标：

- 不改 DSH 核心；只使用其公开导出。
- 不做进程隔离（worker / 子进程 + IPC），见 6.1。
- 不改变 transcript 真源规则：仍以后端持久化记录为准。

## 3. 目标架构

Phase 2 落地后的**单根**形态（D1 已裁定，见 2.2 / 2.3）：

```text
bin/dsh-tui.js（启动器：对齐、安全模式、Windows 解析——保留）
  └─ spawn node <本包 lib/types/dsh-adapter/host-entry.js> <args>
       入口（host-entry.ts → host-dsh.ts）：用已装 dsh 的模块（realpath）建 Cordis 根
         ├─ 模块解析先于任何 TUI 模块加载（宿主那份 react 与 @deepseek-ai/*）
         └─ 本包运行时（plugin.ts 的 apply）挂在这个根上，deferBackendOpen
              └─ createCoreChannel(cordisChannelHost(ctx), pendingSession, …) ──► render(Chat)
                                                                                  ← 首帧在这里
       内核判定（hostEntryRoute.entryRoute）：
         ├─ claude / codex：到这里为止。不组合 profile，运行时自己解析内核并打开后端
         │     └─ channel.adoptStartup(session)                          可发送
         └─ dsh：把 dsh-tui profile 组合进**同一个根**
               └─ dsh-tui 行经 entry-slot 的 globalThis 槽发现已挂载的界面：**不画第二棵树**
                    ├─ resolveAgent → createDshSession
                    ├─ channel.adoptStartup(dshSession，挂 DSH 扩展——晚挂 D1)
                    └─ 失败 / 无 dsh-tui 行 → 槽的 composeFailed / composeWarning
```

单根下没有独立的 TuiHost 对象，也没有桥接行：宿主就是那个 Cordis 根，`tui*` 服务与 DSH 服务
住在同一棵树上，界面与第三方插件看到同一个根（5.1）。Phase 1 的入口是同一形状的起点——自持
裸 Cordis 根、`plugin.ts` 的 `apply` 原样挂上；Phase 2 把这个根换成宿主的那份模块，并让 DSH
组合进来。

**仍未实现的缺口**：Claude / Codex 内核下，profile 里声明的第三方插件不进这个根——这是
2026-10-09 裁定要补的缺口（5.7）：轻量 profile 把本包的行与第三方插件组合进来；它是往同一个根
里装、还是另建一根再桥接，形状 spike 进行中。

依赖方向（终态）：界面 → ports；channel 核心 → agent + ports + **`ChannelHost` 接口**；Cordis 只
出现在 `src/dsh-adapter/`（DSH 后端与宿主复制）。

## 4. 现状的 Cordis 依赖与归属

按「换掉它要做什么」归类（调研清单的摘要，行号以 main 为准）。

| 类别 | 依赖 | 现在的用处 | 方案 B 的归属 |
| --- | --- | --- | --- |
| 仅 DSH 会话 | `ctx.agents`、`agentDefaultModel`、`llm`、`agentPresets`、`approval`、`userQuestions`、`workspaceRegistry`、`sessionProjections`、`tools`、`commands`、`agent/pre-step` | `resolveAgent`、审批/问卷应答、工作区挂接、活动与上下文投影、DSH 扩展 | 全部进 DSH 后端（桥接行）。大部分今天已由 `backendStart === undefined`、`agent !== undefined`、`native.dsh` 守住 |
| 借 Cordis 的 TUI 基础设施 | `ctx.logger`（约 30 处）、`ctx.effect`、`ctx.root.fiber.dispose`、`ctx.cmdlineArgs`、`adapterRuntimeFor(ctx)` | 日志、资源清理、退出漏斗 | TuiHost 自有。`adapterRuntimeFor` 只把 ctx 当 WeakMap 键，换任意对象即可 |
| 借 Cordis 的 TUI 基础设施 | `shell`、`fs`、`attachments` | `!cmd`、git 分支、@ 提及、图片 | TuiHost 提供本地实现；现有代码已有 `fallbackFs` / `localImages` 等回退 |
| 借 Cordis 的 TUI 基础设施 | `settings`、`credentials`、`dshAuth` | `/settings` 读写、凭据、OAuth 呈现（Claude 的 `/login` 也借它） | 最难的一项，见 5.6；OAuth 呈现器移入 TuiHost |
| 插件生态接缝 | `tuiThemes`、`tuiPanels`、`tuiScenes`、`tuiDialogs`、`tuiStatus`、`tuiShortcuts`、`tuiToast`、`tuiRenderers`、`tuiCommandTrees`、`tuiWorkspaces`、`tuiSettingsSections`、`tuiPluginHost` 系列 | 第三方插件扩展界面 | 服务名不变；单根下它们就是那个 Cordis 根的服务，`ChannelHost.get` 每次操作实时取（晚挂的行经 `watchServices` 通知），不需要桥接行 |
| 插件生态接缝 | 决策事件（`tui/input`、`tui/session-switch`…）、`installDecisionGuard`、授权存储 | 第三方拦截输入与会话切换 | 归 `ChannelHost`（`dispatchDecision` / `dispatchNotification` / `installDecisionGuard`），单根下即同一个 Cordis 根；启动期输入本就不发送，不存在绕过窗口，见 5.7 |

channel 核心里还直接读 `ctx` 的位置（`CoreHost` 没盖住的）：`createComposerImages`、
`createCoreFiles`、`createInputDelivery`、`createSettingsHosts`、`dshAuth`、
`createBindingFeed`、`createSessionSwitch`、`createCoreLocalActions`、
`createGitBranchRefresher`、`ctx.effect`（均在 `core/compose.ts`）。这就是 Phase 0 的
工作面——**已完成**：`channel/core/` 不再 import 任何 `@deepseek-ai/*`（门禁规则见
`scripts/verify-adapter-boundary.ts` 的 `CORE_DIR`），这些位置都改经 `ChannelHost`。

## 5. 关键设计

### 5.1 ChannelHost：把 CoreHost 补全（单根下由 Cordis 根充当）

> 2026-10-09（本轮裁定）：根模型 **D1「单根」**正式成立（第 10 节第 3 条），D2 作废。TuiHost 与
> 桥接行都不建——宿主就是那个 Cordis 根。以下 2026-10-06 / 2026-10-07 两条是当时的分期修订与
> 两根方案记录；5.2 / 5.4 / 5.5 里「桥接行」「TuiHost」的措辞同属那份记录。

> 2026-10-07：根模型选定**单根**（TUI 的根即 DSH 根），TuiHost 与
> 桥接行不再必要；本节保留作两根方案的记录。

> 2026-10-06 修订：TuiHost 推迟到 **Phase 2**。Phase 1 spike 证明 `plugin.ts` 的 `apply` 在裸
> Cordis 根上零改动即可跑 Claude 内核，Phase 1 不需要「Cordis 无关」。TuiHost 真正必要的时刻
> 是 Phase 2：`runProfile` 的 `boot()` 会另建一个 Cordis 根，两根并存时第三方插件在 DSH 根里
> 看不到 TUI 根的服务，需要 TuiHost + 桥接行。下文按终态描述。

**实际落地（Phase 0）**：不新造抽象，扩展现有的 `CoreHost`（`core/host.ts` 的
`resolveCoreHost(host, owner)`）。宿主接口叫 `ChannelHost`
（`src/dsh-adapter/channel/channel-host.ts`），当前实现只有 `cordisChannelHost(ctx, services)`
（`channel/cordis-host.ts`）：单根下宿主就是那个 Cordis 根，没有第二个宿主对象。

```ts
interface ChannelHost extends ServiceLookup {            // get(name) 即原来的 ctx.get
  readonly logger: ChannelHostLogger
  readonly runtime: AdapterRuntimeOptions                // 现 adapterRuntimeFor(ctx)
  effect?(setup: () => () => void, label?: string): void  // 现 ctx.effect
  onAgentPreStep?(listener: AgentPreStepListener): () => void   // 仅 DSH
  dispatchDecision<T>(name, payload, normalize): Promise<T | undefined>
  dispatchNotification(name, payload): Promise<void>
  installDecisionGuard(grants: GrantStore): void
  markDecisionDispatchTopology(): () => void
  localSettingsSections(): TuiSettingsSectionsHost
  watchServices?(listener: (name: string) => void): () => void
}
```

- shell / fs / attachments / settings / credentials / dshAuth 与全部 `tui*` 注册表**都不是宿主
  对象的字段**，统一走 `get(name)` 查找：`cordisChannelHost` 把它接到根的服务上，没有该服务时
  返回 `undefined`，调用点各自降级。
- **边界门禁已落地**：`src/dsh-adapter/channel/core/` 不得 import 任何 `@deepseek-ai/*`，也不得
  依赖 extensions / backend（`scripts/verify-adapter-boundary.ts` 的 `CORE_DIR` 规则）。
- **注册表实时取已落地**：`resolveCoreHost` 的 `themeHost` / `workspaceService` / `commandTrees` /
  `sceneRuntime` / `settingsSectionsRuntime` / `rendererRuntime` 都是 getter，DSH 晚到时它带来的
  注册立刻可见；`startHostSubscriptions` 经 `watchServices` 在服务变动时重绑，授权存储每次操作重读
  （`core/host.ts`）。

### 5.2 启动时序

Claude 内核：

```text
entry ─► TuiHost 就位（读设置、主题、语言、内核判定）
      ─► createCoreChannel(host, pending)  ─► render(Chat)        首帧
      ─► openBackendStartup(host, claude)   （SDK、转录、CLI 握手）
      ─► channel.adoptStartup(session, history)                   可发送
```

DSH 内核：

```text
entry ─► 同上直到首帧
      ─► 解析宿主的 @deepseek-ai/dsh/profile-boot（取 PATH 上 dsh 的 realpath，同
         hostProfileConfig.ts 的做法），设置 DSH_TUI_* 环境变量
      ─► runProfile({ profile: 'dsh-tui', environment, patchFiles, args })
           └─ dsh-tui 桥接行 apply：取 TuiHost（globalThis 槽，同 preboot/handle.ts）
                ├─ 注册桥接服务
                ├─ resolveAgent → createDshSession
                └─ host.adoptStartup(dshSession, { attach: dshExtensions })
```

内核判定沿用 `resolveRememberedBackend`（handoff → 配置行 → `DSH_TUI_BACKEND` →
`kernel.json`）。配置行的 `backend` 在 Claude 内核下读不到 DSH Config 时，用
app-boot `composeEntries` 读（预载分支已验证，约 85ms），或随设置迁移一并解决（5.6）。

### 5.3 未就绪会话与启动接管

- **占位会话。**一个合法的最小 `AgentSession`：`status: 'starting'`、
  `capabilities: { native: {} }`、空 history；`submit` 不发出，交给 channel 缓冲。
  `AgentSessionStatus` 已有 `'starting'`。
- **启动接管（已实现，Phase 1）。**`ChannelLaunchOptions.startup` 传入仍在打开的会话
  （`Promise<{ session, history }>`），channel 在 `start()` 里自己接管：用 binding 的
  `prepare` + `adopt`（不是原计划的 `switchTo`——`prepare` 在打开返回时检查 capture，
  channel 已释放或已被 `/new` 换掉就直接关掉迟到的会话，正好覆盖「启动期退出」）。尾段
  不走 `adoptWith`：不清 `rows`/`pending`（启动期本地命令打印的行要留下），只重置投影、
  换身份、`cwd`（resume 的真实 cwd 打开后才知道）、能力快照、`subagentControl`、命令表，
  然后 `bind(history)`。**不复用** `newSession` / `resumeSession`：它们在 `working` 时
  拒绝、遇到排队输入会放弃候选（`raceProbe`），还会触发 `tui/session-switch` 否决与切换
  提示——这些都不适合启动接管。
- **启动期输入。**草稿留在输入框不发送：Enter 提示「还没就绪」，只放行纯本地命令
  （exit/help/theme/lang/vim/kernel 与重试用的 new/resume），沿用预载分支已验证的行为与
  `isBootSafeCommand` 白名单（`ChannelUi.ready`）。启动期 `/new` 由 binding 裁决：先到者
  绑定，迟到的启动会话被关闭。不采用
  「缓冲进 FIFO、接管后重放」：`resetSessionProjection` 要为启动接管单独开特例保留
  pending，且重放会让用户在看不到会话状态时把消息发出去。
- **构造时就定死的字段要改成可延后**：`backendLabel`、`messaging`、
  `subagentControl.history` 是否存在、`defaultOpeners`（依赖 `options.openSession`）、
  `snapshotOf` 里写死的 `dsh:false`、`attachSessionWorkingActivity` 只在创建时判断。
  占位会话按**目标内核**的选项构造，这些值在 `adoptStartup` 时更新。
- **DSH 扩展晚挂（D1）。**现在 `core.extend` 在 `start` 之后会抛错，`attachDshExtensions`
  构造时就读 `binding.agent`。要改成：允许在启动接管时挂一次扩展，扩展里对
  `binding.agent` 的读取延后到挂载时。这是方案里改动最深的一处 channel 重构。
- **D2（退路）。**若 D1 受阻：Claude 内核走方案 B，DSH 内核继续走预载镜像路径。维护税
  只剩一半，但两套启动方式并存。
- **启动失败。**今天后端打不开就是启动失败、非零退出。方案 B 下界面已在：失败在界面里
  落一条提示行（原因 + `/new` 重试 · `/kernel` 切换 · `/quit` 退出），占位会话保持绑定、
  `ready` 保持 false；`/new` 经 `openSession` 打开新会话并接管。退出时仍在进行的打开由
  `prepare` 在返回时关闭（见上）；Claude 的 `open` 没有中止入口，进程若在打开返回前退出，
  CLI 子进程靠 stdin 关闭自行退出——这点待真实终端验证。
- **Phase 1 的实际行为（独立入口）。**记住的内核是 Claude、SDK 却已被卸载：profile 路径
  在挂载前打开失败、静默回落 DSH 并提示；入口路径下 `prepareBackendStartup` 不加载 SDK，
  失败发生在挂载后的 `open`，界面落「打不开」提示行，`/kernel` 一步切回 DSH（重起）。
  「占位会话改由 DSH 接管、不重启」要等 Phase 2 有进程内 DSH。后端模块本身加载失败
  （包损坏）时入口直接报错退出，由启动器的安全模式接住。记住的内核打开失败、回落到 DSH
  的逻辑（`plugin.ts` 现有）变成「占位会话改由 DSH 接管」，不需要重启。

### 5.4 DSH 后端：进程内 `runProfile`

> 2026-10-07 修订：`runProfile` 的 `boot()` 必建新根，「用 `runProfile`」即两根；app-boot 已导出
> `mountRootInclude` 等原语，「单根、复刻 `prepare`」成为候选。宿主 cordis 是嵌套副本，模块身份与
> 解析劫持的先后是判别约束。

- **用 `runProfile`，不拼底层原语。**它是 `@deepseek-ai/dsh` 的公开子路径导出；
  `scripts/run.ts` 用的 `boot()` 级原语已经漂过一次（引用了 0.2.0-rc.2 不再导出的
  函数）。
- **模块身份。**必须 import **宿主的** `dsh` / `dsh-app-boot` / `cordis`（从 PATH 上
  `dsh` 的 realpath 用 `createRequire` 解析），不能用本包 peer 依赖的副本，否则会出现
  第二个 Cordis 实例。
- **环境变量先于组合。**`cordis.patch.yml` 的 `dsh-tui` 行用 `!!js process.env.X` 读
  `DSH_TUI_*`，在组合时求值，所以 entry 要在调用 `runProfile` 前设好；
  `loadLayeredEnv('dsh')` 会把 `.env` 层写进 `process.env`。
- **契约。**`@deepseek-ai/dsh/profile-boot` 现在既不是 peer 也不在
  `contract.ts` 的 blessed 清单里。需要加入，并做能力探测（`runProfile`、
  `resolvedProfile` 是否存在）；探测失败回退到现在的「spawn dsh」路径。

### 5.5 进程所有权与退出

> 2026-10-07 修订：下文「没有新问题」只在单根下成立。`runProfile` 的 SIGTERM/SIGINT 处理与
> `installFailLoud` 不可关闭，两根下与入口自己的处理器冲突。

读 0.2.0-rc.2 的 `runProfile` 实现可以确认：现在的 TUI **已经**和它跑在同一个进程里
（dsh 的 `bin.js` 就是调用 `runProfile`），它装的 SIGINT/SIGTERM 处理、
`installFailLoud`（未捕获异常 → 释放 app fiber → `process.exit(1)`）、
`createProcessShutdown`（dispose 后设 `exitCode`，超时强退）今天都在。所以进程所有权
**没有新问题**，只有一处变化：

- TUI 根不再挂在 DSH 的 fiber 下面，DSH 的 dispose 碰不到界面。桥接行注册一个 effect，
  在 fiber dispose 时回调 TuiHost 的退出漏斗，先恢复终端（raw 模式、光标、alt-screen、
  同步输出、鼠标、焦点），再让 DSH 的退出继续。
- 另加一个 `process.on('exit')` 兜底，同预载分支的 `onProcessExit`。
- TUI 主动退出时：TuiHost 先收界面，再调 `runProfile` 返回的 `shutdown`，而不是
  `ctx.root.fiber.dispose()`。
- raw 模式下 Ctrl+C 不产生 SIGINT，与今天一致。

### 5.6 设置存储（已定：(a)，Phase 1 已实现）

> 实现（2026-10-06）：`~/.dsh-tui/settings.json`（`src/tuiSettingsFile.ts`）+ 设置服务
> `src/dsh-adapter/tui-settings.ts`。**两条路径都用它**：plugin.ts 不再等宿主的 `settings`
> 服务，`dsh-tui` 分区经文件作用域（旧 host 的 `register` 形状）同步应用，`/settings`
> 屏的读写经同一服务；其他命名空间转给宿主的设置服务（独立入口里没有）。导入：文件不存在
> 时从 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的 `dsh-tui` 行 `config` 取可编辑键
> （跳过 `!!js`），写入并记下来源，之后不再导入；profile 只读不改。已知差异：导入后补丁里
> 残留的这些字段在 DSH 内核下仍是 Config 的一部分，用户层 unset 时会作为兜底出现，独立入口
> 没有这层——配置文档建议删掉残留。DSH 的 Web 设置页改的是 Config，不再影响 TUI。

`dsh-tui.*` 的值（fullscreen、diffLayout、sidePanel、shortcuts…）在 0.1.7+ 宿主下住在
profile 的 Config 行里，`/settings` 通过 DSH 的 `settings.mutate`（带版本号的围栏写入）
写回。Claude 内核不组合 dsh-base 时（DSH 的 `settings` 行在其中），**读**可以借 app-boot 组合，
**写**没有去处。

- **(a) TUI 自有设置文件（2026-10-06 选定）。**如 `~/.dsh-tui/settings.json`，首次启动从 profile
  Config 一次性导入，之后 `dsh-tui` 行不再拥有这些键（Config 里残留的值作为只读的旧层，
  文档说明）。理由：两个内核同一份设置，首帧读设置不需要 app-boot，和
  `~/.dsh-tui/*.json` 现有偏好放在一起。代价：用户可见的文件布局变化与迁移；手写
  cordis.yml 里 `dsh-tui:` 配置的用户需要迁移说明。
- **(b) 继续住 Config。**Claude 内核下设置只读，改设置提示「切回 DSH 内核再改」或
  通过 app-boot 直接写 profile 文件（绕过 DSH 的版本围栏，有并发写风险）。

Phase 1 落地 (a) 时要定的实现细节：导入的触发点（Claude 内核首启时直接读 profile 的
`cordis.yml` / settings 层，还是由 DSH 内核在下次启动时写出）、导入标记（只导入一次）、
DSH 内核下 `/settings` 改写的目标从 `settings.mutate` 切到本文件后，Config 里残留值的
优先级（文件优先，Config 只作导入源）。

无论选哪个，`src/settings/definitions.ts`（纯元数据）与 `tuiSettingsSchema` 继续是唯一
定义来源。

### 5.7 插件生态桥接

- 第三方插件今天从 `@deepseek-harness-tui/dsh-tui/extensions` 等子路径拿类型，
  `inject: [tuiPanels, …]` 拿服务。方案 B 下注册表归 TuiHost，桥接行以**同名服务**把它们
  注册进 Cordis，插件代码不需要改。
- **插件在两个内核下都存在。**它们是 Cordis 插件，需要一个 Cordis 根。今天 Claude 内核也跑在
  `runProfile` 里，第三方主题、面板等插件照样作用于界面；Phase 1 之后 Claude 内核不再组合那份
  profile，这些扩展就没有了——**2026-10-09 裁定：这个缺失不可接受**。Claude 内核路径因此必须组合一个
  **轻量 profile**：只装本包的行与 profile 依赖清单里声明的第三方插件，不装 dsh-base（DSH 的
  agent / llm / tools / workspace 等核心行）。见 6.2 与第 7 节。
- **缺口的确切位置。**Phase 1 的入口自己持有一个裸 Cordis 根（第 3 节），`tui*` 服务住在里面，
  但 profile 里声明的第三方插件不在其中。轻量 profile 补的是这一块，不是「TUI 缺一个 Cordis
  根」——根已经有了，缺的是把插件清单组合进来。
- **首帧不受影响。**profile 在首帧之后加载，插件的 `tui*` 注册走运行期热加入（本节末条已要求
  注册表支持运行期增删）。
- **实现形状（2026-10-09 已定并落地）。**取「往 Phase 1 那个裸根里按清单装配」：入口用 app-boot
  的 `mountRootInclude` 把一份**轻量组合**挂到同一个根上（计划在 `lite-profile.ts`，组合在
  `host-dsh.ts` 的 `composeLite`），本包的行与 profile 依赖清单里声明的第三方插件随之进入这个根；
  `dsh-base` 那层被裁掉，只由它提供服务的行按表禁用（依据是「行的 `inject` 缺哪些服务」，实测
  对账）。另一条候选（另建一根再桥接）被否：两根下第三方行会永久 pending，且它们的 effect 需要
  第二个释放点。判据（模块身份、`cordis` / `react` 各一份）由已入库的
  `scripts/probe-lite-profile-claude.mjs` 在真实实现路径上持续复核。
- **接线与非 DSH 内核下的现状（2026-10-09）。**组合挂在首帧之后：入口等
  `HostComposeSeam.firstFrameFlushed` 再组合，组合成功（已审计）后调用 `composeSucceeded`，运行时
  据此重读挂载时取值的接缝（主题 host、扩展 store、toast sink），并把本包的 `/settings` 分节迁到
  组合的 sections 服务（`rehomeSettingsSection`）。**Claude 内核**上实测（隔离 profile + 本仓
  fixtures `theme`/`panels`/`guard`，验收用例 `plugins-light-claude`）：面板在屏 ✓、`tui/input`
  拦截在屏且 guard 收到输入 ✓、`tui/session-switch` 拦截在屏 ✓、panel id 落在插件自己的身份下
  （无 `act<N>` 兜底）✓、panel budget 与 storage 按身份计入 ✓、运行时主题在组合结算后解析并上屏 ✓
  （`#ab12cd` 单元格，~450 格量级）、`/settings` 出现 `dsh-tui (dsh-tui)` 分节 ✓。**Codex 内核未验**：
  同一条入口组合路径，但 `plugins-light-*` 用例当前只跑 Claude（见末条遗留）。主题一格的判据是
  `DSH_TUI_THEME`（明确意愿）：**仅** `~/.dsh-tui/theme.json` 的持久化偏好不算锁，claude / codex
  品牌默认档（`BRAND_THEMES`）在它之上——实测只放 `theme.json` 时 Claude 内核保持品牌色（0 格），
  DSH 内核（deepseek 不在该表内）画运行时主题。这与 2.3 遗留「`ThemeProvider` 只在挂载时判断
  forced theme」叠加，正是 `composeSucceeded` 补上的那一环。
- **单元格数只作同量级证据。**同一类装置上，实现者与审核各自的探针量到的「哪个内核更多」并不一致
  （一次 Claude 侧更多、一次 DSH 侧更多），所以本节只写量级（~450 格），不写精确单点值：它衡量的
  是「运行时主题画上去了」，不是内核之间的可比值。
- **成本待测。**省掉的是 dsh-base 的组合段；轻量 profile 自身的组合成本要计入 Claude 内核的
  首帧对比基线（1.2）。
- **与上游插件契约的关系（待对齐）。**本包的注册表归属（TuiHost / Cordis）、grants 与
  `apiVersion` 会被上游的插件体系冻结看见（上游 issue #1247 要求把「接口 / 清单 / 管理器 /
  市场 / 兼容性」一体设计后再实现）。归属形状要在 Phase 2 与那份契约对齐，不要先冻在
  「注册表住在 Cordis 树里」上。
- 决策事件（`tui/input`、`tui/session-switch` 等）：TuiHost 的派发接口在没有处理器时
  直接放行；DSH 加载后，桥接行把 Cordis 的 `ctx.on` 处理器与授权存储接进来。启动期
  （DSH 未就绪）的输入本就不发送，不存在绕过拦截的窗口。
- `tui*` 注册在 DSH 晚到时才出现：主题、面板等要能在已挂载的界面上热加入。现有注册表
  大多已支持运行期增删（插件本来就能在运行期装卸），需逐项确认。
- **遗留项 1（2026-10-09 收口，未闭环）**：`/theme` 的**交互路径**在轻量内核上**没有验收覆盖**——
  运行时主题本身已可用（上一条实测），但从 `/theme` 里选主题到它上屏这一路没有任何用例守护；
  DSH 内核路径同样没有（`plugins-*` 只断言由持久化偏好或环境变量驱动的主题）。
- **遗留项 2（2026-10-09 收口，未闭环）**：`composeLite` 的 `trimmed=false` 分支「warning 后
  继续整份组合」**没有入库的自动化覆盖**：入口级真 PTY 证据只来自一次性探针
  `lite-profile-entry-probe.mjs --fail-notrim`（已移出仓库），`accept-host-entry.mjs` 不跑它。
  **残留风险（如实记）**：判「有没有可裁的层」看的是清单里有没有 `excludedBundles` 那几个**写死的
  bundle 名**（`lite-profile.ts`）；若 dsh-base 的行以后经**别的 bundle 名**进清单，计划会被判成
  「无可裁」并静默继续整份组合——相比旧行为的「exit 1 + 启动器 safe mode」，这是从**响亮拒绝**
  变成**静默接受**的语义落差，且 warning 只走调试日志通道（默认不可见）。

### 5.8 启动器

> Phase 1 实现（2026-10-06）：入口是 `lib/types/dsh-adapter/host-entry.js`
> （`src/dsh-adapter/host-entry.ts`），路由判定在 `src/hostEntryRoute.ts`。

- 三进程链（全局启动器 → profile 启动器 → dsh）在 Claude 内核下变成：全局启动器 →
  profile 启动器 → `node <本包 entry>`。对齐检查、安全模式重试、Windows 下 `dsh.cmd`
  的解析留在 profile 启动器。
- **判定分两半。**启动器零 lib 依赖、读不到 profile 补丁的 Config 行，只按「一次性交接 →
  `DSH_TUI_BACKEND`（`--backend`）→ `kernel.json`」判定；入口再按插件同样的排序判一次，
  加上补丁里 `dsh-tui` 行的 `backend`。入口判定为 DSH（被钉住、或 `/kernel` 经入口重起
  到 DSH）时原样交给 `dsh --profile <profile> -- <应用参数>`：环境、stdio 与交接 ACK
  管道（fd 3）透传，由真正接管屏幕的 dsh 进程发 ACK，入口只转发退出。
- `restartTui` 默认用 `process.execPath` + 原 argv 重起；目标内核是 Claude 且启动器给了
  `DSH_TUI_HOST_ENTRY_PATH` 时改为重起到入口（`restartArgv`，只带 dsh `--` 之后的应用
  参数），否则 DSH 进程里的 `/kernel` 切到 Claude 会走整套 DSH 组合。入口里切回 DSH 则
  原样重起入口，由入口交给 dsh。
- 一次性开关（`--version`、`--dump-config*` 等 dsh 前缀参数）继续直接交给 dsh。
- 关闭开关 `DSH_TUI_HOST_ENTRY=0`：所有内核回到 `dsh --profile`（Phase 1 的回滚行）。
  设置文件（5.6）不随开关回退。

## 6. 已知并接受的限制

### 6.1 DSH 加载的同步阻塞

DSH 的模块加载与组合在进程内有约 1 秒的同步段，这期间事件循环被占住，界面不刷新；具体
表现（输入是否回显、按键何时到达）待 Phase 0 基线实测。方案 B 只能做到「先画后冻」，与
预载分支相同。

不走 worker 或子进程隔离：父进程 + IPC 的设计在预载方案中做过并回滚了——启动屏必须是
同一棵已挂载的树、零可见切换，而跨进程的界面与会话桥接把每个 `ChannelUi` 端口都变成了
IPC 协议，维护成本比手写镜像更高。

可以缓解：compile cache（**已吸收，2026-10-09**：启动器给 entry 子进程注入
`NODE_COMPILE_CACHE=<数据目录>/compile-cache`，纯 env 注入、启动器仍零 lib 依赖，用户已
设值与 `NODE_DISABLE_COMPILE_CACHE` 照旧生效，`/restart`、`/kernel` 的替身进程随 entry 的
env 继承。收益是 **0.1s 量级且方差大**：本机交替取样的 render-done 中位数 −80ms、独立复现
−143ms，5 对里出现过 1 次反例；prompt（可发送）侧更稳，约 −0.3s，5/5 warm 更快。与预载
分支的 −70ms / −150ms 同源，不必按单点数字引用。只有 `DSH_TUI_HOST_ENTRY=0` 或
`DSH_TUI_HOST_ENTRY_DSH=0` 两个非默认开关下走 `dsh --profile` 的 DSH 内核不受益——默认路径
下 DSH 内核经入口、或入口委托 dsh，都在 entry 子进程的 env 里，都会继承）；冻结前画出
「正在启动 DSH」的静态状态。

可以缓解：**模块图打包（2026-10-10 落地）**。入口首帧前要加载的是本包自己的 867 个 ESM 文件，
前 1.5s 的 CPU 采样热点是 `compileSourceTextModule`、`internalModuleStat`、`ModuleWrap`、
`getPackageScopeConfig`、`lstat`、`realpathSync`、`readPackageManifest`——瓶颈是**模块解析与
链接的次数**，既不是 I/O（ESM load hook 实测 887 个模块的读取合计只有 72ms）也不是编译。
`pnpm compile` 于是在 `tsc` 之后就地打包 `lib/types`（`scripts/bundle-lib.mjs`）：每个能从外部
**按路径**加载的模块都登记为 rollup 入口（`exports` 全部子路径、启动器与 `scripts/` 里出现的
`lib/types/**.js`、`ink/sixel-worker.js`、`dsh-adapter/host-entry.js`），共享模块抽进
`lib/types/chunks/`，被折叠进 chunk 的原文件删除。本包文件 1747 → 217（113 入口 + 104 chunk），
首帧前加载的本包模块 566 → 158，`lib/types` 7.68MB。**入口与插件行必须共享同一份 chunk**：
入口若单独内联、插件行仍读旧文件，同一批模块就有两份实例，表现为
`dsh: startup failed: 1 required plugin did not activate`（`row-apply`/`entry-dsh-attach`/
`startup-adopted` 全部缺失）——这正是「把每个可外部加载的路径都做成入口」的理由。

**收益按口径读，不要把 ESM load hook 下的差值当真实收益。** hook 对每个模块计时落盘，开销与
模块数成正比：它给基线（进程内 2322 个模块）叠加约 1.1–2.2s，给打包产物（1705 个）约
0.6–1.1s，于是同轮 A/B 在 hook 下看起来是 −1.45s（−39%）。去掉 hook、同一时间窗交替测量是
1555ms → 1223ms（−332ms，−21%）；真实 HOME 下（`DSH_TUI_BOOT_TRACE` + 真实 profile 临时换上
打包产物）是 render-done **1064ms → 852ms（−212ms，−20%）**，组合期的 `row-apply`、
`startup-adopted` 不变——打包只动首帧那一段，不改善「可输入」。机器上并行的其它 dsh 会话会
把绝对数字整体抬高 25% 以上，单次测量不足以下结论，读数要用同轮交替对照。产物体积是这个
手段的天花板（已是 113 个入口必然带来的 facade 开销，`treeshake` 只省 0.06MB），要再往下压
只能 minify，代价是崩溃栈失去行号。

首帧的后续诊断与方案（探针冷缓存问题、`lodash-es` barrel 导入、启动器预检、宿主段在首帧路径上的原因）
见 [首帧启动优化：诊断与方案](first-frame-startup-plan.md)（2026-10-09）。

### 6.2 其他

- ~~Claude 内核下没有第三方 Cordis 插件扩展（见 5.7），相对今天是用户可见的倒退。后续可选：给
  Claude 内核提供一个只组合本包行、不组合 dsh-base 的轻量 profile~~ **2026-10-09 裁定：不可
  接受**。轻量 profile 由「可选」转为 Claude 内核路径的**必备件**，纳入 Phase 2（5.7、第 7 节）；
  Phase 1 的现状因此是一条待闭环的已知缺口，不是被接受的限制。
- 内核在一次进程里只接管一次；运行中切换内核仍然要重启（`/kernel`），与今天一致。
- `dsh --profile dsh-tui` 直接启动（不经本包 entry）**已裁定保留**（2026-10-09，第 10 节第 4 条）。
  这条兼容路径**实现待补**：单根下没有 TuiHost 可建；没有入口槽时 `dsh-tui` 行按其既有路径自己
  渲染（`entry-slot.ts` 头注释），但没有专项实现与验收（现有覆盖见第 10 节第 4 条）。

## 7. 分期

每期独立可合并、可回滚，并带数字。

| 期 | 内容 | 验收 | 回滚 |
| --- | --- | --- | --- |
| 0 | TuiHost 接口，`cordisTuiHost(ctx)` 实现；channel 核心改收 TuiHost；**测基线**：dsh / claude 两个内核从进程启动到首帧、到可发送的时间 | 行为零变化（现有 CI 组全过）；`verify:boundary` 新规则：`channel/core/` 不 import Cordis；基线数字写进本文 | 纯重构，直接 revert |
| 1 | 设置存储落地（5.6 (a)：`~/.dsh-tui/settings.json` + 一次性导入）；本包 entry——自持裸 Cordis 根，`plugin.ts` 的 `apply` 原样挂载（**不建 TuiHost**，见 5.1 修订）；占位会话 + `adoptStartup`（1b）；Claude 内核走 entry、不加载 dsh-base（**profile 里声明的第三方插件此时不进这个根，是 2026-10-09 裁定要求 Phase 2 闭环的缺口**，见 5.7）。DSH 内核此时**不进 entry**，profile 启动器照旧 spawn dsh | Claude 内核首帧与可发送时间对比基线；新增启动接管、启动失败、启动期退出的无头回归；inline / fullscreen / 窄屏手动演练 | profile 启动器只在内核判定为 claude 时走 entry，可用环境变量关闭，关闭即回到今天的 spawn dsh |
| 2 | TuiHost（5.1，由 Phase 0 的 `ChannelHost` 补全）与 Cordis 无关的组装根；DSH 经宿主 `runProfile` 进程内加载；桥接行；DSH 扩展晚挂（D1）；**Claude 内核的轻量 profile（5.7，把本包行与第三方插件组合进来）**；契约加入 `@deepseek-ai/dsh/profile-boot` | DSH 内核首帧对比基线与预载分支；**第三方插件示例（主题、面板、决策拦截）在两个内核下都通过**；轻量 profile 的组合成本计入 Claude 内核基线；`verify:contract` 覆盖能力探测与回退 | 能力探测失败或环境变量关闭时回退到「spawn dsh」 |
| 3 | 清理预载分支（PR #1216 已关闭并作废，2026-10-09；`src/preboot/`、`src/adapter/channel/deferred.ts`、`bin/dst.js` 只在预载分支上，从未进 `main`，所以这一期**没有 `main` 代码可删**）；~~决定 `dsh --profile dsh-tui` 直启路径去留~~**已裁定保留（第 10 节第 4 条；兼容路径实现待补）**；~~改写 AGENTS.md 与架构文档~~**已落地（第 10 节第 1 条）**；~~明确是否吸收预载的 compile cache~~**已吸收（见 6.1）**；明确是否吸收 `onProcessExit` 兜底 | 构建门禁与全部 CI 组 | — |

Phase 1 是收益最大、风险最小的一期。分期于 2026-10-06 按 spike 结果修订：原 Phase 1 的
TuiHost / 组装根重写挪进 Phase 2，Phase 1 的工作量因此主要是设置存储、入口与 1b。

## 8. 与 PR #1216（预载）的关系

**已裁定（2026-10-09）：关闭，分支作废。**方案 B 的 Phase 1（Claude 内核不组合 dsh-base）与
Phase 2（DSH 内核默认也走入口、首帧提前约 47%）都已在 `feat/standalone-host` 落地，预载要换来的
快速启动由它们提供。`src/preboot/`、`src/adapter/channel/deferred.ts`、`bin/dst.js` 只存在于预载
分支，从未进入 `main`，所以 Phase 3 没有 `main` 上的代码可删，只剩分支清理（第 7 节）。

历史选择（保留作记录）：**(a) 先合入**——DSH 内核用户马上得到快速启动，代价是到 Phase 2 之前 main
的每次 `ChannelUi` / 设置改动都要同步补预载镜像（参考当时那次 rebase：22 个端口、4 个 Schema 字段、
一处 kernel 交接冲突）；**(b) 不再维护、关闭**。判断依据是 Phase 2 的到期时间，(b) 是这里的结论。

预载验证过、需要明确吸收或明确不采纳的两样：compile cache（首帧约 −70ms、交接约 −150ms）与
`onProcessExit` 兜底，见 5.2 与 6.1。

## 9. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| ~~Phase 0 抽象漏项（channel 核心某处深层依赖 Cordis）~~ **已关闭（Phase 0 完成）** | 曾是：方案停在 Phase 0 | 边界门禁在位（`channel/core/` 不得 import `@deepseek-ai/*`），继续守后续改动 |
| ~~DSH 扩展晚挂改动过深~~ **已按 D1 落地（2.1）；D2 退路作废** | 曾是：Phase 2 延期 | —（D2 不再是备选，见第 8 节与第 10 节第 3 条） |
| 入口复刻的宿主接口在 DSH 新版本漂移（`host-contract.ts` 的 HOST_MODULES / HOST_REPLICAS） | DSH 内核启动失败 | 能力探测 + 回退到 `dsh --profile`；`verify:contract` 的复刻指纹（`host-replica.snapshot.json`）与版本线 |
| 宿主模块身份解析错误（加载了第二份 Cordis） | 插件服务注册到错误的根 | 只从宿主 realpath 解析；回归里断言单实例 |
| 设置迁移出错 | 用户设置丢失或回到默认 | 迁移只读不删原值；失败时继续读旧层 |
| ~~第三方插件依赖「TUI 在 Cordis 树里」的未文档化行为~~ **单根下不成立**（界面与 DSH 同在那一棵树里） | — | 风险改形：Claude / Codex 内核下第三方插件缺失（5.7，已裁定必备件）；注册表归属待与上游插件契约（#1247）对齐 |

## 10. 需要维护者决定

1. ~~方案方向本身：AGENTS.md 开头的「零核心改动、纯插件挂载的终端界面插件」定位会变成
   「拥有入口的终端应用，DSH 是后端之一」。这一句要改写。~~ **已裁定（2026-10-09）**：
   首句从「终端界面插件」改写为「拥有入口的终端应用」形态；**DSH 仍是首要适配目标与首方
   后端**（`native.dsh` 与 specialist 能力的首方特权不变，见第 9 条），只因 DSH 自身的启动
   成本（1.2）而以独立后端形态存在。AGENTS.md 已按下面这段落地（`@deepseek-ai/*` 的 import 边界
   不在首句重复，见 AGENTS.md「上游边界与契约」）：

   > dsh-TUI 是 DeepSeek Harness 的终端界面应用（`@deepseek-harness-tui/dsh-tui`），零核心改动、
   > 只消费 DSH 的公开导出。DSH 是首要适配目标与首方后端；本包正从「DSH 的插件」演进为「拥有
   > 自身入口与组装根的终端应用」，届时 DSH 与 claude / codex 一样作为后端按需在进程内加载。
   > Agent、会话、模型、工具、持久化与策略域仍然由 DeepSeek Harness 拥有，本包只消费它们。
   > 改动前先读 [docs/contributing.md](docs/contributing.md)（本仓库共享开发契约的权威文本）
   > 与 [ADAPTER.md](ADAPTER.md)（上游边界与契约）；整体结构见 [docs/architecture.md](docs/architecture.md)；
   > 独立宿主的方案、分期与非目标见 [docs/standalone-host-design.md](docs/standalone-host-design.md)。

   改写范围（**2026-10-09 已同步落地**）：AGENTS.md 首段（`CLAUDE.md` 是指向它的符号链接，改真身）；
   README / README_ZH 的定位句；docs/architecture.md 与 architecture.en.md 的开头定位说明（写明
   文档描述的是当前形态，演进方向指向本文）；scripts/make-installer-bundle.mjs 的使用说明文案。
2. ~~设置存储：5.6 的 (a) 还是 (b)。~~ 已定 (a)（2026-10-06）。
2a. ~~分期修订（TuiHost 推迟到 Phase 2）。~~ 已接受（2026-10-06）。
3. ~~DSH 内核走 D1（扩展晚挂、预载整体删除）还是 D2（DSH 保留预载）。~~ **已裁定（2026-10-09）：
   D1「单根」**。实际落地已是单根（入口自建运行时、DSH 内核也走本包入口，见 2.1–2.3 与第 3 节）；
   D2 不再是并列备选（第 8 节：PR #1216 已关闭、分支作废）。
4. ~~`dsh --profile dsh-tui` 直启路径是否继续支持。~~ **已裁定（2026-10-09）：继续支持**。
   「没有 TuiHost 时自建并渲染」的兼容路径**实现待补**——单根下没有 TuiHost 可建；用户直启（不经本包
   entry）时没有入口槽，`dsh-tui` 行按其既有路径自己渲染（`entry-slot.ts` 头注释），但该路径本轮
   没有专项实现与验收，不记为「已完成」。已有覆盖仅限启动器分流的 `DSH_TUI_HOST_ENTRY=0` 回退
   （`scripts/verify-launcher.mjs:372,406`、`scripts/accept-host-entry.mjs` 的 `dsh-entry-off`）；
   用户直接敲 `dsh --profile dsh-tui` 没有专项用例。见 6.2。
5. ~~PR #1216 先合入还是关闭（第 8 节）。~~ **已裁定（2026-10-09）：关闭，分支作废**——Phase 2 的
   入口路径已覆盖它要换来的快速启动；那三个文件从未进 `main`，Phase 3 只清理分支，不删 `main` 上的
   代码。
6. ~~是否接受 Claude 内核在 Phase 1 之后失去第三方 Cordis 插件扩展（5.7、6.2），或要求轻量
   profile 先行。~~ **已裁定（2026-10-09）：不接受**，要求轻量 profile（只组合本包行与第三方
   插件、不组合 dsh-base）纳入 Phase 2（5.7、6.2、第 7 节）。实现形状（往 Phase 1 的裸根里
   装配，还是轻量组合另建一根再桥接）在 Phase 2 定，见 5.7。
7. `@deepseek-ai/dsh/profile-boot` 加入 blessed 包与 peer 依赖。（2026-10-07：已与维护者沟通，`@deepseek-ai/dsh` 成为依赖，2.6 落地。）
