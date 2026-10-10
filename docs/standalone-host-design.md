# 独立宿主（方案 B）设计

[文档索引](README.md) · [架构与限制](architecture.md) · [多后端架构](agent-backend-design.md)

状态：Phase 0–2 已落地（分支 `feat/standalone-host`），根模型为**单根（D1）**；5.7 的轻量 profile
已落地，**Claude 内核已验收、Codex 内核未验收**。剩余项：轻量 profile 的组合成本计入首帧基线、
注册表归属与上游插件契约（#1247）对齐，以及 5.7 末尾两条遗留。已定结论见第 10 节。

## 一句话

dsh-TUI 从「DSH 的一个 Cordis 插件」变成「自己拥有入口与组装根的终端应用」：先挂界面与
后端中立的 channel 核心，再把后端打开。**DSH 仍是首要适配目标与首方后端**——`native.dsh`
与 DSH specialist 能力保持首方特权不变（第 10 节第 1 条）——但它不再是把 TUI 装进去的那层
宿主：它像 claude / codex 一样作为后端之一按需在进程内加载，原因是 DSH 自身的启动成本
（1.1）。Claude 内核不组合 dsh-base；它仍组合一个只装本包行与第三方插件的轻量 profile，
第三方插件扩展在两个内核下都保持可用（5.7）。

**整个方案只有一道门闩：channel 核心能在没有 Cordis `ctx` 的情况下构造。**Phase 0
做的就是这件事。

## 1. 背景

### 1.1 旧启动链（Phase 0 之前）

```text
dsh-tui（全局启动器）
  └─ spawn node <profile 内的 bin/dsh-tui.js>        （profile 启动器：对齐、安全模式重试）
       └─ spawn dsh --profile dsh-tui -- <app args>    （DSH 宿主进程）
            runProfile → composeProfile → boot(~94 行 dsh-base + 本包 20 行)
              └─ dsh-tui 行 apply → plugin.ts
                   选内核 → 打开后端 → createChannel(ctx, …) → render(Chat)
```

界面要等整个 profile 组合完、`dsh-tui` 行 apply、后端打开之后才出现（约 2 秒）。

现状（单根）见第 3 节：首帧不再等任何后端；`DSH_TUI_HOST_ENTRY=0` / `DSH_TUI_HOST_ENTRY_DSH=0`
退回上面的链（5.8）。

### 1.2 为什么不沿用预载

预载（PR #1216，`dst`：`--import` 先画一棵树、apply 里换上 live channel）能把首帧提前到约 0.6 秒，
但启动态 channel 要按 `ChannelUi` 端口逐项手写镜像并与真实 channel 交接，main 越活跃维护税越高；
Claude 内核也仍要白等整份 dsh-base 组合。只把入口换成本包、channel 仍在行的 apply 里建，同样不解决
这些问题——方案 B 指 **channel 核心离开 Cordis**。

### 1.3 已有的有利条件

多后端重构（#1312、#1313、#1322、#1323）之后，`src/agent/`、`src/backends/claude/` 不 import Cordis，
channel 核心后端中立（DSH 专属部分由 `channel/extensions.ts` 按 `native.dsh` 挂载），`tui*` 服务全由
本包自己的行提供，`@deepseek-ai/dsh/profile-boot` 提供稳定的嵌入入口。

## 2. 目标与非目标

目标：

- 首帧不依赖任何后端：界面在进程启动后立即以**真实** channel 核心挂载。
- Claude 内核启动时不加载 dsh-base（DSH 的核心行）；它仍组合一个轻量 profile 承载第三方
  插件（5.7）。
- 启动期没有第二套 channel：「启动中」是一个尚未就绪的会话，就绪时走 channel 现有的
  接管路径。
- 第三方 Cordis 插件现有的 `tui*` 扩展能力**在两个内核下都保持可用**（5.7）。

非目标：

- 不改 DSH 核心；只使用其公开导出。
- 不做进程隔离（worker / 子进程 + IPC），见 6.1。
- 不改变 transcript 真源规则：仍以后端持久化记录为准。

## 3. 目标架构

Phase 2 落地后的**单根**形态（第 10 节第 3 条）：

```text
bin/dsh-tui.js（启动器：对齐、安全模式、Windows 解析——保留）
  └─ spawn node <本包 lib/types/dsh-adapter/host-entry.js> <args>
       入口（host-entry.ts → host-dsh.ts）：用已装 dsh 的模块（realpath）建 Cordis 根
         ├─ 模块解析先于任何 TUI 模块加载（宿主那份 react 与 @deepseek-ai/*）
         └─ 本包运行时（plugin.ts 的 apply）挂在这个根上，deferBackendOpen
              └─ createCoreChannel(cordisChannelHost(ctx), pendingSession, …) ──► render(Chat)
                                                                                  ← 首帧在这里
       内核判定（hostEntryRoute.entryRoute）：
         ├─ claude / codex：不组合完整 profile；首帧后组合轻量 profile（5.7），
         │     运行时自己解析内核并打开后端
         │     └─ channel.adoptStartup(session)                          可发送
         └─ dsh：把 dsh-tui profile 组合进**同一个根**
               └─ dsh-tui 行经 entry-slot 的 globalThis 槽发现已挂载的界面：**不画第二棵树**
                    ├─ resolveAgent → createDshSession
                    ├─ channel.adoptStartup(dshSession，挂 DSH 扩展——晚挂 D1)
                    └─ 失败 / 无 dsh-tui 行 → 槽的 composeFailed / composeWarning
```

单根下宿主就是那个 Cordis 根：`tui*` 服务与 DSH 服务住在同一棵树上，界面与第三方插件看到同一个根（5.1）。

依赖方向（终态）：界面 → ports；channel 核心 → agent + ports + **`ChannelHost` 接口**；Cordis 只
出现在 `src/dsh-adapter/`（DSH 后端与宿主复制）。

## 4. 现状的 Cordis 依赖与归属

**Phase 0 已完成**：channel 核心里原先直接读 `ctx` 的位置（均在 `core/compose.ts`）都改经
`ChannelHost`，`channel/core/` 不再 import 任何 `@deepseek-ai/*`（门禁见
`scripts/verify-adapter-boundary.ts` 的 `CORE_DIR`）。仅 DSH 会话用的服务（`agents`、`llm`、`approval`
等）归 DSH 后端；日志、effect、退出漏斗与 `tui*` 注册表归那个 Cordis 根，`ChannelHost.get` 每次实时取。

## 5. 关键设计

### 5.1 ChannelHost：把 CoreHost 补全（单根下由 Cordis 根充当）

不新造抽象，扩展现有的 `CoreHost`（`core/host.ts` 的
`resolveCoreHost(host, owner)`）。宿主接口叫 `ChannelHost`
（`src/dsh-adapter/channel/channel-host.ts`），当前实现只有 `cordisChannelHost(ctx, services)`
（`channel/cordis-host.ts`）。

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
- **边界门禁**：`src/dsh-adapter/channel/core/` 不得 import 任何 `@deepseek-ai/*`，也不得
  依赖 extensions / backend（`scripts/verify-adapter-boundary.ts` 的 `CORE_DIR` 规则）。
- **注册表实时取**：`resolveCoreHost` 的 `themeHost` / `workspaceService` / `commandTrees` /
  `sceneRuntime` / `settingsSectionsRuntime` / `rendererRuntime` 都是 getter，DSH 晚到时它带来的
  注册立刻可见；`startHostSubscriptions` 经 `watchServices` 在服务变动时重绑，授权存储每次操作重读
  （`core/host.ts`）。

### 5.2 启动时序

Claude 内核：

```text
entry ─► 宿主就位（读设置、主题、语言、内核判定）
      ─► createCoreChannel(host, pending)  ─► render(Chat)        首帧
      ─► openBackendStartup(host, claude)   （SDK、转录、CLI 握手）
      ─► channel.adoptStartup(session, history)                   可发送
```

DSH 内核：

```text
entry ─► 同上直到首帧
      ─► 解析宿主的 @deepseek-ai/dsh 模块（取 PATH 上 dsh 的 realpath），设置 DSH_TUI_* 环境变量
      ─► 把 dsh-tui profile 组合进同一个根
           └─ dsh-tui 行 apply：经 globalThis 槽取到已挂载的界面
                ├─ resolveAgent → createDshSession
                └─ channel.adoptStartup(dshSession, { attach: dshExtensions })
```

内核判定沿用 `resolveRememberedBackend`（handoff → 配置行 → `DSH_TUI_BACKEND` →
`kernel.json`）。配置行的 `backend` 由入口直接解析
profile 补丁里 `dsh-tui` 行读取（`hostEntryRoute.configuredBackend`），不经 app-boot。

### 5.3 未就绪会话与启动接管

- **占位会话。**一个合法的最小 `AgentSession`：`status: 'starting'`、
  `capabilities: { native: {} }`、空 history；`submit` 不发出，交给 channel 缓冲。
- **启动接管。**`ChannelLaunchOptions.startup` 传入仍在打开的会话
  （`Promise<{ session, history }>`），channel 在 `start()` 里自己接管：用 binding 的
  `prepare` + `adopt`（`prepare` 在打开返回时检查 capture，channel 已释放或已被 `/new` 换掉
  就直接关掉迟到的会话，正好覆盖「启动期退出」）。尾段不走 `adoptWith`：不清 `rows`/`pending`
  （启动期本地命令打印的行要留下），只重置投影、换身份、`cwd`（resume 的真实 cwd 打开后才知道）、
  能力快照、`subagentControl`、命令表，然后 `bind(history)`。**不复用** `newSession` /
  `resumeSession`：它们在 `working` 时拒绝、遇到排队输入会放弃候选（`raceProbe`），还会触发
  `tui/session-switch` 否决与切换提示——这些都不适合启动接管。
- **启动期输入。**草稿留在输入框不发送：Enter 提示「还没就绪」，只放行纯本地命令
  （exit/help/theme/lang/vim/kernel 与重试用的 new/resume，`isBootSafeCommand` 白名单，
  `ChannelUi.ready`）。启动期 `/new` 由 binding 裁决：先到者绑定，迟到的启动会话被关闭。不采用
  「缓冲进 FIFO、接管后重放」：`resetSessionProjection` 要为启动接管单独开特例保留
  pending，且重放会让用户在看不到会话状态时把消息发出去。
- **构造时就定死的字段改为可延后**：`backendLabel`、`messaging`、
  `subagentControl.history` 是否存在、`defaultOpeners`（依赖 `options.openSession`）、
  `snapshotOf` 里的 `dsh` 标记、`attachSessionWorkingActivity`。占位会话按**目标内核**的选项
  构造，这些值在 `adoptStartup` 时更新。
- **DSH 扩展晚挂（D1）。**允许在启动接管时挂一次扩展，扩展里对 `binding.agent` 的读取延后到
  挂载时。这是方案里改动最深的一处 channel 重构。
- **启动失败。**界面已在：失败在界面里落一条提示行（原因 + `/new` 重试 · `/kernel` 切换 ·
  `/quit` 退出），占位会话保持绑定、`ready` 保持 false；`/new` 经 `openSession` 打开新会话并接管。
  退出时仍在进行的打开由 `prepare` 在返回时关闭；Claude 的 `open` 没有中止入口，进程若在打开
  返回前退出，CLI 子进程靠 stdin 关闭自行退出。后端模块本身加载失败（包损坏）时入口直接报错
  退出，由启动器的安全模式接住。

### 5.4 DSH 后端：进程内加载

`runProfile` 的 `boot()` 必建新根，「直接用 `runProfile`」即两根；单根形态改为复刻其 `prepare`，
用 app-boot 导出的 `mountRootInclude` 等原语把 profile 组合进入口的根。复刻面与偏差的唯一来源是
`src/dsh-adapter/host-contract.ts`（见 ADAPTER.md「独立入口的宿主契约」）。

- **模块身份。**必须 import **宿主的** `dsh` / `dsh-app-boot` / `cordis`（从 PATH 上
  `dsh` 的 realpath 用 `createRequire` 解析），不能用本包 peer 依赖的副本，否则会出现
  第二个 Cordis 实例。宿主 cordis 是嵌套副本，模块身份与解析劫持的先后是判别约束。
- **环境变量先于组合。**`cordis.patch.yml` 的 `dsh-tui` 行用 `!!js process.env.X` 读
  `DSH_TUI_*`，在组合时求值，所以 entry 要在组合前设好；
  `loadLayeredEnv('dsh')` 会把 `.env` 层写进 `process.env`。
- **契约。**依赖、能力探测、回退与门禁见 [ADAPTER.md](../ADAPTER.md)「独立入口的宿主契约」。

### 5.5 进程所有权与退出

单根下进程所有权没有新问题：TUI 今天已经和 DSH 跑在同一个进程里，SIGINT/SIGTERM 处理、
`installFailLoud`（未捕获异常 → 释放 app fiber → `process.exit(1)`）、`createProcessShutdown`
（dispose 后设 `exitCode`，超时强退）都在。（两根下 `runProfile` 的信号处理与 `installFailLoud`
不可关闭，会与入口自己的处理器冲突——这是选单根的理由之一。）变化只有：

- 入口拥有退出漏斗：fiber dispose 时先恢复终端（raw 模式、光标、alt-screen、同步输出、鼠标、
  焦点），再让 DSH 的退出继续。
- 另加一个 `process.on('exit')` 兜底（`src/dsh-adapter/process-exit.ts`）。
- raw 模式下 Ctrl+C 不产生 SIGINT，与今天一致。

### 5.6 设置存储（已定：(a)，Phase 1 已实现）

实现：`~/.dsh-tui/settings.json`（`src/tuiSettingsFile.ts`）+ 设置服务
`src/dsh-adapter/tui-settings.ts`。**两个内核都用它**：plugin.ts 不再等宿主的 `settings`
服务，`dsh-tui` 分区经文件作用域同步应用，`/settings` 屏的读写经同一服务；其他命名空间转给宿主
的设置服务（独立入口里没有）。导入：文件不存在时从 `~/.dsh/profiles/<profile>/cordis.patch.yml`
的 `dsh-tui` 行 `config` 取可编辑键（跳过 `!!js`），写入并记下来源，之后不再导入；profile 只读
不改。已知差异：导入后补丁里残留的这些字段在 DSH 内核下仍是 Config 的一部分，用户层 unset 时
会作为兜底出现，独立入口没有这层——配置文档建议删掉残留。DSH 的 Web 设置页改的是 Config，
不再影响 TUI。

选择依据：`dsh-tui.*` 的值原本住在 profile 的 Config 行里，经 DSH 的 `settings.mutate`（带版本号
的围栏写入）写回；Claude 内核不组合 dsh-base（DSH 的 `settings` 行在其中）时**写**没有去处。
(a) 让两个内核共用一份设置、首帧读设置不需要 app-boot；代价是文件布局变化与迁移。被否的 (b)
「继续住 Config」会让 Claude 内核下设置只读，或绕过版本围栏直接写 profile 文件。

`src/settings/definitions.ts`（纯元数据）与 `tuiSettingsSchema` 继续是唯一定义来源。

### 5.7 插件生态桥接

- 第三方插件从 `@deepseek-harness-tui/dsh-tui/extensions` 等子路径拿类型，
  `inject: [tuiPanels, …]` 拿服务；单根下注册表就是那个 Cordis 根的同名服务，插件代码不需要改。
- **插件在两个内核下都存在。**它们是 Cordis 插件，需要一个 Cordis 根。Claude 内核不再组合完整
  profile 后若不补，第三方扩展就没有了——这个缺失不可接受。Claude 内核路径
  因此组合一个**轻量 profile**：只装本包的行与 profile 依赖清单里声明的第三方插件，不装 dsh-base
  （DSH 的 agent / llm / tools / workspace 等核心行）。根已经有了，缺的是把插件清单组合进来。
- **首帧不受影响。**profile 在首帧之后加载，插件的 `tui*` 注册走运行期热加入。
- **实现形状。**往入口那个裸根里按清单装配：入口用 app-boot 的 `mountRootInclude` 把一份**轻量
  组合**挂到同一个根上（裁剪表在 `lite-profile.ts`，组合在 `host-dsh.ts` 的 `composeLite`），本包
  的行与第三方插件随之进入这个根；`dsh-base` 那层被裁掉，只由它提供服务的行按表禁用（依据是
  「行的 `inject` 缺哪些服务」，实测对账；`scripts/verify-lite-profile-rows.mjs` 守表与 patch 行 id 的对口）。
  另一条候选（另建一根再桥接）被否：两根下第三方行会永久 pending，且它们的 effect 需要第二个
  释放点。
- **接线。**组合挂在首帧之后：入口等 `HostComposeSeam.firstFrameFlushed` 再组合，组合成功（已
  审计）后调用 `composeSucceeded`，运行时据此重读挂载时取值的接缝（主题 host、扩展 store、toast
  sink），并把本包的 `/settings` 分节迁到组合的 sections 服务（`rehomeSettingsSection`）。
- **验收。**Claude 内核用隔离 profile + 测试插件（主题、面板、决策拦截）在真实终端中验收：面板落在
  插件自己的身份下、`tui/input` 与 `tui/session-switch` 拦截生效、budget 与 storage 按身份计入、运行时
  主题在组合结算后上屏、`/settings` 出现 `dsh-tui` 分节。**Codex 内核走同一条组合路径但未验收。**
  主题锁只认 `DSH_TUI_THEME`：`theme.json` 的持久化偏好不算锁，品牌默认档（`branding.ts` 的 `*_BRAND_THEMES`）在它之上。
- **成本待测。**省掉的是 dsh-base 的组合段；轻量 profile 自身的组合成本要计入 Claude 内核的
  首帧对比基线。
- **与上游插件契约的关系（待对齐）。**本包的注册表归属、grants 与 `apiVersion` 会被上游的插件
  体系冻结看见（上游 issue #1247 要求把「接口 / 清单 / 管理器 / 市场 / 兼容性」一体设计后再
  实现）。归属形状要与那份契约对齐，不要先冻在「注册表住在 Cordis 树里」上。
- 决策事件（`tui/input`、`tui/session-switch` 等）：没有处理器时直接放行；启动期（后端未就绪）
  的输入本就不发送，不存在绕过拦截的窗口。
- **遗留项 1**：`/theme` 的**交互路径**（从 `/theme` 里选主题到上屏）在轻量内核与 DSH 内核上都
  没有验收覆盖；现有用例只断言由持久化偏好或环境变量驱动的主题。
- **遗留项 2**：`composeLite` 的 `trimmed=false` 分支「warning 后继续整份组合」没有入库的自动化
  覆盖。残留风险：判「有没有可裁的层」看的是清单里有没有 `excludedBundles` 那几个**写死的 bundle
  名**（`lite-profile.ts`）；若 dsh-base 的行以后经别的 bundle 名进清单，计划会被判成「无可裁」并
  静默继续整份组合——从旧行为的「exit 1 + 启动器 safe mode」变成静默接受，且 warning 只走调试
  日志通道。

### 5.8 启动器

入口是 `lib/types/dsh-adapter/host-entry.js`（`src/dsh-adapter/host-entry.ts`），路由判定在
`src/hostEntryRoute.ts`。

- 三进程链（全局启动器 → profile 启动器 → dsh）在 Claude 内核下变成：全局启动器 →
  profile 启动器 → `node <本包 entry>`。对齐检查、安全模式重试、Windows 下 `dsh.cmd`
  的解析留在 profile 启动器。
- **判定分两半。**启动器零 lib 依赖、读不到 profile 补丁的 Config 行，只按「一次性交接 →
  `DSH_TUI_BACKEND`（`--backend`）→ `kernel.json`」判定；入口再按插件同样的排序判一次，
  加上补丁里 `dsh-tui` 行的 `backend`。入口判定为 DSH 而走委托路径时原样交给
  `dsh --profile <profile> -- <应用参数>`：环境、stdio 与交接 ACK 管道（fd 3）透传，由真正接管
  屏幕的 dsh 进程发 ACK，入口只转发退出。
- `restartTui` 默认用 `process.execPath` + 原 argv 重起；目标内核是 Claude 且启动器给了
  `DSH_TUI_HOST_ENTRY_PATH` 时改为重起到入口（`restartArgv`，只带 dsh `--` 之后的应用
  参数），否则 DSH 进程里的 `/kernel` 切到 Claude 会走整套 DSH 组合。
- 一次性开关（`--version`、`--dump-config*` 等 dsh 前缀参数）继续直接交给 dsh。
- 关闭开关 `DSH_TUI_HOST_ENTRY=0`：所有内核回到 `dsh --profile`。设置文件（5.6）不随开关回退。

## 6. 已知并接受的限制

### 6.1 DSH 加载的同步阻塞

DSH 的模块加载与组合在进程内有约 1 秒的同步段，这期间事件循环被占住，界面不刷新。方案 B 只能
做到「先画后冻」，与预载分支相同。不走 worker 或子进程隔离：父进程 + IPC 的设计在预载方案中做过
并回滚了——启动屏必须是同一棵已挂载的树、零可见切换，而跨进程桥接把每个 `ChannelUi` 端口都变成
IPC 协议，维护成本比手写镜像更高。

首帧侧已落实的缓解（口径：同一时间窗内 `A1 B1 A2 B2` 交替配对，读配对差中位数）：

- **compile cache。**启动器给 entry 子进程注入 `NODE_COMPILE_CACHE=<数据目录>/compile-cache`
  （纯 env 注入；用户已设值与 `NODE_DISABLE_COMPILE_CACHE` 照旧生效，`/restart`、`/kernel` 随 env
  继承）。冷热差约 190ms；走 `dsh --profile` 的路径（`DSH_TUI_HOST_ENTRY=0` / `DSH_TUI_HOST_ENTRY_DSH=0`）不受益。
- **首帧图瘦身。**`lodash-es` 改按路径导入（`verify-source-hygiene` 拦 barrel 导入）约 −126ms；启动器的
  `dsh --version` 预检改为异步、不占关键路径约 −46ms；更新检查让出首帧 + `semver` 按路径导入约 −26ms。
- **未做。**模块图打包（瓶颈是模块解析与链接次数；就地打包 `lib/types` 实测 render-done 约 −20%，
  另行提交）、`/migrate` 懒加载、首帧前的 `zod`（经 `dsh-user-questions` 同步挂载）、首帧不依赖宿主
  准备段（约 135ms，结构性改动）、冻结前画出「正在启动 DSH」的静态状态。

### 6.2 其他

- 内核在一次进程里只接管一次；运行中切换内核仍然要重启（`/kernel`），与今天一致。
- `dsh --profile dsh-tui` 直接启动（不经本包 entry）保留（第 10 节第 4 条）：没有入口槽时
  `dsh-tui` 行按其既有路径自己渲染（`entry-slot.ts` 头注释），但没有专项实现与验收。

## 7. 分期

全部已落地（3 无代码可删）：

- **0**：`ChannelHost` + `cordisChannelHost(ctx)`；channel 核心改收宿主接口；`verify:boundary` 的 `CORE_DIR` 规则。
- **1**：设置存储（5.6）；本包 entry 自持裸 Cordis 根、`plugin.ts` 的 `apply` 原样挂载；占位会话 + `adoptStartup`；Claude 内核走 entry。
- **2**：入口根换成宿主模块、DSH 组合进同一个根（单根）；DSH 扩展晚挂（D1）；轻量 profile（5.7）；宿主契约（5.4）。能力探测失败或 `DSH_TUI_HOST_ENTRY*=0` 时回退到 `dsh --profile`。
- **3**：预载分支（`src/preboot/`、`deferred.ts`、`bin/dst.js`）从未进 `main`；`onProcessExit` 兜底已吸收为 `process-exit.ts`（5.5）。

## 8. 与 PR #1216（预载）的关系

PR #1216 已关闭、分支作废，其文件从未进 `main`；compile cache 已吸收（6.1），`onProcessExit` 兜底见 5.5。

## 9. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 入口复刻的宿主接口在 DSH 新版本漂移（`host-contract.ts` 的 HOST_MODULES / HOST_REPLICAS） | DSH 内核启动失败 | 能力探测 + 回退到 `dsh --profile`；`verify:contract` 的复刻指纹（`host-replica.snapshot.json`）与版本线 |
| 宿主模块身份解析错误（加载了第二份 Cordis） | 插件服务注册到错误的根 | 只从宿主 realpath 解析；回归里断言单实例 |
| 设置迁移出错 | 用户设置丢失或回到默认 | 迁移只读不删原值；失败时继续读旧层 |
| Claude / Codex 内核下第三方插件缺失或注册表归属与上游冲突 | 插件扩展退化 | 轻量 profile（5.7）；注册表归属待与上游插件契约（#1247）对齐 |

## 10. 已定结论

| # | 议题 | 结论 |
| --- | --- | --- |
| 1 | 定位 | 「拥有入口的终端应用」；DSH 仍是首要适配目标与首方后端（`native.dsh` 与 specialist 能力的首方特权不变），只因其启动成本以独立后端形态存在 |
| 2 | 设置存储 | 见 5.6 |
| 3 | 根模型 | D1「单根」，见第 3 节与 5.1 |
| 4 | `dsh --profile dsh-tui` 直启 | 继续支持；没有专项实现与验收，现有覆盖仅启动器的 `DSH_TUI_HOST_ENTRY=0` 回退（`verify-launcher.mjs`） |
| 5 | PR #1216 | 关闭、分支作废（第 8 节） |
| 6 | Claude 内核的第三方插件扩展 | 缺失不可接受，见 5.7 |
| 7 | `@deepseek-ai/dsh` | 不是依赖：入口按宿主 realpath 加载已装的 `dsh`，只为类型声明 `HOST_TYPE_PACKAGES`（5.4） |
