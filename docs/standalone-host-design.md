# 独立宿主（方案 B）设计

[文档索引](README.md) · [架构与限制](architecture.md) · [多后端架构](agent-backend-design.md)

状态：Phase 0、Phase 1 完成，Phase 2 进行中（根模型已定单根）（原型分支 `feat/standalone-host`；规划见实施记录
「Phase 2 规划」一节）。基于 `main`（ec48de22）与
`@deepseek-ai/dsh` 0.2.0-rc.2 的代码阅读。2026-10-06 修订分期：Phase 1 只做「DSH 无关」，
TuiHost 推迟到 Phase 2（见 5.1、第 7 节与实施记录）。

## 一句话

dsh-TUI 从「DSH 的一个 Cordis 插件」变成「自己拥有入口与组装根的终端应用」：先挂界面与
后端中立的 channel 核心，再把后端打开；DSH 只是后端之一，按需在进程内加载，Claude 内核
完全不加载 DSH。

**整个方案只有一道门闩：channel 核心能在没有 Cordis `ctx` 的情况下构造。**Phase 0
做的就是这件事；它做不下来，方案 B 就停在 Phase 0，不影响现状。

## 1. 背景

### 1.1 现在的启动链

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

### 1.2 预载方案的结构性成本

预载方案能工作，但它是在「TUI 是插件」这个前提下的补丁：

- **镜像维护税。**启动态 channel（`src/preboot/bootChannel.ts`）按 `ChannelUi` 端口
  逐项手写；设置、落地页、内核、品牌的判定在 preload 里各算一遍，与 plugin 保持一致。
  PR #1216 在 main 走了一周后 rebase，需要补 22 个端口、4 个 Schema 字段、一处 kernel
  切换交接冲突（详见 PR 记录）。main 的改动越快，这笔税越高。
- **Claude 内核白等 DSH。**Claude 后端（`src/backends/claude/`）不依赖 Cordis，但进程
  仍要先组合完整个 DSH profile（约 1–2 秒、约 750 个模块），才轮到它启动 CLI。
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
- Claude 内核启动时不加载 DSH。
- 启动期没有第二套 channel：「启动中」是一个尚未就绪的会话，就绪时走 channel 现有的
  接管路径。
- 第三方 Cordis 插件现有的 `tui*` 扩展能力在 DSH 内核下保持可用。

非目标：

- 不改 DSH 核心；只使用其公开导出。
- 不做进程隔离（worker / 子进程 + IPC），见 6.1。
- 不改变 transcript 真源规则：仍以后端持久化记录为准。

## 3. 目标架构

```text
bin/dsh-tui.js（启动器：对齐、安全模式、Windows 解析——保留）
  └─ spawn node <本包 lib/types/host/entry.js> <args>
       TuiHost（组装根，Cordis 无关）
         ├─ logger / 生命周期栈 / 退出漏斗 / 终端恢复
         ├─ 设置存储（见 5.6）、本地 shell/fs/attachments
         ├─ tui* 注册表（主题、面板、场景、对话框、状态、快捷键、渲染器、命令树、工作区…）
         └─ createCoreChannel(host, pendingSession, …)  ──►  render(Chat)   ← 首帧在这里
       后端打开（异步，界面已在）
         ├─ claude：openBackendStartup(host, claude) ──► channel.adoptStartup(session)
         └─ dsh：  runProfile(host 的 dsh/profile-boot, profile: 'dsh-tui')
                     └─ dsh-tui 行（桥接行，不再渲染）
                          ├─ 把 TuiHost 的注册表桥成 Cordis 服务（第三方插件照旧 inject）
                          ├─ 决策事件桥（tui/input 等 → ctx.on 处理器）
                          ├─ resolveAgent → createDshSession
                          └─ 交给 TuiHost：channel.adoptStartup(dshSession) + 挂 DSH 扩展
```

上图是 Phase 2 之后的终态。Phase 1 的入口不建 TuiHost：它自己 `new Context()` 持有一个裸
Cordis 根，`plugin.ts` 的 `apply` 原样挂在上面，`tui*` 服务照旧住在这个根里；Claude 内核下
没有 DSH profile，也就没有桥接行。

依赖方向（终态）：界面 → ports；channel 核心 → agent + ports + **TuiHost 接口**；Cordis 只出现在
`src/dsh-adapter/`（DSH 后端与桥接行）。

## 4. 现状的 Cordis 依赖与归属

按「换掉它要做什么」归类（调研清单的摘要，行号以 main 为准）。

| 类别 | 依赖 | 现在的用处 | 方案 B 的归属 |
| --- | --- | --- | --- |
| 仅 DSH 会话 | `ctx.agents`、`agentDefaultModel`、`llm`、`agentPresets`、`approval`、`userQuestions`、`workspaceRegistry`、`sessionProjections`、`tools`、`commands`、`agent/pre-step` | `resolveAgent`、审批/问卷应答、工作区挂接、活动与上下文投影、DSH 扩展 | 全部进 DSH 后端（桥接行）。大部分今天已由 `backendStart === undefined`、`agent !== undefined`、`native.dsh` 守住 |
| 借 Cordis 的 TUI 基础设施 | `ctx.logger`（约 30 处）、`ctx.effect`、`ctx.root.fiber.dispose`、`ctx.cmdlineArgs`、`adapterRuntimeFor(ctx)` | 日志、资源清理、退出漏斗 | TuiHost 自有。`adapterRuntimeFor` 只把 ctx 当 WeakMap 键，换任意对象即可 |
| 借 Cordis 的 TUI 基础设施 | `shell`、`fs`、`attachments` | `!cmd`、git 分支、@ 提及、图片 | TuiHost 提供本地实现；现有代码已有 `fallbackFs` / `localImages` 等回退 |
| 借 Cordis 的 TUI 基础设施 | `settings`、`credentials`、`dshAuth` | `/settings` 读写、凭据、OAuth 呈现（Claude 的 `/login` 也借它） | 最难的一项，见 5.6；OAuth 呈现器移入 TuiHost |
| 插件生态接缝 | `tuiThemes`、`tuiPanels`、`tuiScenes`、`tuiDialogs`、`tuiStatus`、`tuiShortcuts`、`tuiToast`、`tuiRenderers`、`tuiCommandTrees`、`tuiWorkspaces`、`tuiSettingsSections`、`tuiPluginHost` 系列 | 第三方插件扩展界面 | 注册表归 TuiHost；桥接行把它们以原服务名注册回 Cordis |
| 插件生态接缝 | 决策事件（`tui/input`、`tui/session-switch`…）、`installDecisionGuard`、授权存储 | 第三方拦截输入与会话切换 | 派发接口归 TuiHost；DSH 加载后桥接行把 Cordis 处理器接进来，见 5.7 |

channel 核心里还直接读 `ctx` 的位置（`CoreHost` 没盖住的）：`createComposerImages`、
`createCoreFiles`、`createInputDelivery`、`createSettingsHosts`、`dshAuth`、
`createBindingFeed`、`createSessionSwitch`、`createCoreLocalActions`、
`createGitBranchRefresher`、`ctx.effect`（均在 `core/compose.ts`）。这就是 Phase 0 的
工作面。

## 5. 关键设计

### 5.1 TuiHost：把 CoreHost 补全

> 2026-10-07：根模型选定**单根**（TUI 的根即 DSH 根，实施记录「Phase 2 第 2.2 块」），TuiHost 与
> 桥接行不再必要；本节保留作两根方案的记录。

> 2026-10-06 修订：TuiHost 推迟到 **Phase 2**。Phase 1 spike 证明 `plugin.ts` 的 `apply` 在裸
> Cordis 根上零改动即可跑 Claude 内核，Phase 1 不需要「Cordis 无关」。TuiHost 真正必要的时刻
> 是 Phase 2：`runProfile` 的 `boot()` 会另建一个 Cordis 根，两根并存时第三方插件在 DSH 根里
> 看不到 TUI 根的服务，需要 TuiHost + 桥接行。下文按终态描述。

不新造抽象，扩展现有的 `CoreHost`（`core/host.ts`）：

```ts
interface TuiHost {
  readonly logger: Logger                       // 现 ctx.logger
  effect(dispose: () => void | Promise<void>): void   // 现 ctx.effect，TuiHost 自有栈
  readonly runtime: AdapterRuntime              // 现 adapterRuntimeFor(ctx)
  readonly shell: ShellHost | undefined
  readonly fs: FsHost
  readonly attachments: AttachmentHost | undefined
  readonly settings: TuiSettingsStore           // 见 5.6
  readonly credentials: CredentialHost | undefined
  readonly oauth: OAuthPresenterHost | undefined
  readonly decisions: DecisionDispatch          // 见 5.7
  readonly registries: TuiRegistries            // 现 CoreHost 已有的 tui* 快照
}
```

- Phase 0 先由 `cordisTuiHost(ctx)` 实现它，行为零变化；`createCoreChannel` 改收
  `TuiHost`。
- 验收写成门禁：`src/dsh-adapter/channel/core/` 不再 import `@deepseek-ai/cordis`
  （加进 `verify:boundary`）。核心目录随后可以从 `dsh-adapter/` 挪到中立位置。
- `resolveCoreHost` 现在在构造时快照各 `tui*` 服务（只有授权存储每次操作重读），要改成
  从注册表实时取：DSH 晚到时，它带来的第三方插件注册要能出现在已挂载的界面里。

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
> 解析劫持的先后是判别约束。见实施记录「Phase 2 规划」第 1–3 条与 2.2。

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
> `installFailLoud` 不可关闭，两根下与入口自己的处理器冲突，见实施记录「Phase 2 规划」第 4 条与 2.5。

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
写回。Claude 内核不加载 DSH 时，**读**可以借 app-boot 组合，**写**没有去处。

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
- 插件只在 DSH 内核下存在（它们是 Cordis 插件）。**这是相对今天的倒退**：今天 Claude
  内核也跑在 `runProfile` 里，第三方主题、面板等插件照样作用于界面；Phase 1 之后 Claude
  内核不加载 DSH，这些扩展就没有了。见 6.2 与第 10 节。
- 决策事件（`tui/input`、`tui/session-switch` 等）：TuiHost 的派发接口在没有处理器时
  直接放行；DSH 加载后，桥接行把 Cordis 的 `ctx.on` 处理器与授权存储接进来。启动期
  （DSH 未就绪）的输入本就不发送，不存在绕过拦截的窗口。
- `tui*` 注册在 DSH 晚到时才出现：主题、面板等要能在已挂载的界面上热加入。现有注册表
  大多已支持运行期增删（插件本来就能在运行期装卸），需逐项确认。

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

可以缓解：compile cache（预载分支已做，首帧约 −70ms、交接约 −150ms）；冻结前画出
「正在启动 DSH」的静态状态。

### 6.2 其他

- Claude 内核下没有第三方 Cordis 插件扩展（见 5.7），相对今天是用户可见的倒退。后续可选：
  Phase 2 之后给 Claude 内核提供一个只组合本包行、不组合 dsh-base 的轻量 profile，让界面
  插件回来；是否值得做取决于插件生态的实际使用面。
- 内核在一次进程里只接管一次；运行中切换内核仍然要重启（`/kernel`），与今天一致。
- `dsh --profile dsh-tui` 直接启动（不经本包 entry）是否继续支持，是决定项（第 9 节）。
  继续支持就意味着桥接行在「没有 TuiHost」时要自己建 TuiHost 并渲染，保留一条兼容路径。

## 7. 分期

每期独立可合并、可回滚，并带数字。

| 期 | 内容 | 验收 | 回滚 |
| --- | --- | --- | --- |
| 0 | TuiHost 接口，`cordisTuiHost(ctx)` 实现；channel 核心改收 TuiHost；**测基线**：dsh / claude 两个内核从进程启动到首帧、到可发送的时间 | 行为零变化（现有 CI 组全过）；`verify:boundary` 新规则：`channel/core/` 不 import Cordis；基线数字写进本文 | 纯重构，直接 revert |
| 1 | 设置存储落地（5.6 (a)：`~/.dsh-tui/settings.json` + 一次性导入）；本包 entry——自持裸 Cordis 根，`plugin.ts` 的 `apply` 原样挂载（**不建 TuiHost**，见 5.1 修订）；占位会话 + `adoptStartup`（1b）；Claude 内核走 entry、不加载 DSH。DSH 内核此时**不进 entry**，profile 启动器照旧 spawn dsh | Claude 内核首帧与可发送时间对比基线；新增启动接管、启动失败、启动期退出的无头回归；inline / fullscreen / 窄屏手动演练 | profile 启动器只在内核判定为 claude 时走 entry，可用环境变量关闭，关闭即回到今天的 spawn dsh |
| 2 | TuiHost（5.1，由 Phase 0 的 `ChannelHost` 补全）与 Cordis 无关的组装根；DSH 经宿主 `runProfile` 进程内加载；桥接行；DSH 扩展晚挂（D1）；契约加入 `@deepseek-ai/dsh/profile-boot` | DSH 内核首帧对比基线与预载分支；第三方插件示例（主题、面板、决策拦截）在新路径下通过；`verify:contract` 覆盖能力探测与回退 | 能力探测失败或环境变量关闭时回退到「spawn dsh」 |
| 3 | 删除 `src/preboot/`、`src/adapter/channel/deferred.ts`、`bin/dst.js`；决定直启路径去留；改写 AGENTS.md 与架构文档 | 构建门禁与全部 CI 组 | — |

Phase 1 是收益最大、风险最小的一期。分期于 2026-10-06 按 spike 结果修订：原 Phase 1 的
TuiHost / 组装根重写挪进 Phase 2，Phase 1 的工作量因此主要是设置存储、入口与 1b。

## 8. 与 PR #1216（预载）的关系

方案 B 落地后，预载分支整体删除（Phase 3）。在那之前有两个选择：

- **(a) 先合入。**DSH 内核用户马上得到快速启动；代价是到 Phase 2 之前，main 的每次
  `ChannelUi` / 设置改动都要同步补预载的镜像（参考本周 rebase：22 个端口、4 个 Schema
  字段、一处 kernel 交接冲突）。
- **(b) 不再维护，关闭。**快速启动等方案 B 的 Phase 1（Claude）/ Phase 2（DSH）。

判断依据是 Phase 2 预计多久能到。Phase 0 完成并拿到基线数字后再定也不迟；已 rebase 到
当前 main 的预载分支可作为 (a) 的实现。

## 9. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Phase 0 抽象漏项（channel 核心某处深层依赖 Cordis） | 方案停在 Phase 0 | Phase 0 本身是 kill-switch；边界门禁让漏项编译失败 |
| DSH 扩展晚挂改动过深 | Phase 2 延期 | D2 退路：DSH 内核保留预载 |
| `runProfile` 接口在 DSH 新版本变化 | DSH 内核启动失败 | 能力探测 + 回退到 spawn；加入 `verify:contract` 版本线 |
| 宿主模块身份解析错误（加载了第二份 Cordis） | 插件服务注册到错误的根 | 只从宿主 realpath 解析；回归里断言单实例 |
| 设置迁移出错 | 用户设置丢失或回到默认 | 迁移只读不删原值；失败时继续读旧层 |
| 第三方插件依赖「TUI 在 Cordis 树里」的未文档化行为 | 插件失效 | Phase 2 用现有插件示例回归；`tui*` 同名服务保持类型不变 |

## 10. 需要维护者决定

1. 方案方向本身：AGENTS.md 开头的「零核心改动、纯插件挂载的终端界面插件」定位会变成
   「拥有入口的终端应用，DSH 是后端之一」。这一句要改写。
2. ~~设置存储：5.6 的 (a) 还是 (b)。~~ 已定 (a)（2026-10-06）。
2a. ~~分期修订（TuiHost 推迟到 Phase 2）。~~ 已接受（2026-10-06）。
3. DSH 内核走 D1（扩展晚挂、预载整体删除）还是 D2（DSH 保留预载）。
4. `dsh --profile dsh-tui` 直启路径是否继续支持。
5. PR #1216 先合入还是关闭（第 8 节）。
6. 是否接受 Claude 内核在 Phase 1 之后失去第三方 Cordis 插件扩展（5.7、6.2），或要求轻量
   profile 先行。
7. `@deepseek-ai/dsh/profile-boot` 加入 blessed 包与 peer 依赖。（2026-10-07：已与维护者沟通，`@deepseek-ai/dsh` 成为依赖，2.6 落地。）

## 实施记录

原型在 worktree `dsh-TUI-standalone`（分支 `feat/standalone-host`，起点 upstream/main
ec48de22）。本节按时间记录每一步做了什么、发现了什么、设计因此改了什么；设计正文同步修订。

### 2026-10-06 · Phase 0 开工

- 切法：新增 Cordis 无关的 `ChannelHost` 接口（`channel/core/channel-host.ts`），Cordis
  版实现 `cordisChannelHost(ctx)`（`channel/cordis-host.ts`，在 core 目录外）。channel 核心
  与它直接调用的辅助函数（`mentions`、`files`、`composer-images`、`settings-host`、
  `input-delivery`）改收 host；`createChannel(ctx, …)` 负责构造 host。行为零变化。
- ctx 的用法分三类，接口按类设计：
  1. 服务查找（`fs`、`attachments`、`shell`、`settings`、`credentials`、`llm`、
     `dshAuth`、`tui*`）→ host 上的具名查找；
  2. 以组合根为键的注册表（`adapterRuntimeFor`、决策守卫与派发、本地 settings sections）
     → **本期不重键**，Cordis 版 host 委托原函数；`dsh-tui-extensions` 行也会装守卫，两边
     必须落在同一个 Cordis 根上；
  3. 生命周期钩子（`logger`、可选的 `effect`、DSH 专属的 `agent/pre-step`）→ 具名可选钩子。
- `resolveCoreHost` 的构造时快照本期保持不变（改成实时读属于 Phase 2 的行为变化）。
- 目标口径修正：Phase 0 要求的是「构造 channel 核心不需要 Cordis 上下文」，不是「依赖图里
  没有 cordis」。核心经 `../../themes.js` 等模块间接加载 cordis 包不影响 Phase 1——包随
  peer 依赖已安装，加载模块不需要运行中的 Cordis 根。门禁规则据此写成「core 目录不直接
  import `@deepseek-ai/cordis`」。

### 2026-10-06 · Phase 0 重构完成（channel 核心脱离 Cordis 上下文）

- 新增 `src/dsh-adapter/channel/channel-host.ts`（接口：`ServiceLookup`、`ChannelHost`）与
  `channel/cordis-host.ts`（`cordisChannelHost(ctx)`）。`ServiceLookup` 只要求
  `get(name)`，Cordis 的 `Context` 结构上就满足，因此只做服务查找的辅助函数
  （`mentions`、`composer-images`、`settings-host`、`core/files`、`core/local-actions`、
  `createGitBranchRefresher`）改收 `ServiceLookup`，已有脚本传 ctx 的调用不用改。
- `input-delivery`、`core/session-switch`、`core/binding-feed`、`core/host`
  （`resolveCoreHost`）、`core/compose` 改收 `ChannelHost`；`agent/pre-step` 变成可选钩子
  `onAgentPreStep`，非 DSH 宿主不提供即可。`createChannel(ctx, …)` 构造
  `cordisChannelHost(ctx)` 传入，DSH 扩展（`attachDshExtensions`）仍直接拿 ctx。
- `cordisChannelHost` 的 `logger` 做成 getter，每次使用时读 `ctx.logger`，与改动前一致；
  `effect` 只在 ctx 具备时提供（脚本里的裸 embedder 没有）。
- 门禁：`verify:boundary` 的 core 规则从「只能 import `@deepseek-ai/cordis`」收紧为「不能
  import 任何 `@deepseek-ai/*`」。`src/dsh-adapter/channel/core/` 现在没有任何 cordis
  import。
- 跟着改的脚本：`verify-backend-channel.ts`、`verify-channel-ui.ts`（改传
  `cordisChannelHost(ctx)`）、`verify-channel-composition.ts`（两条源码正则）。
- 验证：`tsc` 通过；`pnpm build` 181 项门禁全过（含收紧后的 `verify:boundary`）；
  聚焦脚本 `verify-channel-composition`、`verify-channel-ui`、`verify-backend-channel`、
  `verify-adapter-shadow`、`verify-adapter-channel`、`verify-adapter-channel-conformance`、
  `verify-channel-rollback`、`verify-image-downsample`、`verify-reports-metadata` 通过。
  `verify-settings-compat` 失败，原因是 main 上已有的问题（harness 漏注入
  `normalizeBrandSetting`），与本改动无关。
- 发现：`ChannelHost` 的 `dispatchDecision` / `installDecisionGuard` /
  `markDecisionDispatchTopology` 目前只是把 Cordis 根当键的注册表原样转发。独立宿主
  （Phase 1）没有 Cordis 根，要么给这几个函数一个非 Cordis 的根对象作键（`compositionRoot`
  本来就只把它当 WeakMap 键），要么提供一个「没有处理器、一律放行」的实现。Phase 1 先用
  后者：Claude 内核下没有第三方插件，也就没有决策处理器。

### 2026-10-06 · Phase 0 基线测量

工具：`src/utils/bootTrace.ts`（`DSH_TUI_BOOT_TRACE=<文件>` 时追加 JSON 行，默认关闭，
不写 stdout/stderr）在 `index.ts` 的行 apply、`plugin.ts` 的 runtime apply、会话打开
前后、`render()` 前后打点；`scripts/probe-startup-baseline.mjs` 在隔离 HOME 里复制已安装
的 profile（dsh-tui 包换成本 checkout 的 `bin/`、`lib/`），在 PTY 里起 profile 启动器，
每个内核跑 5 轮取中位数。

环境：WSL2，Node 24.20，dsh 0.2.0-rc.2，dsh-tui 本 checkout（≈ 0.13.0 + Phase 0）。
单位 ms，从 spawn profile 启动器算起：

| 时间点 | DSH 内核 | Claude 内核 |
| --- | --- | --- |
| dsh 进程启动 | 107 | 112 |
| dsh-tui 行 apply（profile 组合到本行） | 1205 | 1223 |
| runtime apply（Loader settle 之后） | 1676 | 1688 |
| 会话打开开始 | 2003 | 2025 |
| 会话打开结束 | 2026 | 2620 |
| render 开始 | 2082 | 2659 |
| render 完成 | 2096 | 2677 |
| 注入端点出现 | 2100 | 2682 |

读法：

- 两个内核在「会话打开开始」之前几乎一样（约 2.0s），这段全是 dsh：进程起来约 0.1s，
  组合到 dsh-tui 行约 1.1s，等 Loader settle 约 0.5s，插件在开会话前的准备（预设、设置、
  工作区、宿主接缝）约 0.33s。
- DSH 会话本身打开只要约 23ms；Claude 后端打开（SDK 加载、CLI 握手）约 600ms。隔离 HOME
  里没有 Claude 凭据，握手照样成功（凭据在首个请求时才用）。
- 因此 Claude 内核下约 2.0s（≈ 75%）花在一个它用不到的 DSH 组合上——这就是 Phase 1 要
  拿掉的部分。Phase 1 之后的 Claude 内核 ≈ 本包入口加载 + 首帧（待测）+ 600ms 后端打开，
  且首帧可以先于后端打开出现。具体数字等 Phase 1 原型实测，这里不做估算。
- 「可见首帧 / prompt 画出」两列没有测到，见下面的环境发现第 3 条。

环境发现（与方案无关，但影响测量与本机使用）：

1. 本机 profile 的 `dsh-purge` 链接到本地开发副本，`autoApplyOnStart: true` 时每次启动都会
   改写**全局** dsh 的 `lib/bin.js`，写出的文件引用了不存在的 `profile-boot-BP_C0vpU.js`，
   之后 `dsh`/`dsh-tui` 全部启动失败。04:49 与 05:17 各发生一次（后一次是本探针的一轮启动
   触发的）。探针现已从隔离 profile 里排除 dsh-purge（bundles、依赖、profile 层 patch）。
2. 本机 profile 的 `@deepseek-ai/schemastery` 是 3.18.2，0.13.0 的 dsh-tui 要求 ≥ 3.18.3
   （volatile Config），冷启动直接失败；仓库自带的 `verify-installed-startup.mjs` 也因此跑
   不过。探针在隔离 profile 里改用 dsh 自带的 3.18.4。
3. 在这台 WSL 上，用 node-pty 起的 TUI 只渲染空帧（每帧只有清屏）。已排除：本 checkout 的
   lib 与原版 0.13.0 一样；全新 HOME 与复制的真实偏好一样；fullscreen 与 inline 一样；
   直接起 profile 副本与经全局启动器一样；PTY 尺寸正常（100×32），没有崩溃日志。原因未查明；
   时间点打点不依赖屏幕，所以基线仍有效。可见首帧要在真实终端里手测。（**更正**：根因不是 PTY，而是隔离 profile 与全局安装的 dsh 组合时共享依赖路由出错，见「Phase 1 验收」一节的「DSH 空帧的根因」。）

### 2026-10-06 · Phase 1 spike：Claude 内核不组合 DSH profile 的上限

（写于下面的交接一节之后；交接一节保持在末尾作为新会话的入口。）做法按交接一节的 1–7 条执行，有一处偏离：入口放在 `src/dsh-adapter/spike-entry.ts`
而不是 `src/host/`——它要 import `@deepseek-ai/cordis`，放在 `dsh-adapter/` 外会让
`verify:boundary` 失败。内容：`markBoot('entry-start')` → 并行动态 import cordis 的
`Context`、`./index.js` 的 `Config`、`./plugin.js` 的 `apply` → `new Context()` → 照
dsh-tui 行从环境变量构造 `Config` → `await apply(ctx, config, ctx)`。探针加了
`--entry spike`（spawn `node <隔离副本>/lib/types/dsh-adapter/spike-entry.js`）和
`PROBE_SCREEN=1`（打印末屏）；`plugin.ts` 在 `await settingsReady` 前后加了
`settings-wait-start/end` 两个打点（基线路径同样受益）。spike 入口与探针改动均未提交。

**耦合度结论：零守卫。**裸 `new Context()` 上 `plugin.ts` 的 `apply` 不改一行就跑通了
Claude 内核：交接里预期会撞的点全部已有降级——`registerBundledPresets` 在没有
`agentPresets` 时返回 false、退回打包预设目录；`userQuestions` 不存在就地 new；
`agentDefaultModel` 是可选查找；`tui*` 服务缺失只在 profile 启动时告警（这里不告警）。
唯一的代价是 `settingsReady` 的 300ms 兜底（见下表）。注意「零守卫」只覆盖到首帧：
退出路径（`/quit`、信号后 `disposeRootAndThen` 对裸根的 `ctx.root.fiber.dispose()`、终端
状态恢复）在 spike 里没验证——探针只发 SIGTERM，不检查退出码与终端恢复。末屏确认是 Claude 内核：启动台、
模型 `claude-opus-5-5`、状态栏 `Claude · Checking…`，没有降级到 dsh 的提示。

数字（5 轮中位数，ms，**从 spawn spike 的 node 进程算起**；基线是从 spawn profile 启动器
算起、含约 107ms 启动器链，见上一节）：

| 时间点 | spike（Claude） | 基线（Claude） |
| --- | --- | --- |
| entry-start（spike 模块开始执行） | 25 | — |
| entry-modules（cordis + index + plugin 模块图加载完） | 688 | — |
| runtime-apply | 693 | 1688 |
| 会话打开开始 | 697 | 2025 |
| 会话打开结束 | 1324 | 2620 |
| settings 等待开始 / 结束 | 1341 / 1640 | — |
| render 完成 | 1653 | 2677 |
| 注入端点出现 | 1658 | 2682 |
| prompt 画出（屏幕上出现 `❯`） | 1736 | 未测到 |

读法：

- 原样 spike 的 render 完成比基线早约 1.0s（1653 vs 2677）。其中 300ms 是 settings 兜底
  白等（裸根没有 settings 服务，`ctx.inject(['settings'])` 回调永不执行）；Phase 1 的入口
  自带设置存储后这段消失，render 完成约 **1.35s**，即基线的一半左右。
- 剩下的 1.35s 构成：模块图约 660ms、Claude 后端打开约 630ms、其余（预设、会话前准备、
  Chat 元素构造、首帧）不到 70ms。DSH 组合那约 2.0s 已经整段拿掉。
- 模块图 660ms 几乎全在 `plugin.js` 的依赖图里（cordis 3ms、index 14ms）。按 `plugin.js`
  的顶层 import 逐个计时（先到者付共享依赖，只作量级参考）：`./channel.js` 约 270ms、
  `../screens/Chat.js` 约 270ms、`@deepseek-ai/dsh-user-questions` 约 57ms、
  `@deepseek-ai/dsh-session` 约 21ms。Claude 内核下 DSH 包只占约 80ms，大头是 TUI 自己。
- 1b 的空间：首帧依赖模块图与配置，不依赖后端会话。占位会话先挂界面时，首帧可以落在
  约 700–750ms（模块 + 配置 + 首帧），后端打开的 630ms 与界面并行。
- 环境发现 3 的范围缩小了：spike 下同一个 node-pty 能正常画出完整界面（启动台、输入框、
  状态栏），所以空帧只出现在「dsh-tui 启动器 → dsh」这条链上，与 TUI 渲染本身无关。原因
  仍未查明。（**更正**：根因不是 PTY，而是隔离 profile 与全局安装的 dsh 组合时共享依赖路由出错，见「Phase 1 验收」一节的「DSH 空帧的根因」。）

**对设计的影响（待用户/chimney 决定）**：交接里的推论成立——Phase 1 需要的是「DSH 无关」，
不是「Cordis 无关」。TUI 自己持有一个裸 Cordis 根就能跑，`tui*` 服务原样住在里面；5.1 的
TuiHost 抽象与 `plugin.ts` 的重写可以推迟到 Phase 2（`runProfile` 的 `boot()` 另建根、两根
并存时才必要）。Phase 1 真正要补的只有：设置存储（5.6，消掉 300ms 兜底且让 /settings 能写）、
本包入口与启动器分流、1b 的占位会话。

### 2026-10-06 · Phase 1 第 1、2 块：启动接管（1b）与设置存储 (a)

（写于交接一节之后。）

**1b 启动接管**（正文 5.3 已同步）：

- `src/agent/starting-session.ts`：占位会话（`status: 'starting'`、无能力、空历史、
  `submit` 不发出）。
- `backends.ts`：`openBackendStartup` 拆成 `prepareBackendStartup`（加载后端模块、
  host、prefs、catalog、`open`、`resumeCommand`，不等握手）+ `start()`（reserve + open +
  history）；原函数 = 两者连做，profile 路径语义不变。
- `ChannelLaunchOptions.startup` + `compose.ts` 的 `adoptStartup`（prepare/adopt）；
  `subagentControl` 改成按会话构造（`subagentControlFor`），接管时重建；`createChannel`
  在有 `startup` 时也挂 working-activity（`onBind` 按会话判断能力）；`adoptWith` 置
  `ready = true`（失败后 `/new` 重试）。
- `ChannelUi.ready` + `CHANNEL_UI_PROPERTIES`；`PromptInput` 三处拦截（命令、Enter、
  粘贴行）+ `isBootSafeCommand`；i18n `startup-not-ready` / `startup-open-failed`。
- `plugin.ts`：`apply` 第四参 `RuntimeApplyOptions.deferBackendOpen`，**只有独立入口传**；
  profile 路径照旧先打开再挂载（记住的内核打不开时回落 DSH 依赖这个顺序）。延后路径下
  后端模块加载失败直接报错退出（入口里没有 DSH 可回落）。启动打点加 `startup-adopted`。
- 回归 `scripts/verify-startup-adoption.tsx`（30 项，登记 channel-ui 组）：接管、失败后
  `/new`、打开途中释放、启动期 `/new` 抢先、真实 Chat 的 Enter 拦截与本地命令放行。

**设置存储 (a)**（正文 5.6 已同步）：`src/tuiSettingsFile.ts`、
`src/dsh-adapter/tui-settings.ts`；`plugin.ts` 的设置块不再 `ctx.inject(['settings'])`，
改为同步执行（`settingsReady` 在两条路径上都不再等待，独立入口的 300ms 兜底随之消失）；
channel 的 `settingsHost` 与 DSH 扩展的 `recapOnOpen` 读同一服务（`settingsService` 选项、
`cordisChannelHost(ctx, services)`）。回归 `scripts/verify-tui-settings.ts`（20 项）。
README、`docs/configuration*.md`（及 guide 副本）同步。

**验证**：`tsc`、`pnpm build`（89 项门禁）通过；channel-ui 组 177 项通过，失败 5 项
（`verify-activity-store`、`verify-guide`、`verify-settings-compat`、
`verify-compaction-progress`、`verify-splash-font-setting`）在 main（ec48de22）上同样失败，
与本改动无关；input-terminal 组全过。设置相关聚焦脚本（namespace、display、definitions、
repro-settings、scroll、root-inline、panel-picker）通过。

**数字**：本轮机器明显变慢（一个 3 亿次空循环 3s，平时约 0.3s），绝对值不可比，只看结构：
spike 入口下「会话打开」段从约 630ms 缩到约 75ms（只剩 prepare），settings 等待从 300ms
变 0，首帧之后约 500ms 接管完成（`startup-adopted`）。干净环境的数字留到第 3 块之后重测。

### 2026-10-06 · Phase 1 第 3 块：本包入口与启动器分流

（写于交接一节之后。）正文 5.8 已同步。

- `src/dsh-adapter/host-entry.ts`（取代 spike 入口，spike 文件已删）：先按
  `src/hostEntryRoute.ts` 判内核；Claude 时在裸 Cordis 根上挂 `plugin.ts` 的 `apply`
  （`deferBackendOpen` + `profile`），SIGTERM/SIGHUP 释放根（有界 3s）后按信号码退出；
  DSH 时交给 `dsh --profile`（见 5.8）。
- `RuntimeApplyOptions.profile`：入口的 argv 没有 `--profile`，`/update` 与设置导入
  用它找 profile。
- `bin/dsh-tui.js`：`startEntrySession` + 内联判定；分流开启时给子进程设
  `DSH_TUI_HOST_ENTRY_PATH` 与 `DSH_TUI_PROFILE`。
- `src/update.ts`：`restartArgv`（纯函数）。
- 探针：`--entry host|profile` 取代 `--entry spike`，两者都从 spawn 启动器算起。
- 回归：`verify-launcher.mjs` §7（6 项：`--backend claude` 走入口、开关关闭、dsh 前缀
  参数、`kernel.json`、交接到 dsh、Config 行钉 DSH 时入口原样交给 dsh 并带应用参数）；
  `scripts/verify-host-entry.ts`（17 项：入口内核排序、补丁 `backend` 读取、
  `restartArgv`）。`verify-startup-argv.mjs` 测的是交给 dsh 的 argv 语法，关掉分流跑。
- 文档：README / README_ZH 的 Claude 一节、`docs/claude-backend*.md` 已知限制（第三方
  插件不加载、`DSH_TUI_HOST_ENTRY=0`）、`docs/configuration*.md` 环境变量表；guide 副本
  同步（顺带补齐了 main 上 claude-backend 副本的既有漂移，`verify-guide` 恢复全绿）。
- `src/update.ts` 只从 `kernelPrefs.ts` 取入口常量（`HOST_ENTRY_PATH_ENV`、
  `hostEntryDisabled`），不引入路由模块：`verify-update.mjs` 把 `update.js` 的依赖镜像到
  临时目录，路由模块会把 yaml 与 credentials 也拖进镜像。
- 验证：`pnpm build`（89 项门禁）、`verify:package` 通过；input-terminal、
  session-workspace、render-scroll 三组中失败的 `verify-splash-eggs`、
  `repro-picker-windowing` 在 main 上同样失败，`verify-update-checksum` 是下载流计时断言
  （本分支 3 次过 2 次，main 上本轮 5 次全失败），均与本改动无关。
- 手动核实（PTY，spike 入口时期）：裸根上 `/quit` 退出码 0、终端恢复序列完整；启动期
  SIGTERM 时 Ink 同样发出恢复序列；两种情况都没有遗留 Claude CLI 子进程。

数字（5 轮中位数，ms，从 spawn profile 启动器算起；机器仍偏慢，一个 3 亿次空循环约
2.3s，与 Phase 0 基线不可直接比，同一轮内三组可比）：

| 时间点 | Claude · 本包入口 | Claude · `DSH_TUI_HOST_ENTRY=0` | DSH 内核 |
| --- | --- | --- | --- |
| 入口 / dsh 进程启动 | 153 | 149 | 141 |
| 模块加载完（入口） | 1092 | — | — |
| dsh-tui 行 apply | — | 1768 | 1649 |
| 会话打开开始 | 1111 | 3091 | 2826 |
| 会话打开结束 | 1188（只是 prepare） | 3997 | 2855 |
| render 完成（首帧） | **1228** | 4062 | 2934 |
| prompt 画出 | 1457 | 未测到（PTY 空帧） | 未测到 |
| 可发送（接管完成） | **2134** | 4062 | 2934 |

读法：同一台机器同一轮里，Claude 内核首帧提前约 70%（4062 → 1228），可发送提前约 47%
（4062 → 2134）；DSH 内核路径不变。入口路径下 PTY 能正常画出界面，再次说明空帧只出现在
dsh 启动链上。干净环境的绝对值待重测。

**还需要真实终端手动演练（无头环境做不了）**：

0. 真实安装里先跑通：探针的隔离 profile 把 dsh-tui 拷成真实目录，真实安装里它是 pnpm
   虚拟 store 下的链接。入口的模块解析（cordis、Claude SDK）与 profile 模式下同一文件的
   解析路径相同，理应一致，但没在真实 `~/.dsh/profiles/dsh-tui` 里跑过：先把本分支装进
   一个 profile，`dsh-tui --backend claude` 跑通。
1. inline 与 fullscreen 两种模式、窄终端下 Claude 内核启动：首帧、「还在启动」提示、
   就绪后发送。
2. `/kernel` 双向切换：DSH → Claude（应重起到入口，fd 3 ACK 由入口里的 TUI 发出，无
   闪屏）；Claude → DSH（重起入口 → 交给 dsh，ACK 由 dsh 进程发出）。
3. Claude 内核下 `/restart`、`/update`（入口带 `profile`）。
4. 启动期 `/quit` 与 Ctrl+C，确认没有遗留 `claude` 子进程。

### 2026-10-06 · Phase 1 验收：tui-test 模拟终端

（写于交接一节之后。）用 [microsoft/tui-test](https://github.com/microsoft/tui-test)
（`@microsoft/tui-test` 0.1.0，devDependency）把交接清单 1–4 做成可重复的验收脚本
`scripts/accept-host-entry.mjs`：PTY + 会应答终端查询（DA1、OSC 11 等）的屏幕模型，按
屏幕文本、终端模式（alt screen、光标、bracketed paste、focus、鼠标）、退出码、启动打点和
`restart.log` 断言。隔离 profile 的构建从探针抽到 `scripts/lib/isolated-profile.mjs`，
`probe-startup-baseline.mjs` 改为共用。

**怎么跑**：`pnpm compile && node scripts/accept-host-entry.mjs [--only a,b] [--keep] [--no-auth]`。
非 CI 门禁；需要已安装的 dsh 与 dsh-tui profile、PATH 上的 `claude`、Linux/macOS（以
`env -i` 启动，环境精确）。隔离 HOME 只**链接** `~/.claude/.credentials.json`（令牌刷新写回
真实文件）并**拷贝** `~/.claude.json`；不发模型请求，`DSH_TUI_CLAUDE_LIVE=1` 才加一条
`live-send`。慢启动 / 打开失败用一个假 `claude`（经指定 CLI 路径的环境变量接入，见脚本头部）：`--version`
交给真 CLI，会话启动前按 `FAKE_CLAUDE_DELAY` 等待、`FAKE_CLAUDE_FAIL_FILE` 存在时退出 1。
每个用例都查退出后的终端模式，并用唯一环境变量标记扫 `/proc/*/environ` 确认没有遗留进程。
`-landing` / `-chat` 两种入口：新启动落在落地页（launchpad），`DSH_TUI_NO_LAUNCHPAD=1`
直接进对话页——两处的 Enter 与命令是不同的代码路径，这次的几个缺陷都只在其中一边。

**结果**（全部修复后，15 个用例，14 通过、1 失败；2026-10-07 修好 J 后 15 个全过，见下一节）：

| 用例 | 结果 | 说明 |
| --- | --- | --- |
| startup-fullscreen / startup-inline（60 列） | 通过 | 首帧约 1.4–1.5s；走入口不经 dsh；接管；`/quit` 恢复终端 |
| startup-not-ready-landing / -chat | 通过 | 草稿保留、不排队、会话命令被拒且不执行、`/help` 放行；落地页上提示在 Tips 行 |
| open-failed-landing / -chat | 通过 | 失败行 + `/new` 提示行（落地页自动收起）；`/new` 打开会话 |
| initial-prompt-held | 通过 | 命令行首句到达入口，会话未就绪时不入队 |
| quit / ctrlc / sigterm-while-starting | 通过 | 退出码、终端恢复、无遗留 claude 进程；SIGTERM 以信号结束、无安全模式提示 |
| restart-landing / restart-chat | 通过 | 新入口进程起来并接管；不经 dsh |
| kernel-to-dsh-landing / -chat | 通过 | 交给 dsh、DSH 画面出现、仍在 alt screen、旧进程 15s 后仍在监督、DSH 里 `/quit` 恢复终端 |
| dsh-to-claude | 失败（已知 J，main 同样；2026-10-07 已修） | 重起到入口并接管 Claude 会话；但交接后已不在 alt screen（见 J） |

**修复（均有回归）**

- **A 落地页绕过启动期拦截。**落地页的 Enter 走 `Chat.tsx` 的 `closeLaunchpad`，直接
  `channel.submit`，不经 `PromptInput` 的 `ready` 判定：启动期按 Enter 草稿被排进队列
  （「Queued · delivered after the turn」），接管后也没发出；落地页上的参数段、动作按钮、
  补全菜单直达 `runCommand`，非白名单命令照跑。修：`Chat` 加 `refusedAtStartup`，用在
  `closeLaunchpad`（收起落地页之前，草稿留在原处）、`runCommand` 入口、落地页动作与菜单、
  外部注入的 `submit`。回归：`verify-startup-adoption.tsx` 的屏幕级用例改为对话页 / 落地页
  各跑一遍（38 项），去掉修复后落地页那组变红。
- **B 退出后 bracketed paste 与 focus 上报被重新打开。**`finishExit` 的 `detachForShutdown`
  只停渲染、不卸 React 树；收尾序列写完后的 150ms 等待里，一次迟到的提交挂载了 `useInput`，
  `App.handleSetRawMode` 计数为 0 便重新开 raw 模式并写 `?2004h`、`?1004h`——shell 拿回
  的终端开着这两项（bash 下切窗口会打出 `^[[I`/`^[[O`）。修：`App.detachForShutdown` 置闩，
  其后的开启请求直接返回（对应的关闭见计数为 0 本就返回）。回归：`verify-exit-mouse-cleanup.tsx`
  第 4 节，去掉修复后变红。入口路径复现；profile 路径在 PTY 下不挂 App（见下），无法验证，
  但漏斗相同，判断同样存在。
- **F 从落地页 `/restart`、`/kernel` 让旧进程崩溃。**`/restart` 的旧进程释放根、拉起替身后
  留下来等它；落地页随命令收起，`Chat` 的求星弹窗 effect 重新布防，700ms 后定时器读
  `channel.working`——channel UI 生命周期已结束，按设计抛「Channel UI lifetime has ended」，
  旧进程以 7 退出，启动器弹「进入安全模式？」，替身却已接管，两者抢同一个终端。修（窄）：
  该定时器读不到 channel 即放弃。验收 `restart-landing` 覆盖（修前 4/4 复现）。与内核无关。
- **D 失败行的 `/new` 提示被吃掉。**notice 行渲染成单行分隔线标题，`startup-open-failed`
  的第二行（`/new 重试 · /kernel 切换内核 · /quit 退出`）没有位置，错误信息一长就只剩截断的
  第一行。修：拆成两条 notice（原因只取首行；提示单独一行，i18n `startup-open-failed-hint`）。
- **G 入口收到 SIGTERM 后启动器弹安全模式。**入口收尾后以**数值** 143 退出，启动器只把
  「被信号杀死」当信号结局，143 当成异常退出。dsh 自己对 SIGTERM 是收尾后退出 0，所以 main
  上没有这个问题，是 Phase 1 引入的。修：`host-entry.ts` 收尾后摘掉处理器、用同一信号结束
  自己（SIGHUP 同理；只摘自己的处理器，渲染器经 signal-exit 挂的清理照常运行），启动器原样
  透传。

- **H 命令行首句提示在入口路径下丢失（用户真实终端确认）。**`dsh-tui --backend claude "首句"`
  两层原因：(1) `plugin.ts` 只从 `ctx.cmdlineArgs` 读首句，那是 dsh CLI 挂的，入口的裸根上
  没有，首句恒为空（同文件另两处都有 `?? process.argv.slice(2)` 兜底，唯独这里漏了）；
  (2) 即使读到，挂载时 `channel.submit` 交给的是占位会话，它按 5.3 拒收，消息停在 pending
  显示「Queued」，接管后无人重投。修：补 argv 兜底；channel 未就绪时订阅、`ready` 后再提交
  （启动会话接管，或打开失败后 `/new` 打开的会话）。连带：替身进程（/restart、/update、内核
  切换）带着原应用参数重起，会把首句再发一次（推断 main 的 DSH 路径同样如此，未实测）——
  `restartChildEnv` 给替身加 `DSH_TUI_LAUNCH_PROMPT_SENT=1`，plugin 见到即跳过首句。验收：
  `initial-prompt-held`（不发请求：首句到达入口、未就绪时不入队）；`live-initial-prompt`
  （`DSH_TUI_CLAUDE_LIVE=1`：首句发出、`/restart` 后不重发）。修复后用户在真实终端确认首句已发出。另注：用已发布的
  0.13.0 跑 `dsh-tui --backend claude …` 会把 `claude` 当成首句的一部分发给 DSH——那个版本的
  启动器还不认识 `--backend`（main 上已有、未发版），不是本分支的问题。

- **I 内核切换（Claude → DSH）后旧进程崩溃、新界面被甩到后台（用户真实终端发现）。**F 的同类：
  `Chat` 的迁移提示定时器在挂载 12s 后扫描其它 agent 的本地记录，近期用过（例如正在用 Claude
  Code）就 `channel.notify`；此时旧进程已释放根、只是留下来监督替身，读失效 channel 抛错，旧
  进程以 7 退出，启动器弹安全模式、结束等待，替身（入口 → dsh）成了后台孤儿，终端表现为卡住。
  第二个实例说明逐个定时器打补丁不可靠，改为类级：进程级守卫（`update-overflow-guard.ts`）
  加 `addProcessErrorAbsorber`，`runRestart` 释放根后登记一个只吸收「Channel UI lifetime has
  ended」的吸收器并记进 restart.log（`supervisor: late UI read after dispose ignored`），其它
  异常照旧崩溃。覆盖 /restart、/update 与内核切换，与内核无关（main 的 DSH 路径同样受益）。
  回归：`verify-update-overflow-guard` A4b（吸收、未命中照旧重抛、注销）；验收
  `kernel-to-dsh-*` 加「切换后 15s 旧进程仍在、无安全模式」（迁移提示是否触发取决于隔离 HOME
  里有无近期 agent 活动，所以这条主要防回退）。复现：模拟终端里切换后 2–6s 内 code 7，修后
  15s 进程链完整、restart.log 记一次吸收。

- **C 落地页没有通知区（用户决定按建议修）。**启动期 Enter / 命令被拒、会话打开失败在落地页上
  都是静默的；而新启动（非 resume）一律落在落地页，Phase 1「先挂载后打开」让「在落地页上等会话」
  成了常态，打开失败时用户只看到一个永远不就绪的落地页。修：(1) 落地页新增 `notice` 属性，
  Tips 行优先显示粘贴提示、其次 Chat 传入的最近一条 channel 通知（单行截断）；(2) channel 新增
  只读 `startupFailure`（启动会话打开失败的原因，接管或 `/new` 后清空，`ChannelUi` 契约同步），
  Chat 见到它就收起落地页，露出对话里的失败行与 `/new` 提示，落地页草稿移入对话输入框。用户
  决定：启动期间落地页上的「设置」「会话与工作区」等整屏入口**仍按 5.3 白名单拒绝**（现在会在
  Tips 行说明原因），不放开。回归：`verify-startup-adoption` 落地页一组加「提示在屏幕上」，新增
  `launchpad-failed` 一组（失败行与 `/new` 提示在屏、草稿移入输入框；去掉修复后变红），共 43 项。

**未修（用户决定暂不处理，或待决定）**

- **E 落地页丢键（用户决定暂不修）。**同一批输入里的多个编辑键只生效一个（连按或按住退格只
  删掉一部分；无头回归里也只能逐键喂）。不是 Phase 1 引入，影响按住重复键的用户。
- **J DSH → Claude 切换闪屏，之后界面落在主屏（main 同样，2026-10-07 已修；下面的根因判断有误，
  更正见下一节）。**原始字节：DSH 在 alt
  screen 里写完「Starting Claude…」后，旧 dsh 进程释放根时卸载了 React 树，`AlternateScreen`
  的卸载清理照常写 `?1049l`（旧进程不是替身，`adopting` 为假，不跳过）；替身按交接约定不再写
  `?1049h`，于是画在主屏上，内容进 scrollback。关掉入口分流（`DSH_TUI_HOST_ENTRY=0`，即 main
  的行为）同样复现，不是 Phase 1 引入。反方向（Claude → DSH）旧进程是入口、树不卸，没有这个
  问题。修法方向：交接持有 alt screen 期间（`keepAltScreen`）让 `AlternateScreen` 的清理跳过
  `EXIT_ALT_SCREEN`，标记要在释放根之前置上。验收 `dsh-to-claude` 的对应检查标为已知失败。
- **F 的同类问题（监督阶段已由 I 类级处理）。**根因是退出漏斗结束 channel 生命周期但不卸 React 树（卸树会跑
  `AlternateScreen` 的清理、写 `EXIT_ALT_SCREEN`，与内核切换时旧进程握住 alt screen 等替身的
  设计冲突），所以任何在此之后触发、读 channel 的定时器都会让旧进程崩溃。这次只找到求星这一
  个；类级修法可选：给 `ChannelUi` 加一个不抛错的存活查询供定时器自查，或在 detach 时卸树并让
  `AlternateScreen` 的清理感知交接。
- **启动器不转发 SIGTERM**（main 上同样如此）：`kill -TERM <启动器 pid>` 只结束启动器，子进程
  （入口或 dsh）留在终端上。清单第 4 项因此改为对入口进程发信号验收。

**DSH 空帧的根因（已查明，测试环境问题，不是产品缺陷）**：用户在真实终端里用隔离环境做
默认（DSH）启动同样卡住，于是确认此前所谓「PTY 下 DSH 链只画空帧」与 PTY 无关。判别：把已安装
的 0.13.0 原版放进同一个隔离 profile 也卡，换成本分支、发布文件对齐、schemastery 换回、预置真实
偏好都不解决。原因在 dsh 的「profile 解析路由」（`@deepseek-ai/dsh-app-boot`，接管 Node 的
模块解析，按 profile 安装时的解析表给共享依赖选副本）：手工拼的隔离 profile 与那张表对不上，
从全局安装位置运行的 dsh 把真实 profile 里 `react-reconciler` 的 `require('react')` 路由到了
**全局安装的 dsh-tui 启动器包里自带的 react**，进程里两份 React，树永远提交不了。同一份 dsh 只要
`lib/` 不在全局安装位置下（`node_modules` 仍链回）就路由正确。dsh 自己安装的 profile 不受影响，
所以用户的真实环境一直正常。修（测试侧）：`scripts/lib/isolated-profile.mjs` 新增 `dshBin`——
在隔离根下放一份 `lib/` 拷贝（约 92K）加链接、一个 `dsh` 小脚本；验收脚本与启动探针把它放在
PATH 最前。此后 DSH 一侧可以完整自动化：`kernel-to-dsh-*` 由「部分」升级为完整断言，新增
`dsh-to-claude`。（顺带：本机全局 dsh 的 `lib/bin.js` 被 dsh-purge 插入了一段只在 `DSH_HOME`
未设置时生效的 shim，与此事无关。）

**交接清单完成度**

| 项 | 状态 |
| --- | --- |
| 0 真实 pnpm 安装形态 | 用户决定暂不做（隔离 profile 是手工拼的，不能代替 `dsh plugin add`） |
| 1 启动：首帧、还在启动、本地命令、就绪后发送、失败提示与 `/new` | 自动化（就绪后真实发送需 `DSH_TUI_CLAUDE_LIVE=1`）；落地页一侧见 C |
| 2 `/kernel` 双向 | 自动化：两个方向的交接、画面、旧进程监督、退出恢复；Claude → DSH 无闪屏，DSH → Claude 有闪屏（J，main 同样；2026-10-07 已修） |
| 3 `/restart`、`/update` | `/restart` 自动化；`/update` 涉网络与下载，未做 |
| 4 启动期 `/quit`、Ctrl+C、`kill -TERM` | 自动化（TERM 发给入口进程，见上） |

**验证**（全部修复后）：`pnpm build`（89 项门禁全过）、`verify:package`；聚焦回归
`verify-startup-adoption`（43）、`verify-launchpad-onboarding-chat`（104）、`verify-launchpad`（210）、
`verify-exit-mouse-cleanup`、`verify-update-overflow-guard`、`verify-handoff-pty-gate`、
`verify-host-entry`（17）、`verify-launcher`、`verify-update`、`verify-shutdown-fallback`、
`verify:initial-prompt` 通过。验收 15 个用例 14 通过，唯一失败是已知的 J（main 同样）。CI 组：
input-terminal 全过；channel-ui 失败 `verify-activity-store`、`verify-settings-compat`、
`verify-compaction-progress`、`verify-splash-font-setting`，render-scroll 失败 `verify-splash-eggs`、
`repro-picker-windowing`——都在交接一节「main 上同样失败」的清单里。顺带改的测试夹具：
`verify-launchpad-onboarding-chat` 的假 channel 改按契约提供会过期的通知对象（原为字符串数组，
落地页读 `.text` 时为空），E5 改为「跳过提示先显示在 Tips 行、过期后首启文案回来」——此前这条
提示在落地页上根本不可见；`verify-startup-argv`（`verify:initial-prompt`）的沙箱补上替身标记常量与
已就绪的 channel。

### 2026-10-07 · 修 J：DSH → Claude 交接后不再掉回主屏

**根因（更正上一节的判断）**：不是旧进程卸载了整棵树——`detachForShutdown` 之后
`instance.unmount()` 本就是空操作。用 `DSH_TUI_DEBUG_MOUSE` 加栈抓到的链路是：旧 dsh 进程
`runRestart` 释放 Cordis 根 → DSH 的服务随根撤下，触发 `Chat` 再渲染一次 → 渲染里读
`channel.subscribe`，channel 生命周期已结束，抛「Channel UI lifetime has ended」→ Ink `App`
的根错误边界把 children 换成 `ErrorOverview` → 被删掉的 `<AlternateScreen>` 在清理里写
`?1049l`，此时替身还没画。入口作旧进程时释放根不触发这次重渲染，所以 Claude → DSH 没有
这个问题。这是 F、I 之后第三例「dispose 之后迟到的 UI 读」，前两例在定时器里、到了进程级
吸收器，这一例在渲染里、被错误边界吞掉。

**修（类级）**：退出漏斗 `detachForShutdown` 之后，终端由漏斗全权负责（该写的恢复序列它已
写完；内核切换时它有意不写 `EXIT_ALT_SCREEN`，把 alt screen 留给替身）。所以 Ink 的
`writeRaw`（`<AlternateScreen>` 等经 `TerminalWriteContext` 写控制序列的唯一出口）与 `App`
的同名出口在 detach 之后丢弃写入（`DSH_TUI_DEBUG_MOUSE` 下记一行）。与 B（detach 后不再开
raw 模式）是同一道闩。顺带覆盖普通退出：迟到的重渲染不会再在主屏上多写一次 `1049l`（tmux 下
会恢复保存的光标位置，压掉退出提示，`detachForShutdown` 注释里记过这类问题）。正常
`unmount()` 路径不经这道闩，行为不变。错误边界随后的 `handleExit` 落到已 detach 的
`unmount()`，空操作。

**回归**：`verify-exit-mouse-cleanup` 第 6 节——`<AlternateScreen>` 下的组件在 detach 后抛错
进根边界，断言 detach 后没有 `EXIT_ALT_SCREEN`；对照组不 detach，断言有（证明这次删除确实
会写）。去掉修复后第 6 节变红。验收 `dsh-to-claude` 的「交接后仍在 alt screen」改为正式断言；
`accept-host-entry.mjs` 透传 `DSH_TUI_DEBUG_MOUSE`（日志在隔离根的 `.dsh-tui/mouse-debug.log`，
配合 `--keep`）。

**验证**：验收 15 个用例全过；`pnpm build`（89 项门禁）、`verify-exit-mouse-cleanup`、
`verify-handoff-atomic`、`verify-handoff-pty-gate` 通过；CI 组 input-terminal 31 项全过，
render-scroll 79 项中失败的 `verify-splash-eggs`、`repro-picker-windowing` 是 main 上就有的
既有失败。修在旧进程一侧，与入口分流无关，`DSH_TUI_HOST_ENTRY=0`（main 的路径）同样受益。

### 2026-10-07 · Phase 2 规划：调研结论与分块

（写于交接一节之后。）两份代码调研（宿主 dsh 0.2.0-rc.2 的 `runProfile`；`plugin.ts` 的分相与
`ctx` 用法）推翻了正文的几个前提，先记结论，再给分块。**根模型（单根 / 两根）不在本节拍板，
由 2.2 的 spike 定；TuiHost（5.1）的去留随之定。**

**调研结论**

1. **`runProfile` 必然两根。**签名 `runProfile({ environment, profile, resolvedProfile?,
   fromDefaultProfile?, patchFiles, args, packageManager? }): Promise<{ ctx, shutdown }>`，
   `boot()` 后即返回（不等应用退出）。`boot()` 永远 `new Context()`，不能传入已有根，唯一注入点
   是组合前的 `prepare`。所以「用 `runProfile`」=「TUI 根与 DSH 根并存」= 要桥接 14 个 `tui*`
   服务、决策守卫两边装、`tui/*` 事件两条总线、全部按 `compositionRoot(ctx)` 键的 WeakMap
   （`adapterRuntimeFor`、`bindQuestionStore`、`bindApprovalStore`、`registerTuiChannel`、
   各 `tui*` runtime、本地 settings sections、command attribution）。
2. **单根的漂移面比 5.4 写的时候小。**`dsh-app-boot` 导出 `boot`、`mountRootInclude(ctx, …)`
   （收调用方的 ctx）、`auditStartupEntries`、`installFailLoud`（可传假 `proc`、返回卸载函数）、
   `PluginPackages`、`readProfilePatches`、`createRuntimeResolution`；`dsh-cmdline` 导出
   `provideCmdline`。只有 `createProcessShutdown`（约 40 行）不导出。「TUI 自己的根当 DSH 根、
   复刻 `prepare`」成为可比较的候选：`tui*` 服务、守卫、WeakMap 全部原样工作，第三方插件不需要桥。
   代价是复刻 `runProfile` 的组合步骤（profileContext、launch environment、PluginPackages、
   cmdline、代理、appReady、审计），跟 DSH 版本走。
3. **模块身份是判别约束。**宿主 dsh 的 `cordis` 4.0.4 **嵌套**在
   `@deepseek-ai/dsh/node_modules/` 下，`host-entry.ts` 用的是本包解析到的那份。两根模型下两份
   cordis 几乎必然是两个模块实例（`Service`/`Context` 的 `instanceof`、跨根 `ctx.set`）；单根
   模型下入口建根必须改用宿主 realpath 的 cordis。更深一层：`createRuntimeResolution`（app-boot
   的解析劫持）在 `prepare` 里才装，Phase 2 下 TUI 模块在劫持**前**加载、DSH 侧插件在劫持**后**
   加载，react / schemastery 可能被路由成两份——正是 Phase 1 验收里「两份 React、树提交不了」
   那一类故障。
4. **5.5「进程所有权没有新问题」不再成立。**`runProfile` 装 `SIGTERM → interrupt(0)`、
   `SIGINT → interrupt(130)`（dispose 后 `process.exit`，超时 5s 强退）与 `installFailLoud`，
   **不可关闭、不摘除**；入口自己也装了 SIGTERM/SIGHUP。两套并存时一次 SIGTERM 触发两个
   dispose 再 `exit`，终端恢复与 fd 3 ACK 的顺序没有保证。另：`loadLayeredEnv`（把 `.env` 层写进
   `process.env`）在 `bin.js` 里、不在 `runProfile` 里，入口要自己先调；`resolvedProfile` 仍会重写
   `<profile.dir>/cordis.yml`（空根）；`args` 即 `ctx.cmdlineArgs`；`bin.js` 开头有一段按脚本位置
   设 `DSH_HOME` 的 shim。
5. **入口路径下全部 `tui*` 缺席。**`apply` 从不注册任何 `tui*` 服务，它们只由 patch 行
   （`dsh-tui-workspaces` … `dsh-tui-extensions`，cordis.patch.yml 318–363）插入；Phase 1 入口里
   走本地回退（`createLocalWorkspaceRuntime`、`getLocalSettingsSectionsHost`、channel 私有授权存储、
   静态主题 JSON），插件对话框 / 状态 / 面板 / 场景关闭。`resolveCoreHost` 仍在构造时快照。
6. **D1 的现状**：`createChannel` 只在构造时会话已是 DSH 时 `attachDshExtensions`；`adoptStartup`
   接管的会话即使是 DSH 也不挂扩展；`core.extend` 在 `start` 后抛（compose.ts 924）；
   `attachDshExtensions` 构造时读 `dshChannelBinding(core.binding).agent`，并把 ctx 传给约 20 个
   动作工厂，监听 `commands/change`、`agent/request`、`inject(['jobs'])`。
7. **今天用 TUI ctx 挂到 DSH 服务上的**：`ctx.plugin(toolAskUser)`、`system-prompt/assemble`、
   问卷应答器、`approval/request` 与 `session/event` 监听、`startSessionMountHeartbeat`、
   `refreshLastRunRecord`、退出漏斗对 `ctx.root.fiber` 的 dispose。两根模型下全部要改到 DSH ctx。
8. **本仓库没有 `@deepseek-ai/dsh` 依赖**（不在 dependencies / devDependencies / `.pnpm`）；
   `pnpm-workspace.yaml` 177、216 行的 app-boot / cmdline allowlist 仍是 0.1.x 旧范围。
9. **Phase 1 遗留（待核实）**：退出漏斗崩溃分支的 `writeResumeMarkers`（plugin.ts 约 1786 行）
   无条件 `ctx.agents.get(...)`，裸根上 `ctx.agents` 不存在，Claude 内核经入口崩溃时会在收尾里
   二次抛，可能吞掉崩溃行或打乱终端恢复。2.1 之前用一条无头复现确认再修。

**分块**（每块完成即在本节下追加记录；正文 5.1 / 5.4 / 5.5 / §4 / 第 7 节随实现修订）

| 块 | 内容 | 验收 |
| --- | --- | --- |
| 2.0 | 核实并修上面第 9 条 | 无头复现：入口路径下渲染期抛错，退出码、崩溃行、终端恢复 |
| 2.1 | **D1，与根模型无关**：`adoptStartup` 接管时允许挂一次扩展（`extendOnAdopt` 之类的单次窗口，`start` 后其余 `extend` 仍抛）；`attachDshExtensions` 对 `binding.agent` 的读取延后到挂载时；扩展收的 ctx 与 channel host 分开传 | `verify-backend-channel` / `verify-startup-adoption` 加「占位会话 → 接管 DSH 会话 → 扩展动作可用（model / mode / resume / 审批）」，假 ctx 无头；失败即触发 D2 讨论 |
| 2.2 | **根模型 spike（时间盒，两条都做）**。单根：入口用宿主 cordis `new Context()` → 渲染 → 复刻 `prepare` → `mountRootInclude` 挂 dsh-tui profile，看 `tui*` 行能否插进已渲染的根、审计是否通过、复刻了多少非导出内部。两根：`runProfile` 起 DSH 根，桥接行把 TUI 根的 `tuiPanels` 同名暴露进 DSH 根，一个示例插件 `inject: ['tuiPanels']` 注册面板并在卸载时随 fiber 清理 | 判别项：(a) 在真实 profile 里从本包与从宿主 dsh 分别 resolve cordis / react / schemastery，劫持装上前后各一次，是否同路径、单实例；(b) 同步冻结时长（6.1）；(c) 复刻 / 桥接的代码量与依赖的非公开接口数。结论与数字写进本节，由用户决定根模型 |
| 2.3 | plugin.ts 拆分：DSH 专属相（预设、问卷 / 提示接缝、`resolveAgent`、工作区挂接、活动 / 上下文 store、审批、心跳、退出漏斗的 DSH 分支）抽成 `openDshStartup(dshCtx, …)`；`dsh-tui` 行「有入口槽就只做 DSH 侧、无槽走旧路径」——同时回答第 10 节第 4 条 | profile 路径（`DSH_TUI_HOST_ENTRY=0`）行为零变化：CI 组与现有聚焦回归 |
| 2.4 | 入口 DSH 路径：能力探测成功时进程内加载，失败或 `DSH_TUI_HOST_ENTRY=0` 时照旧 `delegateToDsh`；冻结前画「正在启动 DSH」静态态；入口先调 `loadLayeredEnv`、保留 `DSH_HOME` shim 语义、应用参数进 `cmdlineArgs` | `probe-startup-baseline --backend dsh --entry host`：首帧对比 Phase 0 基线与预载分支 |
| 2.5 | 信号 / 退出所有权（第 4 条）：单根下由入口统一装；两根下入口在 `runProfile` 前摘自己的处理器，DSH fiber dispose 的 effect 先走 TUI 退出漏斗 | `accept-host-entry.mjs` 加 DSH 内核用例：SIGTERM / `/quit` / Ctrl+C / `/kernel` 两向 / `/restart`，终端恢复、ACK、无遗留进程 |
| 2.6 | 契约与门禁：`@deepseek-ai/dsh/profile-boot`（或单根所需的 app-boot / cmdline 导出）进 `contract.ts` 与能力探测；宿主 realpath import 只许在 `src/dsh-adapter/`（`verify:boundary`）；allowlist 旧范围 | `verify:contract` 覆盖探测与回退；加依赖本身是第 10 节第 7 条，**等维护者决定** |
| 2.7 | 验收：第三方插件三样例（主题、面板、`tui/input` 拦截）在新路径下工作；单实例断言（cordis、react） | 写进 `accept-host-entry.mjs` |

顺序：2.0 → 2.1 与 2.2 并行（2.1 不依赖根模型，且最早给出 D1/D2 的实证）→ 用户定根模型 →
2.3 → 2.4 / 2.5 → 2.6 / 2.7。单根若成立，5.1 的 TuiHost 与「桥接行」会像 Phase 1 那样不再必要，
2.3 退化为「`dsh-tui` 行在入口槽存在时跳过渲染、把 DSH 会话交给已挂载的 channel」；两根则按
正文第 3 节终态做。

### 2026-10-07 · Phase 2 第 2.1 块：DSH 扩展晚挂（D1）

（写于交接一节之后。）**结论：D1 可行，不触发 D2。**`extensions.ts` 的逻辑没改（只改注释）。

- `core/compose.ts`：新增单次窗口 `extendOnAdopt(hook)`（只能在 `start` 前注册一次）；`extend`
  的守卫改为 `started && !adoptWindow`。`start()` 里内联的动作表抽成 `coreDelegates()` +
  `installActions(replace)`——`commandCompletions` 在安装时按 `extension.completions` 计算，晚挂后
  必须重装。`attachOnAdopt(candidate)`：取出并清空钩子 → 开窗、调钩子、关窗 → 扩展有变化则
  `installActions(true)` 并跑新扩展的 `start.before/after`。位置在 `adoptStartup` 尾段
  `controls.reset()` 之后、`ready = true` 与 `feed.bind` 之前。
- `action-readiness.ts` 加 `reinstall`；`core/actions.ts` 的 `installChannelActions` 加 `replace`。
- `core/session-switch.ts`：`createBackendOpener` 加可选 `attach(candidate)`，`adoptWith` 在
  `resetControls()` 后、`bind` 前调用——启动失败后 `/new`、`/resume` 打开的 DSH 会话同样挂扩展。
- `channel.ts`：构造时即 DSH 会话照旧（profile 路径零变化）；否则有 `options.startup` 时注册
  `extendOnAdopt(adopted 为 DSH 时 attachDshExtensions(core, ctx, …))`。扩展用的 Cordis ctx 只在
  这一行传入，两根模型下换成 DSH 根的 ctx 即可。

**关键取舍**

- `binding.agent` 等的「延后读取」靠延后调用实现：`attachDshExtensions` 在 `binding.adopt` 尾段
  运行，此时 binding 已指向 DSH 候选会话，约 20 个工厂的读取天然是挂载时读取。
- 尾段顺序是硬约束：核心先写身份、cwd、能力快照、命令表，再挂扩展，扩展写的值（`agentId =
  agent.id`、DSH 能力、带标注的命令表、`subagentControl` / `jobControl`）总是赢；挂在 `feed.bind`
  之前，扩展的 `agent/request` 监听与 bind 钩子早于会话第一个事件。扩展挂载时自己重放
  `rawHistory`，`ownsSessionFacts` 为真，`feed.bind(history)` 忽略 seed，不重复绘制。
- 与构造路径的一处顺序差异：晚挂时 `start.before` 在 `startHostSubscriptions` 之后（只有 settings
  sections、scenes 两项订阅，已核对无关）。
- 挂扩展抛错按既有尾段失败处理（关候选、`owner.dispose()`，最终 unhandled rejection，响亮）。

**5.3 延后字段逐项**：`backendLabel`——由扩展覆盖，不用改（但启动失败行在挂扩展前取值，DSH
占位会话要在 2.4 传 `backendLabel`，否则显示小写 `dsh`）；`messaging` / `subagentControl.history`
——Phase 1 已按会话构造，DSH 整体替换；`defaultOpeners`——opener 活读
`extension.newSession ?? defaultOpeners`，挂上后下一次 `/new` 自动走 DSH；`snapshotOf` 的
`dsh:false`——靠尾段顺序由扩展覆盖；working-activity——按 bind 判断，晚挂的 DSH `bind` 整体替换
它的 `onBind`，与 profile 路径等价（DSH 会话本就不挂它）。

**窗口语义**：在第一次成功接管真会话时消耗（启动接管或失败后的 `/new` / `/resume`）；启动期
`/new` 抢先则 `/new` 消耗、迟到的启动会话照旧被 `prepare` 关掉；首个会话是 Claude 也消耗，之后
`extend` 照抛。

**回归**：`verify-backend-channel.ts` +15 项（176 → 191）：占位会话接管 DSH 会话 8 项（agent id
刻意不等于 session id；能力快照与命令表与构造时 DSH channel 逐字节相同；listModels / providers /
presets / efforts / resumeTo / permissionPresets / agentViewRows / cycleMode 的结果与提示一致）；
失败后 `/new` 打开 DSH 会话 3 项；窗口语义 3 项。去掉修复后三组分别变红（去掉 `channel.ts` 钩子 →
`agentId` 错；去掉 opener `attach` → `/new` 组红；去掉 `installActions(true)` → 动作提示变成核心的
「Not supported by this kernel」）。

**验证**：`pnpm build`（89 项门禁）通过（中途一次 `verify:overlay-occlusion`、`verify:btw` 在并行
负载下红，单跑各 3/3 绿、最终 build 绿）；channel-ui 组 147 项失败 4 项，均在既有失败清单内；
`verify-startup-adoption`（43）、`verify-channel-composition` 通过。

**遗留（交给后续块）**

1. 两根模型下：`attachDshExtensions` 还从 core 的 `ChannelHost`（TUI 侧）读 `adapterRuntime`、
   `workspaceService`、`commandTrees`、`currentGrantStore`，要跟着改；单根不用。
2. 2.4：DSH 占位会话传 `backendLabel`；失败后首个 `/new` 经 `options.openSession` 打开，绕过 DSH
   扩展 `newSessionOpener` 的 preset、mount 预留与工作区所有权——DSH 内核的 `openSession` 要自己处理。
3. 新用例在裸 ctx（无 llm / agents 服务）上证明「走 DSH 实现且与构造路径等价」，真实服务下的晚挂
   留到 2.4 / 2.5 验收。

### 2026-10-07 · Phase 2 第 2.2 块：根模型 spike

（写于交接一节之后。）spike 代码一次性，留在 worktree
`/home/moment/Code/working/dsh-TUI/.claude/worktrees/agent-aeb8deb9c2504a266`（未提交）的
`scripts/spike-2.2/`：`measure-identity.mjs`、`single-root.mjs` / `run-single.mjs`、`two-root.mjs` /
`run-two.mjs`；`plugin.ts` 只在 `apply` 顶部加了一个 `__DSH_TUI_SPIKE_SLOT__` 槽。A、B 都跑在隔离
profile 上（`isolated-profile.mjs` 的 `dshBin`，排除 dsh-purge）；真实 profile 只做只读解析，未被
写入（mtime 已核）。机器：3 亿次空循环空载约 1.8s。**spike 建议单根；待用户决定。**

**C(a) 模块身份**

| 包 | 从 profile 内的 dsh-tui 解析（劫持前 = 劫持后） | 从宿主解析 |
| --- | --- | --- |
| cordis | 宿主嵌套那份（经 `~/.dsh/profiles/node_modules` 链接） | 同一份 |
| react / react-reconciler | profile 本地 19.3.0 | 宿主不用 react |
| schemastery | 真实 profile 本地 3.18.2；隔离 profile 为宿主 3.18.4 | 宿主 3.18.4 |

- 产品形态下 cordis 只有一个模块实例；react 只有一份（宿主解析表里 react 指向全局 dsh-tui 启动器包
  自带的那份，但 profile 内模块先命中本地）。schemastery 在真实 profile 上本就两版本两实例（`.cjs`
  与 `.mjs` 各一份），今天的 dsh 路径同样如此，不是新问题。正文 5.4 担心的「两份 cordis」只在
  worktree 开发布局里出现。
- **新发现（Phase 1 就有）**：profile 的 `pnpm-workspace.yaml` 是 `autoInstallPeers: false`，profile
  里没有任何 `@deepseek-ai/*` peer。去掉 `<DSH_HOME>/profiles/node_modules`（本机此目录 9 月 18 日
  建、全是宿主依赖的 scoped 链接，创建者**未确认**）后，劫持前解析 cordis 得 `ERR_MODULE_NOT_FOUND`，
  Phase 1 的 `plugin.js` 报 `Cannot find package '@deepseek-ai/dsh-session'`。即：**Phase 1 入口在
  没有这个链接目录的机器上起不来**；入口必须先装宿主的解析劫持（`PluginPackages`），再 import 任何
  TUI 模块。单根、两根都要这样做，也顺带修掉这个问题。「先挂界面、再复刻 prepare」的顺序因此改为
  「先劫持、再挂界面、再组合」。入口装一次劫持、`runProfile` 再装一次，实测不报错。

**A 单根：端到端跑通**

顺序：宿主 realpath 的 cordis `new Context()` → 复刻 `boot()` 前置四步（`ctx.baseUrl`、
`provide('dshHomePath')`、`internal/update` 的 prepend 全局监听、`plugin(Loader)`）→ 复刻 `runProfile`
的 prepare（`PluginPackages` 劫持等）→ import TUI 模块、Phase 1 的 `apply` 渲染（Claude 内核，假
claude，打开失败）→ 同一根上 `mountRootInclude` → `loader.await` → `auditStartupEntries`。

- 屏幕上是完整界面（启动台、失败行与 `/new` 提示、输入框、状态栏）；审计通过；13 个 `tui*` 行服务
  全部插进已渲染的根；dsh-tui 行经槽跳过渲染，拿到的就是入口的根，`agents.create` 成功。
- 首帧（从 spike 模块开始执行算）：宿主模块 39ms；劫持链约 217ms（`createRuntimeResolution` 约
  60ms，真实 profile 上 185ms；`PluginPackages` 约 30ms）；TUI 模块图 675–754ms；渲染完成约
  990–1105ms。真实环境估计多 300–350ms 劫持前置，仍早于 Phase 1 入口的约 1.35s。
- 唯一注册冲突：入口 `apply` 自己 `new UserQuestionService(ctx)`（plugin.ts 约 369 行），profile 的
  `user-questions` 行随之报 `service "userQuestions" has been registered`（非必需行，审计只警告）；
  同处 `ctx.plugin(toolAskUser)` 可能与 profile 的 ask-user 行重复。归 2.3。
- 未测：构造时快照的服务（`resolveCoreHost` 的 `tuiThemes` 等、plugin.ts 约 505 / 2079 行的
  `tuiStatus` 等）在组合后需要重新解析（`tuiPanels` 走模块级 store，不受影响）；入口 channel 接管
  DSH 会话（2.1 已做 channel 侧，真实根下归 2.3 / 2.4）。
- 开放项：UI 模式下根收尾约 20s（headless 46ms），卡在建会话之后、`fiber.dispose` 附近，原因未查，
  判断与根模型无关，2.5 要查。

**B 两根：能接上，代价是结构性的**

- 产品形态（同一份 cordis、同一份 dsh-tui 模块）：朴素 `provide` + `set` 能把服务放进 DSH 根，但示例
  插件 `register` 被 TUI 自己的守卫拒绝（`tuiPanels.register requires a live non-root plugin
  activation`）。2a 每个调用方在 TUI 根开 fiber：`tuiCtx.plugin` 抛 `root.plugin is unavailable from
  a plugin activation`，改用内部 `withHostRootCapability` 才通，且注册结果晚一个 tick（同步 API 语义
  变了）；2b 共享桥接 fiber 同步转发：DSH 插件的 ALS 令牌被判 stale；2c 在 2b 上加
  `AsyncResource.bind` 重入：通。2a / 2c 的注册都随示例插件 fiber dispose 清掉。
- **能用的桥全部丢插件身份**（pluginId 变成兜底的 `act1`/`act2`）：每插件配额、effect ledger 归属、
  `tuiPluginStorage` 按身份分的命名空间都会错——正确性问题。
- `runProfile` 给 SIGTERM、SIGINT、unhandledRejection、uncaughtException 各加 1 个匿名监听，摘不掉
  （实测 0 → 1）。单根不调 `runProfile`，`installFailLoud` 由入口装并可卸载。
- 推广工作面：`tui*` 服务实际 **15 个**（比正文多 `tuiToast`、`tuiMessageObserver`、
  `tuiPluginStorage`），约 60 个公开方法，桥接本体估 600–900 行；另需身份转发、守卫语义重定义（61 处
  调用点 / 17 个文件）、根映射（`compositionRoot` 37 处 / 23 个文件）、6 个 `tui/*` 决策事件双总线。

**C(b) 同步冻结**（10ms 打点最大间隔，`monitorEventLoopDelay` 对照）：A headless 组合 1295–1436ms、
最大单段 803–904ms（含首次加载 TUI 模块图）；A-UI（TUI 已加载）组合 984–1075ms、最大单段
764–844ms；B profile 组合 830–879ms、最大单段 647–691ms（B 禁了 dsh-tui 与 panels 两行，不对等）。
**冻结由 DSH 插件图同步加载决定，单段 0.65–0.9s，与根模型无关**（6.1 不变）。

**C(c) 代码量（单根）**：spike 胶水约 45 行；对应上游逻辑约 210 行（`runProfile` 约 65、
`composeProfile` 约 12、`createAppReady` 约 20、`createProcessShutdown` 约 55、`boot()` 约 57）；
生产版估 140–160 行。需手抄的未导出：`createProcessShutdown`、`createAppReady`、`composeProfile`、
`boot()` 前置四步。须从宿主嵌套 `node_modules` 按 realpath 取的公开包 8 个：cordis、dsh-app-boot、
cordis-plugin-loader（须与 app-boot 同实例，经 app-boot 的 `createRequire` 解析）、dsh-home-paths、
dsh-launch-environment、dsh-cmdline、dsh-http-proxy、`dsh/profile-boot`。用到的导出：
`loadLayeredEnv`、`createRuntimeResolution`、`PluginPackages`、`installFailLoud`、
`readProfilePatches`、`mountRootInclude`、`auditStartupEntries`、`prepareProfile`、`INSTALL_ANCHOR`、
`PROFILE_ROOT_FILENAME`。

**单根的风险**：复刻面随 DSH 版本漂移（约 210 行上游逻辑，需进 `verify:contract` 版本线与能力探测）；
8 个宿主嵌套包按 realpath 取；首帧多 300–350ms 劫持前置；已渲染界面对快照服务要重新解析；真实根
下的会话接管未验证。

**决定（2026-10-07，用户）：选单根。**下面的影响据此生效，正文 5.1 / 5.4 / 5.5 / 第 3 节在 2.3 起随实现修订。

**单根对设计与后续块的影响**：5.1 TuiHost 与第 3 节的桥接行不再必要；5.4 改为「复刻 prepare +
`mountRootInclude`」；5.5 恢复「进程所有权归入口」；2.3 退化为「去掉入口自注册的
`userQuestions` / `toolAskUser`、快照服务改实时解析、`dsh-tui` 行在入口槽存在时只把 DSH 会话交给已
挂载的 channel」；入口顺序改为「劫持 → 挂界面 → 组合」，Claude 内核也走劫持（顺带修掉 profiles
链接目录依赖）。

### 2026-10-07 · Phase 2 第 2.0 块：入口崩溃收尾的 `ctx.agents` 读取

（写于交接一节之后。）**核实：问题存在，但比预想轻。**裸根上 `ctx.agents` 不存在，崩溃分支的
`writeResumeMarkers` 第一句 `ctx.agents.get(...)` 抛 TypeError，于是 Claude 的 resume marker
（`setLastSession`）与 `refreshLastRunRecord()` 都被跳过：用户发过消息后崩溃，启动器的崩溃重试会
打开旧会话或空会话。`runCrashExit` 把它包在 try/catch 里并无条件 `finish(crashLine)`，所以崩溃行、
终端恢复、退出码 1 都不受影响（规划时「吞掉崩溃行、打乱终端恢复」的推测不成立）。

- 修：闭包抽成导出函数 `writeCrashResumeMarkers(deps)`（plugin.ts），按 `backendStart` 分支，与
  update / restart 分支同构：DSH 仍 `ctx.agents.get` + `isExitResumable` 写 `resume.txt`；非 DSH 在
  `persisted` 时 `setLastSession`；两者最后都 `refreshLastRunRecord()`。崩溃仍从不清除 marker。
- 回归：`scripts/verify-shutdown-fallback.tsx`（已在 CI 组）加 Case E（入口形态：裸 cordis 根 + 真实
  `runCrashExit`）、Case F（DSH 形态不变）与一项源码检查，共 24 项；修前 E 组 3 项红。
- 其余无守卫读取逐项核过（`refreshLastRunRecord`、干净退出分支、`resolveAgent`、心跳、审批监听、
  `userQuestions` / `tui*` 可空读取、`ctx.root.fiber`），崩溃分支是非 DSH 路径唯一可达的一处。
- 在独立 worktree 做完后以补丁合入，与 2.3 无冲突。

### 2026-10-07 · Phase 2 第 2.3 块：单根接线

（写于交接一节之后。）**结论：单根接通，无根本障碍。**`DSH_TUI_HOST_ENTRY_DSH=1`（实验开关，
`DSH_TUI_HOST_ENTRY=0` 时不生效）下入口按「劫持 → 挂界面 → 组合」跑 DSH 内核：首帧先出，profile
组合进同一个根，`dsh-tui` 行见到入口槽不再渲染、只做 DSH 侧，channel 接管它交来的 DSH 会话。开关
未设时 DSH 照旧 `delegateToDsh`；Claude 内核只多了劫持前置，**`~/.dsh/profiles/node_modules` 依赖随之
消失**（验收在去掉该链接的隔离 home 里全过）。

**结构**

- 新 `src/dsh-adapter/host-dsh.ts`（366 行）：`locateHostDsh`（PATH 上第一个 `dsh` 的 realpath，向上找
  `@deepseek-ai/dsh`）；`loadHostDsh`（8 个宿主包按 realpath 以 file URL 动态导入，本地结构类型 +
  导出逐个检查，无静态 import）；`prepareHostRoot`（`loadLayeredEnv` → `prepareProfile` →
  `createRuntimeResolution` → 宿主 cordis `new Context()` → `PluginPackages`；DSH 内核再加代理、
  `boot()` 前置四步、`installFailLoud`（保留卸载函数）、profileContext、launch environment、
  `provideCmdline`（args = 应用参数，exit 接复刻的 `createProcessShutdown`））；`compose()`
  （`mountRootInclude` → `loader.await` → `auditStartupEntries` → `appReady.commit`）。复刻的上游逻辑约
  105 行（`createAppReady` 22、`createProcessShutdown` 只复刻 `shutdown` 半边 24、其余约 58），文件头有
  逐段对照 0.2.0-rc.2 的表。**刻意未复刻**：`runProfile` 的 SIGTERM/SIGINT 与 `interrupt`；`boot()` 的
  StartupError 启动日志捕获；`--patch` overlays 与 `--from-default-profile`；bin.js 的 `DSH_HOME` shim。
- 新 `src/dsh-adapter/entry-slot.ts`：`Symbol.for('@deepseek-harness-tui/dsh-tui:host-entry')` 槽
  （`rowSeen`、`attachDsh`、`composeWarning`、`composeFailed`）。
- `host-entry.ts`：路由判定（只依赖 node 内置与 yaml）留在劫持之前，`delegateToDsh` 不付劫持代价。
  `runInEntry(kernel)`：宿主根 → `entry-hijacked` → 动态 import TUI → 发布槽、推迟守卫 →
  `apply(..., entrySlot)` → `entry-compose-start` → `compose()` → `entry-compose-end` → 无行则
  `composeFailed`。宿主不可用时 DSH 回 `delegateToDsh`、Claude 回 Phase 1 形态（静默，只有
  `DSH_TUI_DEBUG` 才提示）。SIGTERM/SIGHUP 处理照旧。
- `index.ts`（行 apply）：有槽时标 `rowSeen`，`loader.await` 之后起 `dsh-tui-runtime` 子 fiber 调
  `attachDsh`，不渲染；无槽完全走旧路径（第 10 节第 4 条：直启路径保留，代价是这一分支）。
- 启动器、`restartArgv`（`dshInEntry`）认新开关；`docs/configuration*.md` 与 guide 副本加一行。

**两处单根特有问题（已修，需重点关注）**

1. **根能力守卫与 DSH 插件冲突。**TUI 的 host-access 守卫挂载时就装，DSH 插件激活时要用根能力
   （`UserQuestionService` → `TypertRemoteService` → `ctx.accessor` → 根 fiber `effect`），报
   `root.effect is unavailable from a plugin activation`。修：`deferRootCapabilityGuard(root)`，入口挂载前
   推迟守卫、`compose()` 的 finally 里放开；fiber 追踪照常立即开始。**注意这是一处放宽**：profile 路径
   下守卫在 TUI 行加载时（组合中途）装上，之后激活的第三方行受守卫；单根下整个组合期间都不受守卫，
   第三方插件在 apply 期间可用根能力（组合结束后的调用照常受守卫）。2.7 的守卫验收要覆盖，必要时改为
   「只对 DSH 官方行放行」。
2. **事件循环同步卡住约 10s。**DSH 的 `node-addon-system/flock` 用 `process.report.getReport()` 判 libc；
   单根下界面先挂、进程里已有 socket（更新检查等），报告对 socket 端点做反向 DNS，同步卡住
   （cpuprofile：`getReport` 自身 10019ms）。修：入口设 `process.report.excludeNetwork = true`（两个内核
   都设，进程级）。修后接管约 300ms。profile 路径不受影响，但「先开 socket、再首次 flock」都会触发，
   可报上游。

**plugin.ts 的 DSH 相延后**（`RuntimeApplyOptions.entrySlot`；profile 路径各段原位调用、顺序不变）：
预设抽成 `installPresets(ctx)`；问卷接缝里 `QuestionStore` 与 bind 留入口（Chat 与 Claude 也用），其余
（`userQuestions ?? new UserQuestionService`、`toolAskUser`、`system-prompt/assemble`、
`registerPromptDebug`、`prepareQuestionAnswerer`）抽成 `mountDshQuestionSeams(dshCtx)`，消掉 spike 的
`userQuestions` 重复注册；审批抽成 `mountDshApprovals`；工作区归属抽成 `attachWorkspaceOwnership`；
`resolveAgent` → 归属 → `createDshSession` 在 attach 里用行的 Config 做，完成后 resolve 入口创建的
startup Promise（带 `route`、`agentPreset`），失败 reject → 「打不开 + /new」两行；activity /
occupancy store 靠根上 `inject(['sessionProjections'])` 自然延后（实测组合期间触发）；心跳每拍读
`agents`，不用改；`refreshLastRunRecord` 与干净退出分支改用守卫过的 `liveDshAgent()`。占位会话
`createStartingSession('dsh')`、`backendLabel: 'DSH'`（2.1 遗留 2 的前半）。channel 侧：`ChannelStartup`
带可选 `route` / `agentPreset`，`adoptStartup` 挂扩展前写 provider / model / preset。

**晚到服务的实时解析**：Chat 的 dialogs / status / shortcuts / bonusNotices / themeHost 与 ThemeProvider
改为 `buildChat()` / `buildTree()`，attach 时 `instance.rerender()` 一次（React 保留状态）；toast 重新
`setSink`；TUI 的 `/settings` 分区 `rehomeSettingsSection` 搬到组合出的 sections 服务；`tuiPluginHost`
每次探测读；`resolveCoreHost` 六项改 getter，订阅随 `internal/service` 重绑（新可选
`ChannelHost.watchServices`）；renderer / workspace service 按事件 / 调用读。**遗留**：ThemeProvider 只在
挂载时判断 forced theme，持久化选了组合后才注册的运行时主题会落回 auto；占位期状态栏显示入口算的
路由，接管后才换成行的路由。

**验证**：`pnpm build`（89 项门禁）、`verify:package`、`verify-guide` 通过；input-terminal 31/31；
channel-ui 147 项失败 4 项、render-scroll 79 项失败 2 项，均为既有；session-workspace 56 项失败
`verify-update-checksum`（HEAD 上同样失败，计时断言）。聚焦：startup-adoption 46、backend-channel 191、
host-entry 19、launcher、tui-settings 20、adapter-channel、claude-channels、handoff-*、shutdown-fallback
通过。途中因源码文本契约变红又修好：settings-namespace、launchpad LR4（计数 5→6，attach 多调一次
`refreshLastRunRecord`）、workspace-attachment。**`accept-host-entry` 18/18**：原 15 个在无链接 home 里
全过（`startup-fullscreen` 显式断言链接不存在，`--legacy` 可加回）；新增 `dsh-in-entry-chat` /
`-landing`（首帧、`render-start` 只一次、`row-apply` 与入口同 pid、首帧早于组合、接管 DSH、`/settings`
有 dsh-tui 分区、`/quit` 0、终端恢复、无遗留进程）与 `dsh-in-entry-quit-early`。spike 的约 20s 收尾
未复现（三个用例全程 2–6s）。2.0 补丁合入后复跑 `pnpm build` 与 shutdown-fallback、startup-adoption、
crash-detail、exit-resume-marker 通过。

**数字**（3 轮中位数，ms，从 spawn 启动器起算；本轮空循环写法不同，与此前环境速度不可比，同轮内可比）：

| 场景 | 劫持完成 | 首帧 render-done / prompt | 组合区间 | 可发送 |
| --- | --- | --- | --- | --- |
| 入口 DSH | 291 | 1048 / 1154 | 1074–1887（同步冻结约 810） | 2275 |
| profile DSH（今天） | — | 2140 / 2268 | — | 2140（首帧即可发送） |
| 入口 Claude | 285 | 1056 / 1206 | — | 1622 |

读法：DSH 内核首帧提前约 51%（2140 → 1048），可发送晚约 135ms（2275 vs 2140），即「先画后冻」的代价；
劫持前置约 140ms。

**交给后续块**

- 2.4：宿主定位要可见并能解析 pnpm / volta 等脚本 shim（现在静默回退）；占位期定死的
  `openHomeOnBoot` / `onboardingOnBoot` 门（home 屏会在 DSH 数据到位前打开）；`DSH_TUI_WORKSPACE_TARGET`
  为 provider URI 时组合前经本地 runtime 解析会抛；失败后 `/new` 的 DSH `openSession`；组合失败只进
  调试日志 + 失败行，未复刻启动日志捕获；「正在启动 DSH」静态态（冻结约 0.8s）；开关转默认。
- 2.5：只复刻了 `shutdown` 半边，无 `interrupt` / SIGINT；`installFailLoud` 与 TUI 的
  `registerProcessGuardFatalSink` 并存（profile 路径同样）；DSH 进程内的 `/kernel` 两向、`/restart`、
  SIGTERM 无验收用例。
- 2.6：8 个宿主包、约 105 行复刻进 `verify:contract` 版本线与能力探测；`deferRootCapabilityGuard`、
  `excludeNetwork` 一并登记。
- 2.7：守卫放宽（上面第 1 条）；第三方插件三样例；真实模型请求下 working line 与审批未验证。

### 2026-10-07 · Phase 2 第 2.4 块：入口 DSH 路径收尾

（写于交接一节之后。）**结论：DSH 内核默认走入口进程内。**`DSH_TUI_HOST_ENTRY_DSH=0` 关回
`delegateToDsh`；`DSH_TUI_HOST_ENTRY=0` 两个内核都回 `dsh --profile`；宿主探测失败自动回退。

- **宿主定位**：`findHostDsh()` 返回 `{packageDir, launcher, via: link|shim|beside|volta}` 或
  `{reason}`（`locateHostDsh` 保留为包装）。link 按 realpath；启动脚本（pnpm cmd-shim、手写 wrapper、
  npm 的 `.cmd` / `.ps1`）只读 ≤ 64 KiB 文本，抽出 `.js/.mjs/.cjs` 路径并展开 `$basedir`、`%~dp0`、
  `%dp0%`、`$PSScriptRoot`、`$(dirname "$0")`；volta 查 `$VOLTA_HOME/tools/image/packages/…`，不调 CLI。
  能力探测读宿主版本（只报告不拦截），import 失败或缺导出抛带原因的错误（清单新增 `StartupError`、
  `getDshRuntimeVersion`）。
- **回退可见**（`noteHostUnavailable`）：渲染前一行 stderr（交接与 restart 子进程不写）、
  `DSH_TUI_DEBUG` 日志、界面 10 秒 warning notice「Not using the installed dsh: …」。同进程 Claude 回退经
  `RuntimeApplyOptions.hostNotice`；交给 `dsh --profile` 的子进程经内部环境变量 `DSH_TUI_HOST_NOTICE`
  （plugin 读一次后删除）。`delegateToDsh` 无应用参数时不再传 `--`。
- **占位期**：home 与首启引导在 `channel.ready === false` 时初值为 false，接管后由 effect 打开一次
  （已进 settings / tree 不开，启动失败不开；profile 路径挂载即 ready，首帧不变）。**代价：入口 DSH
  路径先出界面、接管后约 1–2s 才弹 home，待确认。**落地页 preset 预热也等 ready（消掉 HEAD 上就有的
  「Not supported by this kernel: preset」噪声）。provider URI 工作区目标在本地 runtime 解析不了时延后
  （`deferredWorkspace`），在 `attachDsh` 经组合出的 `tuiWorkspaces` 解析，失败落失败行。
- **失败后 `/new`**：组合成功、会话打开失败 → `attachDsh` 装好 `openDshSession`（`resolveAgent`：preset、
  路由校验、mount 预留、`agents.create`，加工作区归属），经 `options.openSession` 接管、由 2.1 的窗口挂
  扩展；组合失败 → 提示只给 `/kernel`、`/quit`（核心新增后端中立的 `StartupOpenError` 带 `hint`）。
  组合期间会话打开也失败时以组合结果为准（slot 钩子 `composeSucceeded`），组合失败后才打开的会话被
  关掉。`refreshHostServices()` 提前到 seams 之后、`resolveAgent` 之前。
- **组合失败日志**：`compose()` 照 `boot()` 用一次性 Context 挂 logger exporter 收 warn/error；
  `writeStartupReport` 复刻 `reportStartupFailure` 的写文件半边（`$DSH_HOME/logs/startup-<iso>-<uuid>.log`，
  目录 0700、文件 `wx` 0600），抛 `HostComposeError(original, logPath)`；失败行写日志路径（已接管时用持久
  行）。**偏差**：bin.js 只对 StartupError 写报告，入口对所有组合失败都写。
- **「Starting DSH…」**：占位期（未就绪且未失败）StatusLine 前缀 `Starting {{backend}}…`，落地页无 notice
  时 Tips 行同文（**Claude 占位期也显示，新增可见行为**）。入口 DSH 下挂 `onFrame`，
  `slot.firstFrameFlushed()` 等首帧（最多 1s）并排空 stdout，compose 前 await，新打点
  `entry-first-frame-flushed`（与 `entry-compose-start` 同毫秒，几乎不花时间）。
- 文档：configuration*、guide 副本、README / README_ZH、claude-backend*；`probe-startup-baseline` 加
  `--entry host-delegate`，默认 `host` 即 `host-dsh`。`verify-safe-mode` 的回退矩阵钉
  `DSH_TUI_HOST_ENTRY_DSH=0`（默认翻转后 stub dsh 会走入口回退）。

**验证**：`pnpm build`（89 项）、`verify:package` 通过；host-entry 31（+12：开关、npm link、pnpm shim、
wrapper、`.cmd` 抽取、不认识的脚本、二进制、volta、PATH 无 dsh、第一个 dsh 说了算）、launcher +4、
launchpad 210（LR4 计数 6 → 7）、startup-adoption 46、backend-channel 191、tui-settings 20、startup-argv
183 等通过；channel-ui 4 项既有失败。验收 30/30（新增 12：`dsh-default-starting`(-landing)、两个关闭开关、
`dsh-shim-host`、`dsh-host-fallback`、`dsh-home-held`、`dsh-onboarding-held`、`dsh-provider-workspace`、
`dsh-unknown-workspace`、`dsh-compose-failed`、`dsh-open-failed-new`；去掉修复各自变红）。

**环境事故**：本块跑 `scripts/verify-installed-startup.mjs` 时（它复制真实 profile 未排除 dsh-purge），
dsh-purge 于 09:17 改写了全局 dsh 的 `lib/bin.js`（import 不存在的 `profile-boot-BP_C0vpU.js`），本机所有
`dsh --profile` 启动失败，待用户修复。经 dsh 的验收用例在隔离副本里临时改回 import 后跑过、已还原。
脚本已修：复制时从 `package.json` 的依赖与 bundles、`cordis.patch.yml` 的 `dsh-purge*` 行都去掉
（`!!js` 标签按 `tag:yaml.org,2002:js` 往返，已对仓库补丁核对 24/24）。

**数字**（3 轮中位数，ms，从 spawn 启动器起算；空循环 2.1–2.5s，另有 agent 并行验收，只同轮可比）：入口
DSH 劫持 359、首帧 1388 / prompt 1549、组合 1423–2783（约 1360）、可发送 3135；profile DSH 首帧 2605 /
prompt 2757、首帧即可发送。首帧提前约 47%，可发送晚约 380ms；组合区间比 2.3 的约 810ms 宽，原因未查。

**交给后续**：2.6——探测清单、`writeStartupReport` 与 exporter 进对照表、`HostComposeError`、shim 的
win32 `resolve` 未在 win32 验证；2.7——`StartupOpenError`、`status-starting`、`host-dsh-unavailable`、
`DSH_TUI_HOST_NOTICE` 的可见面，home 两步切换，Claude 占位期的 Starting。

### 2026-10-07 · Phase 2 第 2.5 块：单根下的信号与退出所有权

（写于交接一节之后。）在独立 worktree 做完，以补丁合入（与 2.4 在 `host-entry.ts`、`host-dsh.ts`、
`plugin.ts`、`accept-host-entry.mjs` 有并排新增的冲突，均为两边都保留）。

- **退出码语义**：SIGTERM / SIGHUP / SIGINT 都走 TUI 退出漏斗，最后**以同一信号结束**。理由：启动器只把
  信号死亡当正常结局，任何非零数值都弹安全模式——`runProfile` 的 SIGINT → 130 与启动器不兼容（今天的
  `dsh --profile` 路径潜在存在），SIGTERM → 0 兼容但对 `timeout`、tmux、服务管理器隐藏了被终止；修复 G
  已对 TERM/HUP 这样做，这次纳入 INT。
- **实现**：新 `src/dsh-adapter/process-exit.ts`（`installEntrySignals`、`dieBySignal`、`ProcessExitSeam`）。
  运行时挂载后把漏斗填进 seam、拆除时清空；漏斗照 `/quit` 走（marker、last-run、恢复终端、释放根）后
  `dieBySignal`；释放根卡住 5s 后同样以信号结束；入口自身 7s 兜底；第二次信号立即强退；无漏斗（挂载前、
  拆除中）时入口自己释放根（限 5s）。`dieBySignal` 只摘入口自己的监听器（渲染器的 signal-exit 清理照常），
  若外来监听器留住进程，0.5s 后清掉全部监听器再发一次。`createProcessShutdown` 的 `interrupt` 半边
  **刻意不复刻**，文件头写明由 `process-exit.ts` 取代及与 0.2.0-rc.2 的差异。
- **`appExit`**：`provideCmdline` 的 exit 先交给漏斗（按 `/quit` 走完后以该码结束），漏斗拒绝（拆除中）才
  回退到复刻的 `shutdown`。
- **failLoud 与 TUI 崩溃漏斗**：DSH 的 failLoud 装得早、监听器排在 TUI 进程守卫前，实测它先以 1 退出、TUI
  崩溃行丢失、修复 I 的吸收器被挡住。做法：`apply` 返回且 TUI 进程守卫在位（新 `processGuardActive()`）
  时入口 `uninstallFailLoud()`，之后致命错误只有一个出口（守卫 → `runCrashExit`：崩溃行、crash.log、
  `writeCrashResumeMarkers`、恢复终端、退出码 1）。`DSH_TUI_NO_185_PROCESS_GUARD=1` 时保留 failLoud。
  卸载点选 apply 之后：用例 `dsh-entry-row-activation-fails`（插一行激活即抛的插件）证明此时点不需要
  failLoud 对审计期激活失败的过滤。
- **20s 收尾的结论**：不是释放根。关掉 `excludeNetwork` 复测，`entry-dsh-opened` → `entry-dsh-owned` 间出现
  10s 同步阻塞（flock 的 `getReport` 反向 DNS），收尾时长不变——spike 那次的退出是在等这段阻塞结束。
  2.3 的 `excludeNetwork` 已修掉。restart.log 每次退出多一行 `dispose: root disposed {ms}`。
- **`/kernel`、`/restart`、`/update`**：两向 `/kernel` 与 `/restart` 的替身都是入口进程，fd 3 首帧 ACK 由替身
  发，alt screen 不掉，旧进程监督 15s 不崩。监督期（新 `superviseReplacement`，`/update` 也接上）：发给旧
  进程的 SIGTERM 转给替身；SIGINT / SIGHUP 不转（进程组已发给替身）；替身以终止信号结束时监督者以同一
  信号结束。只在非交接或交接已收到首帧后这样处理；交接已发起、根未释放完时收到信号返回 `supervising`
  （不设兜底），二次信号仍可强退。**行为变化**：非交接 `/restart` 的替身在挂载前死于 SIGINT 时，监督者与
  启动器都以 SIGINT 结束（以前打印「会话保留、可 resume」后以 1 退出并弹安全模式）。`/update` 无专门用例。
- **`delegateToDsh` 吞信号（既有 bug，2.4 默认翻转后暴露在回退路径）**：转发器与 SIGINT 空处理器接住了
  入口重现子进程死因的 `process.kill(self, sig)`，入口以 0 退出。修：重现前摘掉转发器。无头回归用假
  `dsh` 分别死于 INT/TERM/HUP、数值退出码透传、SIGTERM 转发（去掉修复变红）。
- 其他改动：`src/dsh-adapter/test-faults.ts`（仅测试用 `DSH_TUI_TEST_FAULT=render|runtime|rejection|app-exit:<code>[@ms]`）；
  `update.ts` 的 `TuiRestartOptions.onSpawn` / `onTerminationSignal`、`updateTuiAndRestart` 第 5 参；
  `src/ink/update-overflow-guard.ts` 的 `processGuardActive`；`scripts/verify-entry-process-exit.ts`（24 项，
  进 input-terminal 组）；`verify-handoff-atomic` 正则放宽。

**验收**：`accept-host-entry.mjs` 第 7 节 18 个用例（显式 `DSH_TUI_HOST_ENTRY_DSH=1`）：TERM / HUP / INT 各分
启动期与接管后、二次信号、`/quit`、Ctrl+C、`app-exit`、崩溃 render / runtime / rejection、`/restart`、
`/restart` 后 SIGTERM、两向 `/kernel`、row-activation-fails。断言退出码或信号、收尾时长、无释放根超时、
终端恢复、无遗留进程、安全模式提示有无（崩溃要求出现）、会话落盘（`/rename` 写 title 事件，逐帧解
zstd 检查）、last-run 刷新；崩溃另查只有一行崩溃行、无 `dsh: fatal`、crash.log 已写。数字：释放根
54–119ms；接管后信号 / 命令到进程消失 0.26–0.39s；组合期间信号 1.0–1.5s（等约 0.8s 冻结）；二次信号约
110ms；崩溃到退出约 300ms；`appExit` 约 305ms。

**遗留**：启动期信号偶发释放根卡满 5s（约 1/25，只在组合期间；结果仍正确），下次在 `signal: received`
带上最后一个 `entry-*` 打点定位；5.5 的 `process.on('exit')` 兜底判断不需要；Windows 未测
（`process.kill(self, sig)` 语义不同）；`DSH_TUI_TEST_FAULT` 是产品代码里的测试开关，登记方式归 2.6。
交给 2.6：`uninstallFailLoud` 时点、`processGuardActive`、`exitSeam`、restart 选项与参数、「不复刻
`interrupt`、退出码语义不同」进契约；交给 2.7：第三方插件自挂 `process.on(sig)` 的退出行为、守卫放宽期间
第三方插件的崩溃路径。

### 2026-10-07 · Phase 2 第 2.6 块：契约与门禁

（写于交接一节之后。）决定（第 10 节第 7 条）落地为：`@deepseek-ai/dsh`、`dsh-app-boot`、`dsh-cmdline`、
`dsh-http-proxy`、`dsh-launch-environment` 成为 **optional peer + dev**（精确 `0.2.0-rc.2`），
`dsh-home-paths` 由 dev 升为 peer + dev（沿用家族宽范围），`cordis-plugin-loader` 仍只 dev（只当
`unknown` 用）。不进 `dependencies`：`verify:manifest-deps` 第 1 条禁止，profile 里会多出一份真实拷贝、
cordis 变两个实例（#198）。这 6 个包进 `OPTIONAL_RUNTIME_PACKAGES`（profile `autoInstallPeers: false`，
缺席不算 broken）。**运行期仍按宿主 realpath 加载宿主自己的副本**，本包依赖只用于类型、探测与指纹。
`upstreamDrift` 对 dsh 仍按整条验证线判定（入口的真正门槛是 `loadHostDsh` 的导出探测）。

- `pnpm-workspace.yaml`：5 个 `0.2.0-rc.2` overrides；`allowBuilds` 加 `@deepseek-ai/dsh-subprocess-local`、
  `node-pty` 为 false（否则 pnpm 11 报 `ERR_PNPM_IGNORED_BUILDS`）；`minimumReleaseAgeExclude` 旧范围补
  `|| 0.2.0-rc.2`。lockfile 新增 101 个包（dsh 的传递依赖），干净副本 `--frozen-lockfile` 可复现。
- **类型**：host-dsh.ts 的本地结构类型全部换成 `import type` 宿主包，写法
  `Pick<typeof 模块, ContractExports<'key'>>`——契约写了 pinned 宿主不存在的导出即编译失败；
  `profileContext` 用真实 `AppBoot.ProfileContext`。
- **单一来源**：新 `src/dsh-adapter/host-contract.ts`（纯数据：`HOST_PACKAGE`、`HOST_REPLICA_VERSION`、
  `HOST_MODULES`（8 个模块、`via: host | app-boot`、读取的导出）、`HOST_TYPE_PACKAGES`、`HOST_REPLICAS`
  （8 个复刻点）、`HOST_DEVIATIONS`（不复刻 `interrupt` 与退出码语义、`exitSeam`、`uninstallFailLoud` 时点、
  所有组合失败都写报告、不复刻报告的终端半边、不处理 overlays、`deferRootCapabilityGuard`、
  `excludeNetwork`、劫持先于 TUI 模块））。`loadHostDsh`、`contract.ts`（blessed 与可缺集合）、
  `verify:contract` 都读它。
- **复刻面指纹**：`scripts/lib/host-replicas.ts` 把宿主包 `lib/*.js` 当文本读，按名字切出顶层函数 / const
  算 sha256（`createProcessShutdown`、`PROCESS_SHUTDOWN_TIMEOUT_MS`、`createAppReady`、`composeProfile`、
  `runProfile`、`boot`、`reportStartupFailure`、`runCli`），记在 `host-replica.snapshot.json`（不进 tarball）。
  版本线或函数体变化即失败，并列出「复核哪段上游 → host-dsh 哪段」；复核后
  `node --import tsx/esm scripts/verify-host-contract.ts --snapshot` 重写。CI 比 dev 副本；本机 PATH 上的
  dsh 另比、只警告。
- **门禁**：`verify:contract` 串联 `scripts/verify-host-contract.ts`（56 项：契约自洽；dev 副本跑生产
  `loadHostDsh`；假宿主逐个缺 13 个导出 / 8 个模块各自点名失败；无头起入口——缺 `provideCmdline` 的假 dsh 下
  入口交给 `dsh --profile -- hello`、退出码透传、stderr 有原因、子进程收到 `DSH_TUI_HOST_NOTICE`；指纹）。
  `verify:boundary` 新规则（均做变异验证）：`'@deepseek-ai/…'` 字面量只在 `src/dsh-adapter/`；宿主专属模块
  任何地方不得值 import、字面量只在 host-contract.ts（contract.ts 读 `dsh/package.json` 例外）；host-dsh.ts
  对 `@deepseek-ai/*` 只 `import type`；host-contract.ts 只被 host-dsh.ts 与 contract.ts import；
  `DSH_TUI_TEST_FAULT` 只在 test-faults.ts、后者只被 host-entry.ts 与 plugin.ts import。门禁数仍 89（扩展
  既有 `verify:contract`）。
- **测试开关**：`DSH_TUI_TEST_FAULT` 作为内部开关写进 docs/contributing（双语）与 ADAPTER，不进 README /
  configuration；扩散由门禁锁住，文档写明不再新增同类开关。
- **win32**：`resolveLauncherPath` 导出并按 platform 选 `path.win32` / `path.posix`；`verify-host-entry` +11
  （`.cmd` 的 `%dp0%` / `%~dp0`、`.ps1` 的 `$basedir` / `$PSScriptRoot`、相对、跨盘符、UNC 等），共 42。
- 文档：ADAPTER.md（边界表、新节「独立入口的宿主契约」、升级流程）、docs/contributing(.en).md、AGENTS.md
  上游边界一条。

**验证**：`pnpm build`（89 项）、`verify:package`（2964 文件、30 个入口目标）通过；host-entry 42、launcher、
entry-process-exit 24、startup-adoption 46 通过；input-terminal 32/32。

**遗留**：入口装劫持后 `import.meta.resolve` 可能解析到宿主的 app-boot 等副本，宿主与 profile 不在同一版本线
时落地页可能出现此前静默的 `mixed` drift 通知（无头测不到，真机看）；dev 依赖使安装多约 100 个包。

### 2026-10-07 · Phase 2 第 2.7 块：第三方插件验收与守卫

（写于交接一节之后。）在独立 worktree 做完，以补丁合入（与 2.6 无冲突）。全局 dsh 已由用户修好，profile
路径对照直接运行。

**三样例**（`plugins-entry` / `plugins-profile` 同一组插件与断言跑两条路径，均通过；夹具在
`scripts/fixtures/host-entry-plugins/`，不进发布包）：主题插件经 `tuiThemes` 注册、`theme.json` 预选，屏上
出现其颜色；面板插件 id `accept-panels:demo`（插件自己的前缀，非兜底 `act*`），每插件配额按身份计（第 5 个
被拒），`tuiPluginStorage` 落 `plugin-storage/accept-panels.json`；决策插件（身份 `accept-guard`）的
`tui/input` 否决与改写、`/new` 的 `tui/session-switch` 否决都生效（改写后的消息被投递，`llm-deepseek` 的
`baseURL` 指向 `127.0.0.1:9`，断言以 `transport failed` 结束，不请求真实模型）。

**身份相关的发现**：

- **产品代码里没有任何地方调用 `getHostAdmission`**：两条路径上第三方插件今天都拿不到经验证的身份（面板落
  `act*`，DecisionEvents 与 storage 直接拒绝）。测试插件自己调 admission 扮演缺失的 loader。所以本块证明的是
  「单根下身份绑在插件自己的 fiber 上」（2.2 两根丢的正是这个），不是「产品会发身份」。
- 带点的 component id（如 `com.example.x`）会让 `pluginIdFor` 的正则回落到 `act*`。
- 插件 apply 里等待会拖住组合：profile 路径卡首帧（等 15s 的 apply 把 `runtime-apply` 推迟约 15.5s），入口
  路径卡接管。
- 文档要求 `tuiPluginHost` 只能软探测，但插件实际只能靠 `inject: ['tuiPluginHost']` 等它出现。
- profile 路径既有问题：dsh-tui 运行时 apply 之前注册的面板被 `plugin.ts` 的
  `applySidePanelPanels(config…)` 覆盖出启用列表，之后 `open()` 被忽略。入口路径没有这个窗口。

**forced theme**：复现不到「落回 auto」——ThemeProvider 已有以 `runtimeThemeSnapshot` 为依赖的恢复 effect，
attach 时 rerender 传入新 themeHost 后恢复持久化选择。实际是入口路径首帧先用自动检测配色、约 1–2s 后换成插件
主题（profile 路径首帧即插件主题）。插件未加载时无法画它的主题，未改代码。2.3 的遗留据此更正。

**守卫收紧**：越权插件在 apply 时与 4s 后各试 `root.plugin` / `root.effect` / `root.on` / `root.inject`，分
「早行」（无 inject，模块加载完即 apply）与「晚行」（inject `tuiPanels`，必在 TUI 行之后）：

| | 早行 apply | 晚行 apply | 4s 后 |
| --- | --- | --- | --- |
| profile 路径 | 放行 | 拒绝 | 拒绝 |
| 入口，改前 | 放行 | **放行** | 拒绝 |
| 入口，改后 | 放行 | 拒绝 | 拒绝 |

新增 `armRootCapabilityGuard(root)`，入口在组合开始前调用：此后第一个经过 TUI 宿主代码（`compositionRoot`）
的插件激活即装守卫——即第一个 TUI 行（每个 `dsh-tui-*` 服务构造都会经过）；宿主代码、根自身、
`withHostRootCapability` 不触发；组合结束的释放兜底保留。即与 profile 路径对等（包括早行能抢在守卫前的那个
竞态）。没选「只放行 DSH 官方行」：需要可靠知道每行来自哪个包，目前没有来源。2.3 的 `UserQuestionService`
金丝雀用例通过，调试日志无官方行被拒。无头断言进 `verify-plugin-lifecycle`（+5，去掉修复变红）。

**崩溃与信号**（入口路径，全过）：组合期间 apply 同步抛错——审计接住，会话照常接管，`/quit` 0；运行期抛错
（timer 0ms 即组合期间、6s 后同步、6s 后 unhandledRejection）——只走 TUI 崩溃漏斗（一条崩溃行、无
`dsh: fatal`、crash.log 有插件错误、启动器问安全模式前终端已恢复、退出码 1、无遗留进程）；插件自挂
SIGTERM / SIGINT / SIGHUP 监听器——都以该信号结束、插件监听器也执行、无安全模式、终端恢复，约 800ms（比
2.5 基线多出 0.5s 宽限）。

**可见面**：`StartupOpenError`、`status-starting`、`host-dsh-unavailable`、`HOST_NOTICE_ENV` 都不在任何
`exports` 子路径；`DSH_TUI_HOST_NOTICE` 只在委托出去的 dsh 进程环境里、被 plugin 读取删除前任何行可读。真正对
插件可见的是 `TuiSceneProps.channel` 上的 `ready`、`startupFailure` 与 `status: 'starting'`（Phase 1 加的）。
观感（PTY 文本时间线，从 spawn 起）：DSH 默认 home——+1.1s 聊天页、状态栏「Starting DSH… · deepseek-flash」，
+2.2s 切到 Sessions home；首启引导——+1.2s 聊天页，+2.4s 弹 Welcome；Claude（假 claude 延迟 4s）——+1.2s
「Starting Claude Agent… · Claude Agent · max」，+5.6s 换成模型名。两步切换与 Claude 占位期 Starting 去留
待用户决定。

文档：`docs/plugins(.en).md` 加一条「DSH 内核在本包入口」，guide 副本同步。

**验证**（合入 2.6 之后的树）：`pnpm build`（89 项）、input-terminal 32/32 通过；agent 侧另跑 channel-ui
（4 项既有失败）、守卫相关 22 个脚本通过。`accept-host-entry` 全量 **59 例 57 通过**，失败 2 例是
`dsh-entry-sigterm-starting`、`dsh-entry-sigint-starting` 的「组合期间收到信号、释放根卡满 5s」；单独连跑三轮
9 例失败 1 例。结局仍正确（以信号结束、终端恢复、无遗留进程）。

**组合期间信号偶发卡 5s**（2.5 遗留，本块数据）：不调 arm 也能复现（2/42、另一组 0/54）；arm 但守卫包装全部
跳过 2/42；arm 且守卫正常装约 9/123——偏高但样本小、不显著。插桩显示卡住期间守卫未拒绝任何调用，只发生在信号
落在 `entry-compose-start` 之后、TUI 行之前。机制未查明，下一步在 `signal: received` 带上最后一个 `entry-*`
打点定位。

**遗留**：1. 缺 admission loader（读 `dsh-plugin.json`、调 `getHostAdmission`），第三方插件在任何路径上都没有
身份；2. profile 路径上运行时 apply 前注册的面板不进启用列表；3. 组合期间信号偶发卡 5s；4. 入口首帧主题闪一次；
5. `tuiPluginHost` 软探测文档与实际矛盾；6. 带点 component id 回落 `act*`；7. 「只放行官方行」的更严方案未做。
1、2、5、6 两条路径都有，不是方案 B 引入的。

### 2026-10-08 · 组合期间信号偶发卡 5s：dsh-hmr 的 dispose 死锁

（写于交接一节之后。）**根因在上游 `@deepseek-ai/dsh-hmr` 0.2.0-rc.2，本包侧规避。**

- **诊断**：复现时 restart.log 的未完成 fiber 只有 `Hmr`（`include:hmr (@deepseek-ai/dsh-hmr)`，state 1、
  inertia），其余已释放；事件循环上只剩 TTY 与兜底计时器，没有 fs 请求或 watcher——纯 promise 环。
- **机制**：dsh-hmr 的 `[Service.init]` 先 `yield` 释放器（`started.resolve(false)`），再逐个
  `await this.watchConfig(...)`；chokidar `ignoreInitial:false` 初始扫描即发 `add`，启动一次 `running` 刷新，
  经 `runReload` `await this.applicationReady`（组合期间未 commit，挂着）。此时 fiber 被释放，watcher 的
  `ready` 到达后 `ctx.effect(...)` 抛 `INACTIVE_EFFECT`，catch 里 `await dispose()` 又 `await running`。
  闭环：init 等 running → running 等 ready → ready 等释放器 → 释放器等 init 返回。`dsh --profile` 路径同样有，
  被 `runProfile` 的 5s 关停上限掩盖。
- **复现**：应用内探针在 `Include` fiber 进入 loading 时立即自发 SIGTERM，2/2 卡满 5s；延后 ≥200ms 12/12
  正常。最小复现（宿主 cordis + Loader + timer 行 + dsh-hmr 行、appReady 永不就绪）：Hmr 进入 state 1 后
  0–20ms 内 `ctx.root.fiber.dispose()`，3s 内不 settle；释放后 commit appReady，约 500ms 释放完——证明环卡在
  `applicationReady`。不能靠 commit ready 修：会让 HMR 在拆除中的树上跑 `reconcileProfilePatches`。已排除：
  能力守卫、`attachDsh`、同步冻结段、线程池阻塞。
- **修**（新 `src/dsh-adapter/root-dispose.ts`）：`trackComposition(root, settle)` +
  `disposeRootSettled(ctx, dispose?)`——入口组合进行中时，释放根先 `await loader.await()`（所有行激活完，
  Hmr 的释放器并发执行互相放行），受原有 5s 计时器约束；同时置 `disposing`，`compose(warn, stopping)` 在
  Loader 收尾后见到即返回，不审计、不 `appReady.commit`。只在入口组合窗口登记，profile 路径不受影响。
  `plugin.ts` 的 `disposeRootAndThen` 与入口无漏斗兜底都走 `disposeRootSettled`；`attachDsh` 在
  `compositionFailed || exited` 时直接返回（Loader 收尾会启动 dsh-tui 行，退出中不再打开 DSH 会话）。2.5 语义
  不变（漏斗唯一出口、以信号结束、二次信号强退、第三方挂起仍有 5s 回退）。附带：组合期间收信号的收尾从
  1.0–2.5s 降到约 0.7s。
- **诊断保留**（只写 restart.log）：`signal: received` 带 `at`（最后一个 boot 打点，`bootTrace.ts` 新
  `lastBootMark()`、`process-exit.ts` 新可选项 `where`）；释放超时时写 `dispose: still pending`（未完成
  fiber、loader entry、状态、按类型统计的活动资源）。
- **回归**：`verify-entry-process-exit` 24 → 29：子进程用 dev 依赖的 dsh 搭最小根（Loader + timer +
  dsh-hmr，就绪永不到来），Hmr 进入 loading 后 0ms 释放——直接 dispose 确认死锁（上游修了会红，提示可重新评估
  这段等待）；走 `disposeRootSettled` 时 6 种延迟（0/0/0/1/5/20ms）都在 1s 内 settle；另 3 条接线断言。注释掉
  `await composition.settle()` 后 3/3 hang。
- **连跑**：三个 `-starting` 用例各 35 轮共 105 次 0 失败（修前 15 轮 2 次、20 轮 1 次）；收尾 p50 702ms、
  max 759ms；根释放（含等 Loader）p50 25ms、max 63ms。
- **验证**：`pnpm build`（89 项）、input-terminal 32/32、entry-process-exit 29、host-entry 42、startup-adoption
  46、plugin-lifecycle 56、`accept-host-entry` 全量 **59/59**。

**遗留**：上游死锁本身还在（`dsh --profile` 启动期收信号会卡到 5s 上限），建议报上游——watchConfig 失败分支在
init 内 `await running`，而 running 依赖的就绪只能由 init 之后的释放器放行；最小复现脚本暂存在 scratchpad
（`repro-hmr.mjs`），报上游前需整理。`createProcessShutdown`（漏斗之前的 appExit）与 fail-loud 的释放未改走
`disposeRootSettled`（都在组合前或已由漏斗接管）。`dispose: root disposed {ms}` 现在含等 Loader 的时间。

### 2026-10-08 · rebase 到 upstream/main 85d49e53

（写于交接一节之后。）本地 `main` 从 `ec48de22` 快进到 `upstream/main` 的 `85d49e53`（31 个提交：原生 Codex 内核
#1352、回合中命令按命令执行 #1258、侧栏面板 #1354、context bar 对齐 #1363、winbash 预设 #1376 等），
`feat/standalone-host` 的 24 个提交整体 rebase 上去。rebase 前的分支留在 `backup/standalone-host-pre-rebase-20261008`。

**冲突与解法**：

- `fdde6be2`（启动接管）：`compose.ts` 的 `subagentControl` 本分支已抽成 `subagentControlFor(session)`，main 在原
  位加了 `messagingTool` 的原生信封——移植进 `subagentControlFor`；导入行两边合并（`WORKING_GATE_NOTICES` +
  `markBoot`；`PromptInput` 的 `isBootSafeCommand` + `workingHoldOf`；`plugin.ts` 的 `closeBackendResources` +
  `prepareBackendStartup` 与设置服务导入）；`run-ci-group.mjs` 两条新回归都保留。
- `6936881d`（Phase 1 验收修复）：main 把落地页的 `node` 改名 `launchpad`，通知区 `launchpadNotice` 留在其前。
- `32199cd7`（依赖 `@deepseek-ai/dsh`）：`ADAPTER.md` 的 `native.codex` 行与本分支三条边界行都保留；
  `contributing{,.en}.md` 保留 Codex 协议行，上游验证线行用本分支（含 `host-contract.ts`）的版本；
  `pnpm-lock.yaml` 取 main 的再 `pnpm install --lockfile-only` 重生成。
- `901d0b24`（root dispose）：`disposeRootAndThen` 同时保留 `disposeRootSettled` 与 main 的
  `.finally(() => closeBackendResources())`（关闭 Codex 进程池）。入口无漏斗兜底（`host-entry.ts` 的
  `disposeRoot`）不调 `closeBackendResources`：那条路径上没有已加载的后端。

**rebase 后的修补（未提交）**：`verify-settings-compat` 在新 main 上已修好，但它从 `plugin.ts` 源码抽
`settingsSections.register(...)` 调用去 eval，本分支（2.3 的 rehome）把节对象提成了 `tuiSection` 声明，抽出来只剩
`register(tuiSection)`——harness 改为一并抽取 `tuiSection` 声明。

**Codex 内核与入口**：`entryKernel` 现在可能返回 `codex`。入口按「非 claude」处理：`runInEntry('dsh')` 组合 DSH
profile，plugin 按记住的内核打开 Codex——与 rebase 前 Codex 在 `dsh --profile` 里运行对等；`DSH_TUI_HOST_ENTRY_DSH`
关闭时委托 `dsh --profile`。Codex 没有 Claude 那条「不组合 DSH」的快速路径，列为遗留。

**验证**：`pnpm build`（185 项）；`verify-host-entry` 42、`verify-startup-adoption` 46、`verify-entry-process-exit`
29、`verify-plugin-lifecycle` 56；CI 组 input-terminal 33/33；channel-ui、render-scroll、session-workspace 的失败
（`verify-activity-store`、`verify-compaction-progress`、`verify-splash-eggs`、`verify-update-checksum`）在新 main
的临时 worktree 上同样失败（前三项单独跑两边都通过，只在组内红；`update-checksum` 是已知计时断言），与本分支无关；
`accept-host-entry` 全量 **59/59**。

**遗留**：Codex 内核走入口快速路径（不组合 DSH）未做；交接一节「已知坑」里的 main 存量失败清单已过时
（`verify-settings-compat` 已在 main 修好），以本节为准。

### 2026-10-06 · 交接：当前状态与下一步（新会话从这里接手）

> **2026-10-07：Phase 1 已验收，Phase 2 计划见「Phase 2 规划」一节；2.0–2.7 已完成并提交；组合期间信号卡 5s 已查明并规避（已提交）；2026-10-08 已 rebase 到 upstream/main 85d49e53；剩 2.7 遗留与观感决定。**
>
> **最新交接（Phase 1 实现完成，下一步是测试）。**本节开头这一块是现状；后面
> 「（以下为 Phase 1 开工前的交接原文）」是历史记录，只在需要背景时看。
>
> **更新：测试已做，见上一节「Phase 1 验收：tui-test 模拟终端」**：修复 A–D、F–I（含落地页
> 通知区 C、内核切换后监督进程崩溃的类级处理 I）；用户决定暂不做的：启动期放开整屏入口、E 落地页
> 丢键、清单第 0 项；待决定：启动器不转发 SIGTERM（J 已于 2026-10-07 修复，见「修 J」一节）。原先
> 「PTY 下 DSH 链只画空帧」已查明是隔离环境问题并修正了测试工具，DSH 一侧可完整自动化。
> 下面的「下一步：测试」保留作记录。

**提交（`feat/standalone-host`，均未 push）**

| 提交 | 内容 |
| --- | --- |
| `c966caff` | Phase 0：channel 核心改收 `ChannelHost`、boundary 门禁、启动打点、基线探针 |
| `c6adcf7e` | Phase 1 spike（裸 Cordis 根零守卫跑通 Claude 内核）、分期修订与 5.6 决定 |
| `fdde6be2` | 第 1、2 块：启动接管（占位会话、`ChannelUi.ready`）+ `~/.dsh-tui/settings.json` |
| `e287998b` | 第 3 块：`host-entry.ts`、启动器分流、`restartArgv`、文档与回归 |
| （本节） | 交接更新 |

各块做了什么、数字、验证结果见上面「Phase 1 第 1、2 块」「Phase 1 第 3 块」两节；设计正文
5.3 / 5.6 / 5.8 已同步实现。已定事项：5.6 选 (a)；分期修订（Phase 1 只做 DSH 无关，TuiHost
推迟到 Phase 2）。仍待决定：AGENTS.md 开头「零核心改动、纯插件挂载」定位句的改写（只补了
布局表）、Phase 2 排期、PR #1216 去留（第 8 节）。

**下一步：测试（由新会话主导）**

无头部分已经全绿（见第 3 块一节）。剩下的都要真实终端，按第 3 块一节末尾的清单 0–4：

0. 真实安装形态下跑通 `dsh-tui --backend claude`（pnpm 链接形态下入口的模块解析）。
1. inline / fullscreen / 窄终端下 Claude 内核启动：首帧、「还在启动」提示与草稿保留、
   本地命令放行、就绪后发送、打开失败时的提示行与 `/new` 重试。
2. `/kernel` 双向切换：DSH → Claude 应重起到入口；Claude → DSH 是入口重起后交给 dsh；
   两个方向都看 fullscreen 下有无闪屏（fd 3 ACK 由真正接管屏幕的进程发）。
3. Claude 内核下 `/restart`、`/update`（入口经 `RuntimeApplyOptions.profile` 找 profile）。
4. 启动期 `/quit`、Ctrl+C、`kill -TERM`：终端恢复完整，没有遗留 `claude` 子进程。

另外值得顺手看的：
- 设置迁移：删掉 `~/.dsh-tui/settings.json` 后首启应从 profile 补丁的 `dsh-tui` 行导入一次；
  两个内核改同一项设置互相可见；`DSH_TUI_HOST_ENTRY=0` 下设置仍读文件（不随开关回退）。
- 记住的内核是 Claude 但 SDK 被卸载：入口下应是界面里的提示行 + `/kernel`（5.3 写明的
  Phase 1 行为），不是静默回落 DSH。
- 干净机器上重测数字：`node scripts/probe-startup-baseline.mjs --backend claude --entry host|profile --runs 5`
  与 `--backend dsh`，补进第 3 块一节的表（本轮机器慢，只有比例可信）。

**怎么搭测试环境（建议，测试会话自己决定）**

- 不要直接改真实 `~/.dsh/profiles/dsh-tui`。最省事：`pnpm compile` 后
  `PROBE_KEEP=1 node scripts/probe-startup-baseline.mjs --runs 1`，它会在临时目录建一份
  隔离 profile（本 checkout 的 `bin/`、`lib/` 拷进去，排除 dsh-purge）并打印路径；然后在
  真实终端里 `DSH_HOME=<路径>/.dsh node <路径>/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/bin/dsh-tui.js --backend claude`。
  只改 `DSH_HOME` 不改 `HOME`：Claude 登录在 `~/.claude` 里，换 HOME 就没有凭据；代价是
  `~/.dsh-tui/settings.json` 等偏好写进真实 home（首次会生成 settings.json 并记导入来源）。
- 第 0 项要的是真实 pnpm 安装形态：可以在一个独立 `DSH_HOME` 里 `dsh plugin --profile dsh-tui add <npm pack 出的 tarball>`，
  再把 Claude SDK 装进该 profile（或用 `/kernel` 里的安装向导）。
- 调试：`DSH_TUI_BOOT_TRACE=<文件>` 记启动打点（含 `entry-start`、`entry-modules`、
  `startup-adopted`）；`DSH_TUI_DEBUG` 走 stderr 调试路径；重启/切换的交接事件在
  `~/.dsh-tui/restart.log`。

**已知坑**

- 本机 profile 的 dsh-purge（链接到本地开发副本、`autoApplyOnStart: true`）启动时会改写
  **全局** dsh 的 `lib/bin.js`，写坏后 `dsh`/`dsh-tui` 全部起不来（报找不到
  `profile-boot-BP_C0vpU.js`）。测试环境里排除它；若全局 dsh 被改坏，需要用户修复。
- 本机 node-pty 下，经「dsh-tui 启动器 → dsh」链起的 TUI 只画空帧（原因未查明）；走本包入口
  时画面正常。所以 PTY 自动化只能测入口路径，DSH 路径要在真实终端看。（**更正**：根因不是 PTY，而是隔离 profile 与全局安装的 dsh 组合时共享依赖路由出错，见「Phase 1 验收」一节的「DSH 空帧的根因」。）
- 以下失败在 main（ec48de22）上同样存在，与本分支无关：`verify-activity-store`、
  `verify-compaction-progress`、`verify-splash-font-setting`、`verify-settings-compat`、
  `verify-splash-eggs`、`repro-picker-windowing`；`verify-update-checksum` 是下载流计时断言，
  负载高时两边都会红。（`verify-guide` 的 claude-backend 副本漂移已在 `e287998b` 顺带修好。）
- 本轮机器明显变慢（3 亿次空循环约 2.3s，平时约 0.3s），测时延前先跑一下这个空循环看环境。

**协作约定（不变）**：本文档是方案 B 的主要参考与记录，测试发现与修正都写进实施记录；只
暂存明确路径；提交不加 Claude 署名；未经要求不 push。

（以下为 Phase 1 开工前的交接原文）

**仓库与分支状态（Phase 1 开工前）**

- 本 worktree：`/home/moment/Code/working/dsh-TUI-standalone`，分支 `feat/standalone-host`。
  - `c966caff` Phase 0（channel 核心改收 `ChannelHost`、boundary 门禁收紧、启动打点、
    基线探针、本文档）——已提交，未 push。
- 预载方案的 rebase 分支：`/home/moment/Code/working/dsh-TUI-preboot-rebased`，分支
  `feat/preboot-fast-start-rebased`，`07a240c2`（PR #1216 的净改动压成一个提交，重建在
  ec48de22 上，含与 main 的整合修补）——已提交，未 push，PR 未更新。PR #1216 是先合入还是
  关闭，等方案 B 有结论后与 chimney 决定（本文第 8 节）。该分支本地 CI：channel-ui 组 4 个
  失败已确认与 PR 无关；render-scroll 组 3 个（含 `verify-launchpad`）、session-workspace
  组 2 个失败**未对照**，若走「先合入」必须补跑。
- 原 PR 分支工作区 `/home/moment/Code/working/dsh-TUI-preboot`（`beb04980`）保留未动。

**Phase 1 进行到哪**

**更新：Phase 1 已实现（三块），见「Phase 1 第 1、2 块」「Phase 1 第 3 块」两节；spike 入口
已由 `host-entry.ts` 取代。**下面保留 spike 前的计划原文作记录。

spike 的定位：**上限测量**，不是 Phase 1 交付——量出「Claude 内核完全不组合 DSH profile」能
快到多少，再决定是否值得重写组装根。

为什么做 spike 而不是直接按 5.1 写 Cordis 无关的组装根：`plugin.ts` 的 `apply` 约 2000 行，
深度依赖 Cordis（设置 inject、问卷服务、预设、各 tui 接缝、退出漏斗、给 Chat 的约 100 个
props）。按设计重写等于重写这 2000 行，先量收益再付成本。

spike 做法（已与 advisor 对齐）：

1. 新文件 `src/host/spike-entry.ts`：`markBoot('entry-start')` → 动态 import
   `@deepseek-ai/cordis` 的 `Context`、`../dsh-adapter/index.js` 的 `Config`、
   `../dsh-adapter/plugin.js` 的 `apply` → `markBoot('entry-modules')` →
   `const ctx = new Context()` → 照 `cordis.patch.yml` dsh-tui 行（约 452–503 行）从环境
   变量构造 `Config({ provider: 'deepseek-official', fullscreen: true, terminalImages: true,
   effort: 'max', preset: env.DSH_TUI_PRESET, workspace: env.DSH_TUI_WORKSPACE_TARGET,
   sessionId: env.DSH_TUI_RESUME_SESSION, backend: env.DSH_TUI_BACKEND })` →
   `await apply(ctx, config, ctx)`（跳过 `index.ts` 那层 loader 等待）。设置层用默认值、只读
   （已与用户约定；不要用 app-boot `composeEntries`，那会把 dsh-app-boot 拉回依赖图）。
2. 已确认：裸 `new Context()` 自带 `logger`、`effect`、`plugin`、`inject`、`on`、`get`、
   `root`、`fiber`。`resolveTuiHostMode()` 在 stdout 是 TTY 时返回 `interactive`，不挡路。
   注意 `isStandaloneRuntime()`（`update.ts`）会把 `DSH_HOME` 含 `dsh-tui-standalone` 的
   情况当成独立运行时——本 worktree 路径是 `dsh-TUI-standalone`（大小写不同），不触发。
3. 预期会撞上的「服务不存在」点：`registerBundledPresets`、`UserQuestionService` /
   `toolAskUser`、`agentDefaultModel`、`compositionRoot`、退出漏斗的
   `ctx.root.fiber.dispose`，以及 `plugin.ts` 约 855–866 行 `ctx.inject(['settings'], …)`
   的 `settingsReady`：裸根没有 settings 服务，回调不跑，首帧会白等 300ms 兜底——要么在
   比较数字时扣掉，要么加「服务不存在就立即 resolve」的分支。
4. **时间盒**：每处只加「不存在就跳过」的守卫，不改语义。守卫超过五六处，或某处必须改行为
   才能过，就停——那本身就是「组装根耦合度」的量化结论，记进本文档。
5. 探针加 `--entry spike`：spawn `node <隔离副本>/lib/types/host/spike-entry.js`（模块解析仍走
   隔离 profile 的 node_modules）。对比口径：baseline 从 spawn 启动器算起，含约 107ms 启动
   器链；spike 是直接起进程，要注明。
6. 跑通后量两组：Claude 内核 spike 5 轮（entry-start → session-open → render-done）；spike
   下 `session-open-start` 之前的拆分（模块加载、plugin 前期准备各多少）——后者决定 1b
   （先挂界面、占位会话、后接管）首帧能提前到哪。
7. spike 代码这一轮不提交，等用户看过数字再定去留。

**待提给用户/chimney 的推论（spike 跑完再提）**：如果 spike 只需少量守卫就能跑，说明
Phase 1 真正需要的是「DSH 无关」而不是「Cordis 无关」——TUI 自己持有一个 Cordis 根，`tui*`
服务原样住在里面，不需要桥。「Cordis 无关」要到 Phase 2 才必要：`runProfile` 的 `boot()`
会新建自己的根，两个根并存时第三方插件在 DSH 根里看不到 TUI 根的服务。这会实质修改 5.1 与
分期表（TuiHost 抽象推迟到 Phase 2），由用户和 chimney 决定。

**进展（2026-10-06）**：Phase 1 三块都已实现，记录见上面「Phase 1 第 1、2 块」与
「Phase 1 第 3 块」两节。剩下的是需要真实终端的手动演练（见第 3 块一节末尾）。

**决定（2026-10-06，spike 之后）**：5.6 选 (a)；接受分期修订（Phase 1 只做 DSH 无关，TuiHost
推迟到 Phase 2）。正文 5.1、5.6、第 3、7、10 节已同步。Phase 1 剩下三块：1b（占位会话，
下一步）、设置存储 (a)、本包入口与启动器分流（spike 入口转正）。退出路径待用户在真实终端
验证 `/quit`。

**之后的 1b（spike 之后）**：占位会话 + `adoptStartup`（5.3），首帧先于后端打开。依据会话
接管调研：`createBackendOpener.adoptWith`（`core/session-switch.ts`）是现成的接管尾段；不能
复用 `newSession`/`resumeSession`（`working` 时拒绝、`raceProbe` 遇排队输入放弃候选、触发
`tui/session-switch` 否决与提示）；构造时定死的字段（`backendLabel`、`messaging`、
`subagentControl.history`、`defaultOpeners`、`snapshotOf` 的 `dsh:false`、working-activity
挂载）要改成可延后；`core.extend` 在 `start` 之后会抛错。

**测量工具与注意事项**

- `DSH_TUI_BOOT_TRACE=<文件>` 打点：`row-apply`（index.ts）、`runtime-apply`、
  `session-open-start/end`、`render-start/done`（plugin.ts）。
- `scripts/probe-startup-baseline.mjs --backend dsh|claude --runs N`（需先 `pnpm compile`）。
  调试开关见文件头：`PROBE_TIMEOUT_MS`、`PROBE_DEBUG=1`、`PROBE_KEEP=1`、`PROBE_SCREEN=1`
  （打印每轮末屏）。`--entry host`（默认，按发布行为分流）/ `--entry profile`
  （`DSH_TUI_HOST_ENTRY=0`，旧路径）；两者都从 spawn 启动器算起。
- `plugin.ts` 另有 `settings-wait-start/end` 打点，量 `settingsReady` 等待（裸根下恒为 300ms 兜底）。
- 探针必须排除 dsh-purge（已实现），否则会改坏全局 dsh 的 `bin.js`（见上一节环境发现 1）。
  若全局 dsh 又报 `profile-boot-BP_C0vpU.js` 找不到，就是被改坏了，需要用户修复。
- 本机 PTY 下 TUI 只画空帧（环境发现 3），可见首帧只能在真实终端手测；时间点打点不受影响。
- `verify-settings-compat.mjs` 在 main 上本就失败（harness 漏注入 `normalizeBrandSetting`
  与 `BTW_CONTEXT_*`）；预载 rebase 分支里有修法可参考，本分支未修。

**协作约定**

- 本文档是方案 B 的主要参考与记录：每一步、每个发现、每处设计变更都同步写进本节和相关正文。
- 未经用户要求不提交；只暂存明确路径；提交不加 Claude 署名（无 Co-Authored-By）。
- 验证按 AGENTS.md：改动面相关的聚焦脚本 + `pnpm build`；仓库没有 `test`/`lint` 脚本。
