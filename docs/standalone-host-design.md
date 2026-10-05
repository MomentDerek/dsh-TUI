# 独立宿主（方案 B）设计

[文档索引](README.md) · [架构与限制](architecture.md) · [多后端架构](agent-backend-design.md)

状态：设计草案，未实现。基于 `main`（ec48de22）与 `@deepseek-ai/dsh` 0.2.0-rc.2 的代码阅读。

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

依赖方向：界面 → ports；channel 核心 → agent + ports + **TuiHost 接口**；Cordis 只出现在
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
- **新增 `adoptStartup(session, history)`**，用 `binding.switchTo` 加 `adoptWith` 式的
  尾段，但**不复用** `newSession` / `resumeSession`：它们在 `working` 时拒绝、遇到排队
  输入会放弃候选（`raceProbe`），还会触发 `tui/session-switch` 否决与切换提示——这些都
  不适合启动接管。
- **启动期输入。**草稿留在输入框不发送：Enter 提示「还没就绪」，只放行纯本地命令
  （exit/help/theme 等），沿用预载分支已验证的行为与 `isBootSafeCommand` 白名单。不采用
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
- **启动失败。**今天后端打不开就是启动失败、非零退出。方案 B 下界面已在：失败要在界面里
  显示原因并给出退出或重试，退出时取消仍在进行的打开。记住的内核打开失败、回落到 DSH
  的逻辑（`plugin.ts` 现有）变成「占位会话改由 DSH 接管」，不需要重启。

### 5.4 DSH 后端：进程内 `runProfile`

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

### 5.6 设置存储（需要维护者决定）

`dsh-tui.*` 的值（fullscreen、diffLayout、sidePanel、shortcuts…）在 0.1.7+ 宿主下住在
profile 的 Config 行里，`/settings` 通过 DSH 的 `settings.mutate`（带版本号的围栏写入）
写回。Claude 内核不加载 DSH 时，**读**可以借 app-boot 组合，**写**没有去处。

- **(a) TUI 自有设置文件（推荐）。**如 `~/.dsh-tui/settings.json`，首次启动从 profile
  Config 一次性导入，之后 `dsh-tui` 行不再拥有这些键（Config 里残留的值作为只读的旧层，
  文档说明）。理由：两个内核同一份设置，首帧读设置不需要 app-boot，和
  `~/.dsh-tui/*.json` 现有偏好放在一起。代价：用户可见的文件布局变化与迁移；手写
  cordis.yml 里 `dsh-tui:` 配置的用户需要迁移说明。
- **(b) 继续住 Config。**Claude 内核下设置只读，改设置提示「切回 DSH 内核再改」或
  通过 app-boot 直接写 profile 文件（绕过 DSH 的版本围栏，有并发写风险）。

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

- 三进程链（全局启动器 → profile 启动器 → dsh）变成：全局启动器 → profile 启动器 →
  `node <本包 entry>`。对齐检查、安全模式重试、Windows 下 `dsh.cmd` 的解析留在
  profile 启动器。
- `restartTui` 用 `process.execPath` + 原 argv 重起，天然指向新 entry；kernel 切换交接
  （`handoffAck`）的「新进程接管 alt-screen」协议不变，只是接管点从 plugin 移到 entry。
- 一次性开关（`--version`、`--dump-config*`）继续直接交给 dsh。

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
| 1 | 设置存储落地（按 5.6 的决定）；本包 entry；占位会话 + `adoptStartup`；Claude 内核走 entry、不加载 DSH。DSH 内核此时**不进 entry**，profile 启动器照旧 spawn dsh | Claude 内核首帧与可发送时间对比基线；新增启动接管、启动失败、启动期退出的无头回归；inline / fullscreen / 窄屏手动演练 | profile 启动器只在内核判定为 claude 时走 entry，可用环境变量关闭，关闭即回到今天的 spawn dsh |
| 2 | DSH 经宿主 `runProfile` 进程内加载；桥接行；DSH 扩展晚挂（D1）；契约加入 `@deepseek-ai/dsh/profile-boot` | DSH 内核首帧对比基线与预载分支；第三方插件示例（主题、面板、决策拦截）在新路径下通过；`verify:contract` 覆盖能力探测与回退 | 能力探测失败或环境变量关闭时回退到「spawn dsh」 |
| 3 | 删除 `src/preboot/`、`src/adapter/channel/deferred.ts`、`bin/dst.js`；决定直启路径去留；改写 AGENTS.md 与架构文档 | 构建门禁与全部 CI 组 | — |

Phase 1 是收益最大、风险最小的一期，也是检验 Phase 0 抽象够不够用的试金石。

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
2. 设置存储：5.6 的 (a) 还是 (b)。
3. DSH 内核走 D1（扩展晚挂、预载整体删除）还是 D2（DSH 保留预载）。
4. `dsh --profile dsh-tui` 直启路径是否继续支持。
5. PR #1216 先合入还是关闭（第 8 节）。
6. 是否接受 Claude 内核在 Phase 1 之后失去第三方 Cordis 插件扩展（5.7、6.2），或要求轻量
   profile 先行。
7. `@deepseek-ai/dsh/profile-boot` 加入 blessed 包与 peer 依赖。

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
   时间点打点不依赖屏幕，所以基线仍有效。可见首帧要在真实终端里手测。
