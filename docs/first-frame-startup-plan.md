# 首帧启动优化：诊断与方案

[文档索引](README.md) · [独立宿主设计](standalone-host-design.md)（6.1「DSH 加载的同步阻塞」是本文的上下文）

状态：诊断完成（2026-10-09，`feat/standalone-host`，基于 lib 打包产物——
`scripts/bundle-lib.mjs`，诊断时尚未提交、现已入库；`lib/types/chunks/` 104 个 chunk）。**3.1（按路径导入 + 门禁规则）与
3.2（候选 c）已落地到源码并复测**（测量协议见 §4，**实测与复核结论见 §5**：3.1-a 的「≤3」判据
物理不可达；**结论口径以逐轮交替对照为准：3.1 ≈ 126ms、3.2 ≈ 46ms，两项合计约 170ms**——独立
裁定 I 推翻的是早期块级口径对 **3.2 单项**约 2.2–2.5 倍的高估，见 §5.7）；3.3 / 3.4 / 3.5 未落地，
仍是测得的成本或估算。**3.7（更新检查让出首帧 + `semver` 按路径导入）已落地并 A/B**（2026-10-10，§5.8：渲染段
−26ms、16/16 同号）。

## 1. 范围与口径

- **首帧** = 可见占位帧。测量以启动打点 `entry-first-frame-flushed`（`DSH_TUI_THEME=dark` 下）
  为准——它的语义正是「占位帧已 flush 到终端」；`render-done` 降级为「ink 挂载完成」：它只
  `await Promise.resolve()` + `renderSync` 后立即返回、不等 flush，且主题未定时首帧可能是空帧。
  屏幕侧另有占位行读数（`/Starting (DSH|claude)/`）作旁证。
- **口径修订（2026-10-10，独立裁定 I）**：`entry-first-frame-flushed` 不是「更晚的可见帧」，而是
  **同一帧写入后被 stdout 排空确认**的时刻（`host-entry.ts` 在 `firstFrameFlushed()` 之后打点，
  其实现是 `render()` 的 `onFrame` 已 resolve + 一次 `stdout.write('')` 回调）。屏幕侧字节读数与
  `render-done` 逐轮几乎重合（差 0–7ms），比 fff 早 81–89ms。因此 fff 是**保守但无害**的代理
  （A/B 差不受这一常数偏移影响），它与「可见首帧」**不矛盾**；早期把它解读成「与本节结论相反」
  属过度解读，已按 I 的裁定更正。
- 不在范围内：DSH 内核的「可发送」（`startup-adopted` ≈ 1.8s）受首帧之后约 1.1s 的 DSH 组合
  支配，那是 DSH 域，本包只能「先画后冻」（已做，见设计文档 6.1）。Claude 内核 prompt ≈ 875ms。
- 不考虑：minify（崩溃栈失去行号，设计文档 6.1 已记）；worker / 父进程 + IPC（预载方案做过并
  回滚，启动屏必须是同一棵已挂载的树）。
- 单位 ms，从 spawn profile 启动器算起；WSL2、Node 24.20、16 核、空闲机器。轮次用 `A1 B1 A2 B2`
  交替配对协议（每段 4 轮、每臂 8 轮），报两臂合并中位数、配对差与四分位距；某轮开始时
  `loadavg(1m) > 0.5 × nproc` 即该轮作废并重测。

### 1.1 探针的方法学问题：每轮都是冷编译缓存，且主题探测吃满超时

`scripts/probe-startup-baseline.mjs` 的 `run()` 每轮 `rmSync(join(root, '.dsh-tui'))`——同一行
同时制造两个伪影：

1. **冷编译缓存**。启动器注入的编译缓存目录正是 `~/.dsh-tui/compile-cache`
   （`bin/dsh-tui.js` `withCompileCache`），HOME 指向隔离根 → 缓存每轮被删。
2. **每轮重来一次主题探测**。同一个 `rmSync` 也删掉 `theme.json`（`themePrefs.ts` 的 `DATA_DIR`
   = `~/.dsh-tui`），而探针的 xterm harness 只把**键盘输入**转发给子进程、**没有 OSC 11 应答器**，
   于是 `ThemeProvider` 发出的探测吃满 `DETECT_TIMEOUT_MS = 400`。它影响的是**可见帧内容**
   （首帧可能是空帧），不阻塞任何 `markBoot`：`at.prompt` 远晚于 400ms 超时，延迟已被吸收。

落实时的测量把两者都从被测路径摘掉：外部固定 `NODE_COMPILE_CACHE`（启动器尊重已有值）
+ `DSH_TUI_THEME=dark`（`envThemeOverride()` 命中后不回 null、不发探测）。另注：`--entry profile`
分支走 `startDshSession`，**本就不经过** `withCompileCache`，所以冷热对比只对 host 入口成立。

| 口径 | DSH 内核 render-done |
| --- | --- |
| 探针原样（冷缓存 + 每次主题探测） | ≈ 890 |
| 外部固定 `NODE_COMPILE_CACHE`（warm，启动器尊重已有值） | ≈ 700 |

真实用户的 HOME 持久，**以 warm 为准**。冷 profile 里 `compileSourceTextModule` 自身 175ms，
warm 后 55ms。

> **口径差**：本节的 warm ≈700 与 §5 落实 A/B 的 A 臂 819.5 **不是同一次读数**（常驻 dsh 会话抬高
> 绝对值、测量协议与机器负载都不同），跨口径只能比配对差。详见 §5.1。

编译缓存的收益有三个不同 harness 下的数，不能混着引用：设计文档 6.1 记 `render-done` −80ms、
其独立复现 −143ms、本文 1.1 的冷热差 ≈190ms。−80 是 5 对中的低值，−143 与 ≈190 同量级。

后续动作：

- 探针保留 `compile-cache` 子目录（只删其余状态），另加 `--cold` 开关显式测冷启动；主题探测
  要么由 harness 应答 OSC 11，要么按本次做法用 `DSH_TUI_THEME` 固定。
- 复核设计文档 6.1 里 compile cache 的收益（render-done −80ms、方差大）是否出自这个探针；若是，
  那组数字是在缓存被擦的条件下测的，需要重测重标（本次测到的冷热差约 190ms）。

## 2. 诊断

工具（均为一次性脚本，未入库）：

- 启动打点：`DSH_TUI_BOOT_TRACE`（`src/utils/bootTrace.ts`），经探针采集。
- CPU 采样：经 `NODE_OPTIONS=--import=<preload>` 在每个 node 进程里用 `node:inspector` 的
  `Profiler`（采样间隔 200µs）定时停采落盘——不依赖进程正常退出（探针用 SIGTERM 收尾）。
  采样本身使首帧推迟约 130ms，只看相对占比。
- 模块清单：同样经 preload 用 `module.registerHooks({ load })` 记录每个模块的加载时刻与源码
  大小，再按 boot trace 的打点切成阶段。

### 2.1 首帧时间线（warm）

DSH 内核：

| 打点 | 时刻 |
| --- | --- |
| entry 进程启动（`dsh-process`） | 103 |
| `entry-start`（host-entry 静态 import 完成） | 154 |
| `entry-hijacked`（宿主根与解析劫持就绪） | 288 |
| `entry-modules`（TUI 模块加载完成） | 665 |
| `render-done` | **700** |
| `startup-adopted` / prompt | 1839 / 1922 |

Claude 内核：`entry-start` 141 → `entry-hijacked` 278 → `entry-modules` 669 → `render-done`
**727** → prompt 875 → `startup-adopted` 1318。两个内核首帧前的结构相同。

### 2.2 分段归因

| 段 | 耗时 | 内容 |
| --- | --- | --- |
| 启动器 → entry 进程 | ~100 | 启动器在 spawn entry 之前同步 `spawnSync('dsh --version')` 做预检（`bin/dsh-tui.js` profile 副本分支），self time 约 81ms |
| entry 静态 import | ~50 | node 启动 + host-entry 静态图；其中 67 个 `yaml` 模块（经 `hostEntryRoute.ts` → `tuiSettingsFile.ts`，约 15ms） |
| **宿主 dsh 准备** | **~135** | `loadHostDsh` + `prepareHostRoot`：dsh-app-boot 的 `createRuntimeResolution`（`collectInstallationScopePackages` 扫描安装域全部包的 manifest + realpath，约 57ms）、`PluginPackages`（约 29ms）、`installRuntimeInterception`、`prepareProfile`（约 16ms） |
| **TUI 模块加载** | **~380** | 1050 个模块（**列举非穷举**：算术合计 992，缺口 ~58 未归因）：**`lodash-es` 640**、`zod/v4` 94、DSH 会话域包约 30、`semver` 46、`diff` 19；本包自身 163 个文件约 7MB（`Chat` 1.3MB、`channel` 0.8MB、`ui` 0.8MB…） |
| apply + render | ~35 | 不是瓶颈（React render 12ms） |

warm 下 TUI 模块段的 CPU 热点是**模块解析与链接的次数**（`lstat`、`internalModuleStat`、
`getPackageScopeConfig`、`realpathSync`、`ModuleWrap`、`syncLink`），编译只剩约 55ms——与设计
文档 6.1 打包一节的结论一致：要降的是模块数。

### 2.3 宿主段为什么在首帧路径上

按设计意图宿主段不该参与首帧，但当前代码里它**在**，且是现有结构决定的：`runInEntry` 第 1 步
必须先 `loadHostDsh()` + `prepareHostRoot()`，之后才 import TUI 模块，因为

- TUI 对 `@deepseek-ai/*` 的值 import 要经宿主装上的解析劫持，路由到已装 dsh 的**同一份实例**
  （实例重复的后果见设计文档 6.1 打包一节的 `required plugin did not activate`）；
- Cordis 根就是 `root.ctx`，`apply` 需要它。

代价两份：前置约 135ms；劫持钩子包住此后每次 ESM 解析（dsh-app-boot `adaptEsm` 包装
`loader.resolveSync`），在 TUI 模块段里自身路由开销（`routeUrl` + `hasInterceptionLayerForUrl`）
约 30ms，其余约 135ms 是原生解析本来就要花的。

### 2.4 首帧前加载、但首帧用不到的东西

- **`lodash-es` 整包**：`src/components/WorkingSpinner.tsx:7` 的
  `import { sample } from 'lodash-es'`。单独测 warm 导入：barrel 151ms，`lodash-es/sample.js` 8ms。
- **DSH 会话持久化链 + zod**：`src/screens/Chat.tsx:113` 值 import `MIGRATION_ADAPTERS`
  （`src/dsh-adapter/migrate/index.ts`），后者静态 import `@deepseek-ai/dsh-session-persistence-jsonl`
  与 `@deepseek-ai/dsh-session`，带进 session-format v0→v4 迁移链、image-offload、dsh-agent、
  dsh-tools、dsh-sandbox 等与 zod/v4。只为 `/migrate` 命令。**只改 `:113` 无效**：`Chat.tsx:111`
  还静态 import `migrate/picker.js`，而 `picker.ts:11` 静态 import `./index.js`——同一条链有第二个
  入口，必须一起打断。单独测：持久化链约 37ms，zod 约 31ms（真实加载交错，两者有重叠）。
  DSH 内核下这些在组合期本来就会加载（只是挪到首帧之后）；Claude 内核下是纯浪费。
- **同类待审计面（A 报告 6c，本次未逐项拆）**：`Chat.tsx` 的对话框/向导组件一族
  （`MigrateConfirm`、`MigratePicker`、`SdkInstallWizard`、`providerWizard` 等）都静态挂在首帧图上；
  它们与上面的 `/migrate` 链同源，`/migrate` 之外还牵扯 `migrate/picker.js` 与 `recent-agents` 两条
  入口。拆它们属于 §3.3 的独立小计划范围，去向见 spec ⑥-1 的附带项降级。
- **`semver`**：由**渲染器**引入，与 entry 的 `import('../update.js')` 无关——`src/ink/terminal.ts:1`
  值 import `{ coerce } from 'semver'`，而 `ink.tsx:46` 静态引 `./terminal.js`，所以 semver 必在
  首帧图内（CJS，46 个文件，约 10ms）。同理「把 `logRestartEvent` 拆到不依赖 semver 的小模块」
  无效：`plugin.ts:60` 与 `Chat.tsx:3` 也静态 import `update.js`，拆掉后 semver 仍经渲染器进入。
  `dsh-session` 的归因亦须更正：`migrate/index.ts:18` 的 `SessionId` 是**纯类型导入**，因 tsconfig
  无 `verbatimModuleSyntax` 被 tsc elide；真实来源是 channel 域的值使用（如
  `channel/subagent-transcript.ts:31` 的 `SESSION_FORMAT_VERSION`），它首帧即需要。
- **React 双构建**：ESM import CJS 时 Node 用 cjs-module-lexer 推导命名导出，会把
  `react` / `react-reconciler` 的 `index.js` 两个分支的 re-export 都读进来词法分析（development
  版 794KB）。实测 ESM 与 CJS 加载只差约 4ms，**不值得处理**。
- 首帧之后：DSH 内核也加载了 `@anthropic-ai/claude-agent-sdk`（1.2MB，约 40ms）。不影响首帧，
  但落在「可发送」之前的冻结窗口里，记一笔。

## 3. 方案

按证据等级排序。叠加目标：warm `render-done` 700 → **约 450–500ms**（口径更正：§1 已把「首帧」钉在
`entry-first-frame-flushed` 上，此处的 700 是 `render-done`；落实实测见 §5.1）。**本次只落 3.1 + 3.2**
时预期 700 − ~115（3.1）− ~80（3.2c）≈ **505ms**；450–500ms 需要 3.3 与 3.4 一并落地。

### 3.1 `lodash-es` 改为按路径导入（**已落实**：源码 + 门禁规则）

- 改法：`src/components/WorkingSpinner.tsx:7` 改成 `import sample from 'lodash-es/sample.js'`
  （同仓库既有 `lodash-es/noop.js`、`lodash-es/throttle.js` 的写法；`lodash-es` 无 `exports`
  字段 → 子路径可解析，`@types/lodash-es/sample.d.ts` 覆盖类型）。`sample` 仍是同一个函数，
  `:59` / `:61` 的 `sample(...) ?? 'Working'` 语义与兜底不变。
- **验证（落实前 · bundle 产物预算实验）**：在 `lib/types/chunks/Chat-*.js` 上做同样替换，同一时间窗
  交替测 6 轮——`entry-modules` 665 → 548，`render-done` **700 → 586（−16%）**；对照组复测 700。
  产物已还原。**这不是落实后的复测**：落实后的源码态实测见 §5.1（`render-done` 819.5 → 652.5、
  `entry-modules` 719 → 548、`lodash-es` 640 → 43），两套数字口径不同，不可相减。
- 防回归：**只保留方案 a**——`scripts/verify-source-hygiene.mjs` 的 `rules` 数组加一条
  `['lodash-es barrel import', /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"]lodash-es['"]/, ['docs/']]`
  （该门禁已在 `run-verify-build.mjs` 的 GATES 内，维护成本近零）。规则覆盖**命名包根的全部形态**：
  `from 'lodash-es'`（import / export-from）、副作用 `import 'lodash-es'`、`require('lodash-es')` 与
  动态 `import('lodash-es')`；按路径写法（`lodash-es/sample.js`）因引号必须紧跟包名而不命中。
  `docs/` 必须豁免：本文 §2.4 与 §3.1 逐字引用旧写法作对照。候选 2（在 `bundle-lib.mjs` 里把
  lodash-es 等从 external 拿掉、交给 rollup 内联摇树）**删除**：`bundle-lib.mjs:246`（该脚本属
  在途 bundle 改动，截至 `0193f542` 尚未入库）的
  `treeshake: false` 是承重设计（注释已实测 7.68MB → 7.62MB），且内联 CJS 的 semver/diff 还缺
  `@rollup/plugin-commonjs`。

### 3.2 去掉启动器的同步预检（**已落实**，候选 c；CPU profile self time ≈81ms，端到端 A/B 见 §5.1）

- 现状：profile 副本分支在 spawn entry 之前同步 `spawnSync('dsh --version')`，等于完整起一个
  dsh 进程。真实用户的链路是「全局瘦壳 → spawn profile 副本 → 预检 → spawn entry」，比探针
  （直接起 profile 副本）还多一跳 node 启动。
- 改法候选：
  - 候选 a（PATH stat 代替 spawn）：**不采纳**——要新写 POSIX PATH 遍历 + Windows `PATHEXT`
    遍历，与 `src/dsh-adapter/host-dsh.ts:147` 既有的 `['dsh.cmd','dsh.ps1','dsh']` 顺序形成
    **第三份规则**；且把「真的跑起来且退出码 0」降级为「文件系统上存在可执行项」（shim 缺 node
    或权限破损以前给安装指引、之后退化为 `launchFailed`）。
  - 候选 b（入口不预检，交给 entry 的 host-unavailable 分支）：**删除**——`verify-launcher.mjs`
    第 5 节的三条 `noDsh` 双语断言会转红（硬阻塞）；沙箱里 `dshInEntry=false` 且
    `launchKernel()='dsh'` → 落 `startDshSession` → `launchFailed`，**不再产生 `noDsh`**。
  - **候选 c（采纳）**：探测**异步化**，结果只在「即将起 dsh」的出口消费——`bin/dsh-tui.js`
    在 `cmd` 定义之后加 `probeDsh()` / `requireDsh()` 两个 helper（内联，零 lib 依赖），预检块
    换成 `void probeDsh()`，路由 `else` 分支（下面就是 `dsh --profile`）加 `await requireDsh()`。
    保留**真跑探测**、零平台代码、`noDsh` 文案与退出码逐字不变。
  - **落实现场发现**：helper 里**不能** `child.unref()`——`requireDsh()` 会 await 它，届时若它
    是唯一的活跃句柄，Node 会把这个顶层 await 判成永不结算、以 exit 13 直接终止启动器
    （`verify-launcher` 实测 24 项转红）。探测就是 `dsh --version`，~80ms 自行退出，无需 unref。
  - 附带解掉一个非性能缺陷：现状预检在 profile 副本分支**无条件**先于一切路由执行，使
    Claude/Codex 内核在无 dsh 的机器上无法启动；异步化后 `host-entry.ts` `runInEntry` 的
    `entry-host-unavailable` 降级路径恢复可达。
- 约束：启动器零 lib 依赖（`/update` 只覆写这一个文件）；`noDsh` 双语文案契约；Windows
  `shell: true`；`dsh --profile` 委托路径（`DSH_TUI_HOST_ENTRY=0` 等）仍需要可用的 dsh。
- **用户可见变化**：dsh 缺失/损坏时，`--entry host` 的提示**顺序**会改变（先走 entry 的
  `entry-host-unavailable` 降级，而非预检处的 `noDsh` 安装指引；无 dsh + profile 版本错位时
  先出 `checkProfileAlignment` 诊断、后出 `noDsh`）。**缺 dsh 时的输出已两轮收口**（见 §5.6）：
  默认 entry 路由下 DSH 内核找不到 dsh 时，入口直接打印同一份 `MSG.noDsh` 并以 1 退出，不再回退
  spawn，启动器也不再追加 `profileExited` / `safeHint` / 安全模式询问——最终输出与改前的同步预检
  一致（只有安装指引两行，退出码 1）。正常启动路径无可见变化。
- 回滚：四处一起撤（helper 两个、`void probeDsh()`、`await requireDsh()`、entry 分支的缺 dsh
  早退），恢复同步 `spawnSync`；§5.6 第二轮的 `host-entry.ts` 早退可以保留（对同步预检无害）。

### 3.3 `/migrate` 懒加载（估算 −50~70ms，待 A/B；**未落地，拆独立小计划**）

- 改法（唯一确定的形态）：新增轻量叶子模块 `dsh-adapter/migrate/registry.ts`（只放
  `adapters/*.js` 的 import 与 `MIGRATION_ADAPTERS`），`index.ts` 改为
  `export { MIGRATION_ADAPTERS } from './registry.js'` 保住既有导出面，`picker.ts:11` 与
  `Chat.tsx:113` 改指向 `registry.js`。「在 `Chat.tsx` 处理 `/migrate` 时 `import()` 整个模块」
  这个候选**删除**——动态 import 整模块对首帧静态图无效。
- 必须**同时**打断 `picker.ts → index.js`：`Chat.tsx:111` 静态 import `migrate/picker.js`，
  只改 `:113` 无效。
- 边界：这是存量 allowlist 里 UI → `dsh-adapter` 的值 import，改后要求**条目数不增、依赖重量
  只减**（`screens/Chat.tsx → migrate/index.js` 不再命中须删除、新增
  `→ migrate/registry.js` 条目）；并须保住 `Chat.tsx:3392` 的
  `resolveMigrateCommand(rawInput, MIGRATION_ADAPTERS.map(a => a.id))` **同步返回**契约
  （分支一律 `return true`，改 async 会波及键盘处理器返回契约）。
- 先用改 chunk 的手法 A/B，验收口径：**`dsh-session-persistence-jsonl` 及其 koffi /
  format-catalog / format-v3-to-v4 独占链归零**。（「`zod/v4` 归零」不可达：zod 是
  `@deepseek-ai/dsh-llm` 的 dependency，而 dsh-llm 被 9 个首帧文件值 import。）
- 顺带检查 `plugin.ts` 对 `dsh-user-questions`、`dsh-tool-ask-user` 的值 import 是否能挪到
  需要时——`mountDshQuestionSeams` 是**同步函数**，裸挪需改 async；`Schema` 还在模块加载期用于
  `Config` schema。

### 3.4 小项（各约 10–15ms，**估算/待实测**；本次均不做）

- `yaml`：`hostEntryRoute.ts` → `tuiSettingsFile.ts` 在 entry 静态图里带进 67 个 yaml 模块。
  单改 `tuiSettingsFile.ts` 收益≈0——`yaml` 另有两处静态 import 也在 TUI 首帧图里：
  `bundled-presets.ts:7`（经 `plugin.ts:50`）与 `backends/shared/channel-tokens.ts:32`（经
  `plugin.ts:17` → `dsh-adapter/backends.ts:18`），必须三处同时改；代价是
  `readProfileTuiSettings → configuredBackend → host-entry.ts:62-63` 的模块顶层同步调用链要引入
  顶层 await，**推迟路由判定**。先做一次 hack 产物的模块数 A/B，确认 yaml 真的掉出首帧图再决定。
- `semver`：**记录（不拆）**——semver 由渲染器引入（`src/ink/terminal.ts:1` 值 import `coerce`，
  `ink.tsx:46` 静态引 `./terminal.js`），不是 `update.ts` 经 `logRestartEvent` 带进去的；拆
  `logRestartEvent` 收益为 0。**后续**：不拆模块，改按函数路径导入，已随 3.7 落地（46 → 13 个模块）。
- DSH 内核首帧后加载 claude-agent-sdk：查是谁触发（后端注册表的预备？），按内核按需加载。

### 3.7 更新检查让出首帧 + `semver` 按路径导入（**已落实**，A/B 见 §5.8）

- **更新检查**：`checkForTuiUpdate()` 有两个调用方，都在首帧渲染期间触发：`Chat.tsx` 落地页的
  `useEffect`（Ink 的 `renderSync` 会在首帧内同步执行掉 passive effect），以及 `plugin.ts` 挂载后的
  后台检查。进程里第一次 `fetch()` 会**同步**加载 Node 内置的 undici，CPU profile 里约 37ms
  （`__require undici`、`compileForInternalLoader`、`isIPv6`），全部落在 `render-done` 之前。
  注释说的「registry 延迟不拖慢首帧」只对网络等待成立，对这段同步初始化不成立。改法：
  `checkForTuiUpdate()` 开头先 `await setImmediate`，两个调用方都不用改。代价是这段开销挪到
  首帧之后，`startup-adopted` 不变（是挪走，不是消掉）。
- **`semver`**：`src/update.ts`（`gt`/`gte`/`lt`/`valid`）和 `src/ink/terminal.ts`（`coerce`）改为
  `semver/functions/*.js`，加载的模块数从 46 降到 13。`scripts/verify-source-hygiene.mjs` 加一条
  `semver barrel import` 规则，写法照 3.1 的 `lodash-es`，豁免 `docs/`、`scripts/`（维护脚本
  不随包分发，`verify-alpha-source.mjs` 仍用包根导入）。dsh 自己那份 semver（dsh-app-boot 在宿主
  准备段加载）是上游的，不受影响。
- 回滚：两处 import 改回包根导入，删掉 `setImmediate` 那一行和门禁规则。

### 3.5 长期：首帧不依赖宿主（约 −135ms 再减 30ms，结构性改动；**不在本次范围，拆独立计划**）

两条路：

- **本包内**：让首帧依赖的模块图不含 `@deepseek-ai/*` 值 import——先挂屏、画首帧，再
  `prepareHostRoot`，再加载其余模块并接上。真实清单（实测）：`Chat.tsx` 闭包 703 文件里的非
  cordis vendor 值 import 共 **10 包 / 25+ 文件**（`dsh-agent`、`dsh-agent-instructions`、
  `dsh-atomic-write`、`dsh-llm` 9 文件、`dsh-scope`、`dsh-session` 14 文件、
  `dsh-session-persistence-jsonl`、`dsh-skill` 3、`dsh-system-prompt`、`dsh-user-questions` 2）。
  「channel core 当前值 import dsh-llm、dsh-session」这一前提**错误**：`src/dsh-adapter/channel/core/`
  实测**零** `@deepseek-ai/*` import，且 `verify-adapter-boundary.ts:379-385` 强制如此；真实值
  import 落在 `channel/*.ts`（根目录，DSH 扩展侧，40 个文件）。另 `host-entry.ts` 自身闭包
  （48 文件）带 `schemastery`，且 `plugin.js` 与其后的 TUI 图虽是**动态** import，却发生在
  `render-done` 之前（`host-entry.ts:179-188`）——首帧图真实大小 = 两者之和。契约面触及
  UI→adapter 值 import 接缝（allowlist 40 条）、`root.ctx` 的确定时机、`host-entry.ts` 挂载顺序。
  须保持「同一棵已挂载的树、零可见切换」（预载方案的教训）。
- **上游**：dsh-app-boot 缓存 `collectInstallationScopePackages` 的包表（以安装目录 / lockfile
  的 mtime 为键）。属 DSH 核心改动，本包零核心改动的红线下只能作为上游建议提出。

### 3.6 小项：`startDshSession` 补 `withCompileCache`（**记录，不做**）

spec ⑥-4 的裁决。与本次首帧目标无关（不在首帧路径上）：受影响的是救援、安全模式重试、safe 菜单与
非默认开关路径。**与既有语义冲突**——救援的环境是显式构造的「干净冷启动」（`rescueEnv()`），给救援
注入编译缓存与该设计意图相悖。另有一处前提更正：默认路径（`--entry host`）下 `/restart`、`/kernel`
的替身进程由 `update.ts` 的 `restartArgv` 重建为 **host-entry 进程**、env 从 entry 继承（entry 由
`startEntrySession` 的 `withCompileCache` 注入）→ 已有缓存；只有 TUI 跑在 `dsh --profile` 内
（`DSH_TUI_HOST_ENTRY=0`）时替身才是 dsh，那条路径才真的无缓存。**去向**：若后续仍要做，应作为
「启动器编译缓存覆盖一致性」独立项逐路径判定（safe / 救援 / 非默认开关各自是否该有缓存），而不是
一行无差别加。

## 4. 验证口径

### 4.1 测量协议（唯一、可复现）

```sh
DSH_TUI_THEME=dark \
NODE_COMPILE_CACHE="$HOME/.dsh-tui/compile-cache" \
DSH_TUI_LANG=en \
node scripts/probe-startup-baseline.mjs --entry host --backend dsh --runs 4
```

- `--entry host` 是这几项改动的作用域，也是唯一会打 `entry-first-frame-flushed` 的模式；
  `--entry profile` 走 `dsh --profile`，没有该打点，也不注入编译缓存。
- `DSH_TUI_THEME=dark` + 外部固定 `NODE_COMPILE_CACHE` 把 §1.1 的两处伪影从被测路径摘掉；
  冷口径另起一次不设 `NODE_COMPILE_CACHE` 的运行并标 `cold`。
- 轮次：`A1 B1 A2 B2` 四段、每段 4 轮（每臂 8 轮）；每次切换源码态都重跑 `pnpm compile` 并记录
  `lib/types` 的段级哈希（基线态用临时编辑取得，测完还原并复核哈希）。判据用两臂合并中位数 +
  配对差 + 四分位距。
- 作废规则：某轮开始时 `loadavg(1m) > 0.5 × nproc` 即作废重测；同时记录每轮的 loadavg 与并行
  dsh 进程数（机器上常驻的其它 dsh 会话会把绝对值整体抬高）。
- 每轮落 JSONL：`wall_render_done_ms`、`wall_first_frame_flushed_ms`、`wall_entry_start_ms`、
  `wall_entry_modules_ms`、`at_prompt_ms`、首帧前模块总数与各包模块数、`lib_sha256`、`loadavg_1m`。
  跨进程对齐一律用 trace 的 `at`（wall clock，`bootTrace.ts`）与探针的 `startedAt`，**不要**用
  trace 的 `ms`（那是各进程自己的 `performance.now()`）。
- 已按本协议跑出的一轮结果、复核对其测量局限的判定，以及要升级为「可信交付」还缺的证据，见 §5。

### 4.2 回归门禁

- 在 `pnpm verify:build` 聚合清单内（自动）：`verify:source-hygiene`（§3.1 的新规则）、
  `verify:spinner-identity`、`verify:boundary`、`verify:initial-prompt`；`verify:lib-bundle` 随在途
  bundle 改动（`scripts/bundle-lib.mjs`、`scripts/verify-lib-bundle.mjs`）一起入库后才在清单内，
  截至 `0193f542` 的 `package.json` / `run-verify-build.mjs` 里还没有。
- **CI required 但不在 `verify:build` 内**，改 `bin/dsh-tui.js` 必须单跑（见
  [contributing.md](contributing.md)）：`verify-launcher`、`verify-safe-mode`、`verify-update`、
  `verify-update-recovery`、`verify-cli-subcommands`、`verify-startup-argv`，以及
  `run-ci-group input-terminal`。
- **手动、非门禁**（不得当门禁声称）：`scripts/verify-installed-startup.mjs`（依赖真实安装的
  dsh/dsh-tui + node-pty）、`scripts/accept-host-entry.mjs`（`@microsoft/tui-test`，PTY 交互）、
  `node --import tsx/esm scripts/verify-i18n.ts`。
- 可见首帧：屏幕侧用 `scripts/accept-host-entry.mjs` 断言首帧占位与 prompt 照常画出；终端可见
  改动另在 inline / fullscreen、窄终端下手动演练。

## 5. 落实后的实测与复核（2026-10-10）

> 本节是「§3.1 / §3.2 已落地并复测」的**唯一实测口径**。§1–§3 里的 700 / 586 / 665 是**落实前**在
> bundle 产物上做的预算实验（§3.1 已就地标注），与本节不可相减。
>
> **量级口径的最终修订见 §5.7**：§5.1 的 `−167ms` 是本批次的**块级点估计**，不是「扣掉漂移后的
> 效应」；可信说法以逐轮交替对照为准（3.1 ≈ 126ms、3.2 ≈ 46ms，合计约 170ms）。
>
> **证据位置**：本节引用的测量报告（`implement/report.md`、measure2/3、verify2 的 I-ruling 等）
> 都是本地一次性产物，**不在仓库里**；复核时只能以本文转述为准。

### 5.1 实测（`implement/report.md` 2.3，`A1 B1 A2 B2` 各 4 轮，每臂 8 轮；**块级口径，量级已由 §5.7 修订**）

| 指标 | A 臂（改前等价源码态） | B 臂（改后） | 合并差 | pair_1 | pair_2 |
| --- | --- | --- | --- | --- | --- |
| `render-done` | **819.5** | **652.5** | **−167** | −131.5 | −208.5 |
| `entry-first-frame-flushed` | 886.5 | 724 | −162.5 | −126.5 | −205.5 |
| `entry-start` | 146.5 | 84 | −62.5 | −56 | −68 |
| `entry-modules` | 719 | 548 | −171 | −137.5 | −206.5 |
| `at_prompt` | 825.5 | 658.5 | −167 | −133 | −207 |

首帧前模块总数 **1238 → 641**；`lodash-es` **640 → 43（−93.3%）**。

**口径差（务必区分）**：§1.1 / §2.1 的 warm `render-done ≈ 700` 是**诊断期**探针读数；本节 A 臂的
**819.5** 是另一套 harness（本节用 §4.1 的 `A1 B1 A2 B2` 协议、外部固定 `NODE_COMPILE_CACHE` +
`DSH_TUI_THEME=dark`，测量窗口里还有常驻 dsh 会话抬高绝对值）。两者不是同一次测量，跨口径只能比
**配对差**，不能把 700 与 819.5 相减、也不能把 586 与 652.5 相减。

### 5.2 判据状态：Partially PASS

| 判据（spec ③-3） | 实测 | 结论 |
| --- | --- | --- |
| 3.1-a `lodash-es` 640 → **≤3** | **43** | **未达（判据预期错误）** |
| 3.1-b `entry-modules` 下降 ≥90ms | −171（pair −137.5 / −206.5） | 达成 |
| 3.2-a `render-done` 下降 ≥50ms | −167（pair −131.5 / −208.5） | 达成 |
| 3.2-b `entry-start` 与 `entry-modules − entry-start` 漂移 ±15ms 内 | −62.5 / −106.5 | **判据设计错误** |
| 共同-a `entry-first-frame-flushed` 不劣化 | −162.5 | 达成 |
| 共同-b `at_prompt` 不劣化 | −167 | 达成 |

- **3.1-a「≤3」物理不可达**：按路径导入后仍有 43 个 `lodash-es` 模块，而唯一来源
  `lodash-es/sample.js` 的子图**独立实测就是 35 个**（复核 `verify-d/lodash-subgraph.mjs`）。落实
  报告曾记为「37 + 既有 6 = 43」，复核更正为 **35 + 8 = 43**（多出的 8 个是
  `noop`/`throttle`/`debounce`/`now`/`toNumber`/`_baseTrim`/`_trimmedEndIndex`/`isSymbol`），且原
  「6」里的 `_root.js`/`_freeGlobal.js` 已含在 sample 子图内（重复计数）。正确口径是 **640 → 43**。
  **总判定 Partially PASS**：时间收益全部达成，模块数判据是 spec 的预期错误而非改动失败。
- **3.2-b 的两条 ±15ms 判据是设计错误**：复核用恒等式证明 `entry-start ≡ dsh_process + entry 进程内
  耗时`，并实测 `med(dsh_process)` A=95.5 → B=33（−62.5），而 `med(entry-start − dsh_process)`
  A=B=**50.5**（差 0）。即 `entry-start` 的下降 100% 来自 3.2 要动的启动器段，entry 进程内部耗时逐位
  不变。该判据把「3.2 的收益本身」误设成「不应变化的量」，两项同改时必然失败；替代判据见 §5.4-6。

### 5.3 测量局限（复核 D 的诚实性记录）

**`−167ms` 这一「点估计」不可信，方向性收益可信。** 逐条：

- **两臂段漂移反号**：`render-done` 的 A2−A1 = **+49**、B2−B1 = **−28**。反号漂移下合并中位数不是
  稳健估计；**pair_2（−208.5）叠了「B 臂第二段系统更快」的偏置**，诚实区间是
  **pair_1 −131.5ms（保守下界）～ pair_2 −208.5ms**。
- **作废规则未真正实现**：`measure.mjs` 只记录不判定，「16 轮零作废」不是判据执行的结果；`loadavg`
  阈值 `0.5 × 16 = 8` 从未接近，**无鉴别力**（复核在 loadavg 0.58 下仍测到 +222ms）。
- **探针进程泄漏**：`measure.mjs` 的进程排除规则没有滤掉 `/tmp/dsh-tui-baseline-*`，探针自身的残留
  进程被计成「外部并行 dsh」；`/tmp` 下留了 18 个 root 目录（最大 52MB）。这是可修复的方法缺陷。
- **A/B 分离未被独立重现**：复核用**同一 B 臂产物**独立跑 8 轮，`render-done` 跨 **667–1085**
  （中位数 875/876），落进报告的 A 臂区间 `[777, 862]`。测量系统的环境敏感性（418ms）**大于**声称
  的效应量（167ms）。
- **未受控变量 `DSH_TUI_THEME=dark`**：同一 B 臂下它使 `render-done` 慢 **127–208ms**（与效应量同
  量级）——它是**改变被测路径**，不只是「摘掉主题往返」。真实用户默认口径（无 `theme.json`、无该变量）
  的完整读数仍然缺失。
- **唯一硬证据**：pair_1 中 B1 的 `loadavg`（0.98–1.06）**高于** A1（0.72–0.84）却快 131.5ms——
  收益**逆负载方向**成立，不能被负载解释。
- 另注：A 臂受工作区**在途 bundle 重构**影响，**不是历史口径基线**，`entry-modules 719` 与 §2.2 的
  「1050 个模块」不可直接对比。

> **量级修订（2026-10-10，同日更正）**：本节的 `−167ms` 是块级点估计，最终口径见 §5.7。此前这里写
> 「块级高估约 2.2–2.5×」并据此否定 `−167`，**套错了对象**：2.2–2.5× 只是 **3.2 单项**的块级高估
> （块级 100.5 vs 逐轮 46）；3.1 单项块级只高估约 15%（144.5 vs 126）。两项逐轮值相加
> 126 + 46 ≈ 172ms，与 `−167` 基本吻合——合并效应的量级并未被推翻，本节其余局限（反号漂移、
> 无鉴别力的作废规则、`DSH_TUI_THEME` 未受控）仍然成立，引用时用 §5.7 的逐轮口径。

### 5.4 要补齐的证据（2026-10-10 更新）

> §5.1–§5.3 的「待补清单」中已有两项在本批次后续完成：**单变量臂**（measure2 的 A31/A32 + 本轮
> 逐轮对照）与**屏幕侧读数**（measure2 `screen-probe.mjs`）。下列是**仍然缺**的。

1. **真实终端 OSC 11 应答口径**：measure2 的屏幕读数与打点都在「探针不应答 OSC 11」的条件下取得，
   真实用户的终端**会**应答（探测几毫秒返回），可见首帧的真实绝对值仍未取得；`no-theme` 组还叠了
   「无主题覆盖 + 终端不应答」的复合伪影。
2. **跨机器 / 跨环境的独立复现**：§5.7 的全部数据与 I/H 一致，来自同一台机、同一时段；块级漂移与
   绝对水平都随机器/时段改变，跨机器复现是唯一能把结论推出「本机窗口」的路径。
3. **漂移的物理来源**：I 观察到同产物块间漂移 +115ms，且与 `loadavg` 反向相关；本轮 3.2 后段
   （loadavg 降到 0.6 时）读数反而升高、持续时间变长，同向印证。需要一次「固定产物、只变时间」的
   长时间序列才能把漂移建模（周期项 / FS 缓存项），而不是当噪声。
4. **屏幕侧可见帧的逐轮交替读数**：measure2 的屏幕段是块级 5×2，仍需与 §5.7 同等口径的逐轮交替，
   才能给出屏幕侧的可信区间。
5. **判据改可检验形式**（推荐，未强制）：3.1-a 从「≤3」改「≤45 且 `sample.js` 子图是唯一新增来源」；
   3.2-b 的两条 ±15ms 改「`dsh_process` 下降 ≥50ms **且** `entry-start − dsh_process` 漂移 ≤±10ms」。
6. **`docs/standalone-host-design.md` 6.1 的过时数字重标**（P1 待办，见 §5.5）。

### 5.5 未做项与待办

- **`startDshSession` 补 `withCompileCache`：记录，不做**（见 §3.6）。
- **P1 待办：`docs/standalone-host-design.md` 6.1 未修订**。spec ⑤.5 的禁改 `docs/*` 与 ⑦ 的复核
  建议冲突，按禁令处置、未触碰该文件；判为**可接受的已知不一致**，但必须作为下一批次高优先级待办。
  该文件 `:468-469` 的 `render-done −80ms / −143ms` 大概率出自缓存被擦的探针，需重标为「缓存被擦
  条件下的测量」；`:471`「两个非默认开关不受益」需扩为「`startDshSession` 路径全部无缓存」
  （`--entry profile`、默认路径的 `/restart` 与 `/kernel` 替身、安全模式重试、救援、safe 菜单）。
- 其余 `docs/*`（`contributing*`、`README*`、`README_ZH*`、`architecture*`）复核后**无需改动**；
  本文件属内部诊断文档，**不触发** `AGENTS.md` 的双语文档同步规则。

### 5.6 收口：entry 降级路径补回安装指引（F1）

复核 E 实测：默认 entry 路由（`DSH_TUI_HOST_ENTRY_DSH` 未设）在 PATH 无 dsh 时，`未检测到 dsh CLI`
安装指引**不再出现**，只剩 `the installed dsh cannot host this launch (no dsh on PATH)` +
`cannot start dsh (spawn dsh ENOENT)`。根因是预检异步化后唯一消费点在启动器 `else` 分支，而 entry
路由不经那里；`host-entry.ts` 的 `delegateToDsh()` 的 spawn 失败分支没有安装指引。

**已修（2026-10-10）**：`src/dsh-adapter/host-entry.ts` 的 `delegateToDsh()` 在 spawn `ENOENT` 时
打印与 `bin/dsh-tui.js` `MSG.noDsh` 逐字相同的双语指引（同一语言规则：`DSH_TUI_LANG=en`，否则中文）。
`DSH_TUI_HOST_ENTRY_DSH=0` 出口文案逐字不变。防回归：`scripts/verify-launcher.mjs` 第 5.1 节新增两条
默认路由断言（中/英各一）；该脚本默认 env 曾把 `DSH_TUI_HOST_ENTRY_DSH` 钉在 `'0'`，此前这条出口
**无门禁覆盖**。

**第二轮（2026-10-10，验收发现）**：第一轮只补回了指引，没有收住多余输出。实测同一场景的 stderr 是
`cannot host this launch (no dsh on PATH); starting DSH through dsh --profile` →
`cannot start dsh (spawn dsh ENOENT)` → 安装指引 → 启动器的 `profileExited`（建议运行一个不存在的
`dsh --profile dsh-tui`）→ `safeHint`；TTY 下按代码还会弹安全模式询问。另有一个平台缺口：Windows 上
`delegateToDsh()` 用 `shell: true`，缺 dsh 时 cmd.exe 只是非零退出、没有 `ENOENT`，第一轮的指引
永远打不出来。

修法（两处，跨平台）：

- `host-entry.ts` `runInEntry`：DSH 内核下宿主查找的原因是 `NO_DSH_ON_PATH`（`host-dsh.ts`
  `findHostDsh` 导出的常量）时，直接打印 `NO_DSH` 并 `exit(1)`，不再回退 spawn。`NO_DSH` 的声明
  移到顶层 `await runInEntry(...)` 之前——这条分支在模块求值挂起期间执行，原位置会撞 TDZ。
  PATH 上有 dsh 但宿主形状不对（找得到、用不了）时仍照旧回退 `dsh --profile`。
- `bin/dsh-tui.js` entry 分支：结果是非零 `exit`、`launchKernel() === 'dsh'` 且异步探测为 false
  时直接以该退出码退出，跳过 `profileExited` / `safeHint` / `askSafeEntry`。Claude/Codex 内核不套
  这个条件。已知边界：profile 的 Config 行把内核改钉为非 DSH 时，`launchKernel()` 判断不到，可能
  误吞一次 `profileExited`，可接受。

防回归：`verify-launcher.mjs` 第 5.1 节再加两条——缺 dsh 时不出现 `cannot start dsh` /
`cannot host this launch`（没有回退 spawn），也不出现 `dsh profile exited` / `dsh-tui safe`。
用 HEAD 版启动器配新 lib 跑，后一条确实转红。

### 5.7 独立裁定 I 与本轮干净对照（measure3，2026-10-10）

> §5.1–§5.4 是落实批次自己的块级测量与复核 D 的局限判定。此后独立裁定 I 又复核了 measure2（H），
> 收口执行人 J 构造两套预构建 lib 做了逐轮交替对照。本节是**量级口径的最终修订**：§5.1 的 `−167ms`
> 是块级点估计，**不构成「扣掉漂移后的效应」**；可信说法是逐轮交替对照的单项值（3.1 ≈ 126ms、
> 3.2 ≈ 46ms），两项合计约 170ms。

#### 5.7.1 独立裁定 I：推翻 H 的量级（不是方向）

H（measure2 的报告）在四臂块级设计上给出 `A−B render-done = −306.5ms`
（95% CI [262,361]，两臂「完全不重叠」，置换检验 `p = 7.4e-7`），并给出「跨 harness 保守下界 ≥167ms」。
独立裁定 I（verify2 的 I-ruling）逐条复核后**推翻其量级**：

- **置换检验 p 值算错 250×**：H 用 `2/C(24,12) = 7.4e-7`；该式**只在统计量取两个值时**成立。
  I 对 **中位数差**统计量精确枚举 `C(24,12) = 2,704,156` 全部组合，`ge = 504`，真实 **p = 1.86e-4**。
- **块级设计使量级高估约 2.5×**：H 的块级配对在第二个 cycle 里 gap 达 158–214s（跨了 A31/A32 两个
  整块），配对差里混进块级时间漂移（I 复现同一产物块间漂移 **+115ms**）。I 的逐轮 ABBA 交替
  （只切 `bin/`，不重编译）给出 **3.2 单项 = 44–55ms**，不是 138.5ms。
- **D 的「不可重现」有其窗口污染**：D 的 `load-sample.txt` 显示其窗口内 **55–60 个并发 node 进程**，
  而 H 的窗口只有 7 个；D 用「B 臂绝对值落进 A 臂区间」论证分离失效，是**跨批次比绝对值**，且未
  报告自己的负载事实。
- **屏幕侧口径**：见 §1 的修订——`entry-first-frame-flushed` 与可见首帧**不矛盾**，H 的「与 §1 相反」
  是过度解读。

H 的**算术、卫生、还原、臂定义、模块快照**经 I 复核全部成立（`lodash-es` 640→43、`lib/` 无 barrel
残留、段级哈希一致等）；被推翻的**只是统计口径与量级解释**。H 的 48 轮四臂数据此后仍可作
**「同批次块级设计下的上界」**引用，但必须标注口径：**块级、配对差含块级漂移**，不能当扣掉漂移的效应。

#### 5.7.2 本轮 3.1 干净逐轮对照（关键补测）

要干净分离 **3.1**，需要**两套预构建 lib 并存**：A 态 = barrel `import { sample } from 'lodash-es'`；
B 态 = `import sample from 'lodash-es/sample.js'`。本轮各自 `pnpm compile` 出整套 `lib/` 保存
（只差 `chunks/Chat-*.js` 及其 facade 引用），测量时**逐轮 `cp` 切换 lib、不重编译**；两态的
`bin/dsh-tui.js` 都用最终态，以排除 3.2。顺序为随机化平衡块（每块 2 A + 2 B），n = 16/臂；配对在
块内按出现次序（`A_i` ↔ `B_i`，gap 1–2 轮）。

| 指标 | A 中位 | B 中位 | 配对中位差 | bootstrap 95% CI | 同号 |
| --- | --- | --- | --- | --- | --- |
| `render-done` | 872.5 | 775 | **126** | **[92, 144]** | **16/16** |
| `entry-first-frame-flushed` | 954.5 | 862.5 | 130 | [93.5, 146] | 16/16 |
| `prompt` | 877 | 782 | 128 | [94, 146] | 16/16 |
| `entry-modules` | 751 | 657.5 | 114.5 | [93, 143] | 16/16 |
| `entry-start` | 94 | 101 | −4.5 | [−8, −1] | 2+/13−（≈0） |
| `dsh-process` | 38 | 39.5 | −1.5 | [−5, 1] | 4+/9−（≈0） |

- **`entry-start` / `dsh-process` 配对差≈0** 证明 3.1 只动 entry 段内的模块加载，**不污染启动器段**
  ——这是 §5.2 恒等式的独立实验确认。
- 精确配对置换检验（枚举 `2^16 = 65,536` 个符号模式，统计量 = 配对差均值）：`render-done p = 3.05e-5`；
  精确符号检验同值。
- **块级对照**：同样的两套 lib 换成连续块 `B5 A5 B5 A5`，pooled 中位差 **144.5ms**，相邻块差
  `+122 / −128 / +172`（第三次被块内漂移抬高）。即本窗口下块级口径高估约 15%（144.5 vs 126）；
  漂移更大的窗口里会更高。
- **H 的教训（统计量定义）**：对同一份块级数据，H 的写法 `2/C(20,10) = 1.08e-5` 与**精确枚举**
  `C(20,10) = 184,756`（统计量 = 中位数差）得到的 `p = 7.58e-4` **差 70×**。`2/C(2n,n)` 只在统计量
  取两个值时成立；「值域完全不重叠」不是 p 值依据。

#### 5.7.3 本轮 3.2 逐轮口径复测

用 I 的方法（A31 = `bin/` 还原为 `git show HEAD:` 的同步预检态；B = 最终异步预检态；两态 `lib/`
逐字节相同）逐轮交替，n = 16/臂：

| 指标 | A31 中位 | B 中位 | 配对中位差 | bootstrap 95% CI | 同号 |
| --- | --- | --- | --- | --- | --- |
| `render-done` | 869 | 807.5 | **46** | **[27, 136]** | 13/16 |
| `entry-first-frame-flushed` | 958 | 902.5 | 49 | [18, 132] | 13/16 |
| `entry-start` | 174.5 | 108 | 74 | [64, 81] | 16/16 |
| `dsh-process` | 117 | 41.5 | 79 | [70, 82] | 16/16 |
| `entry-modules` | 742.5 | 675 | 60.5 | [34, 122] | 16/16 |

- 精确配对置换检验：`render-done p = 5.19e-4`；`entry-start p = 3.05e-5`。
- **独立确认 I 的量级**：3.2 单项在 `render-done` 上约 **46ms（CI [27,136]）**，与 I 的 **44–55ms**
  吻合；最干净的 `dsh-process`（79ms，16/16）说明启动器段的收益是 ~79ms，传到 `render-done` 后衰减
  为 ~46ms。
- **块级对照**：连续块 `A5 B5 A5 B5`，pooled 中位差 **100.5ms**，相邻块差 `−149 / +98 / −21`
  ——同一测量里块级高估约 **2.2×**。这直接解释了 H 的 138.5ms 从何而来。
- 诚实标注：本轮 3.2 的 `render-done` 配对差有 3 对为负（后段漂移最大的几轮），故 CI 上界较宽；
  点估计取中位数 46ms，区间 [27,136]。

#### 5.7.4 结论口径与可信区间

| 项 | 口径 | 可信说法 |
| --- | --- | --- |
| **方向** | 3.1 与 3.2 均同向为正 | **可信**（3.1：16/16 同号；3.2：`entry-start` 16/16、`render-done` 13/16） |
| **3.1 量级**（`render-done`） | 逐轮配对中位差 | **≈126ms [92,144]**（块级口径 144.5ms） |
| **3.2 量级**（`render-done`） | 逐轮配对中位差 | **≈46ms [27,136]**（启动器段 ~79ms；块级口径 100.5ms） |
| **H 的 −306.5 / −138.5 / p=7.4e-7** | 块级口径 | **已被独立裁定推翻**（见 §5.7.1） |
| **「跨 harness 下界 ≥167ms」** | 跨 harness | **不成立**（I 的逐轮对照给出 3.2 单项 44–55ms） |
| **H 的 48 轮四臂数据** | 同批次块级设计 | 可作**上界**引用，须标「块级口径、含漂移」 |

**方法学要点（为什么逐轮交替比块级可信）**：启动绝对时间存在**分钟级块尺度漂移**（I 测到同产物
块间 +115ms，足以抹平效应量）。块级设计把「臂」与「时间块」**混淆**，配对差里混入块漂移；逐轮交替让
每个 A 与相邻（gap 1–2 轮 ≈ 5–10s）的 B 配对，把漂移压到块内，残余效应才可读。统计量须显式声明：
本轮用**配对差中位数**，并以**精确置换**定 p（配对：符号翻转 `2^n`；不配对：标签排列 `C(2n,n)`；
块级数据里 `C(2n,n)` 可枚举时才用枚举，不可枚举用大样本随机置换，**绝不用 `2/C(2n,n)`**）。

**未超出证据的边界**：以上区间都取自**同一台机、同一时段**；3.2 的 `render-done` 区间上界受后段
漂移影响较宽；屏幕侧可见帧、真实终端 OSC 11 口径与跨机器复现仍缺（见 §5.4）。

### 5.8 分段剖析与 3.7 的 A/B（measure4，2026-10-10）

**环境**：这台机器同时在跑游戏开发任务（Windows 侧的 `urhoxruntime` 等），WSL 内看不到这部分负载，
所以每轮都另用 `typeperf` 采 Windows 总 CPU（1s 粒度），同时采 WSL 内 `/proc` 的 busy/steal 和
其他进程的占用。口径同 §4.1：`--entry host --backend dsh`、热编译缓存、`DSH_TUI_THEME=dark`；
每轮开始前空闲 3s，作为背景负载的读数。脚本是一次性的，未入库
（measure / preload / analyze / ab-stats 四个）。

#### 5.8.1 基线分段（当时工作区的 lib，即随后以 `82af3c44` 提交的打包态；10 轮，不剖析）

| 段 | 均值 | 中位 | 标准差 |
| --- | --- | --- | --- |
| spawn → entry 进程 | 42 | 42 | 4 |
| → `entry-start` | 63 | 63 | 6 |
| → `entry-hijacked` | 164 | 164 | 13 |
| → `entry-modules` | 330 | 329 | 40 |
| → `render-start` | 30 | 29 | 3 |
| → `render-done` | 101 | 100 | 5 |
| **`render-done` 累计** | **729** | 733 | 63 |
| → `entry-first-frame-flushed` | 86 | 90 | 6 |
| compose-start → compose-end（首帧后） | 925 | 929 | 94 |
| → `startup-adopted`（累计 2207） | 466 | 479 | 39 |

Windows 总 CPU：首帧期间平均 36%，启动前 39%；WSL 内其他进程 4–12%（单核）。`render-done` 与
首帧期间 Windows CPU 的相关系数是 0.61（n=10，1s 采样粒度粗，只作参考）。

#### 5.8.2 CPU profile 归因（`node:inspector` 每 250µs 采样，6 轮 Windows CPU < 45% 的平均）

剖析会把整体拉慢约 1.2 倍，下面只看占比和排序。各段主线程 idle≈0，都是纯 CPU 时间。

- **宿主 dsh 准备**（剖析 187ms）：`prepareHostRoot` 100（`createRuntimeResolution` 76，其中
  `collectInstallationScopePackages` 55；`PluginPackages` 33；`installRuntimeInterception` 32），
  cordis `_reload` 41，`loadHostDsh` 18。大约一半是文件系统调用：`lstat` 24、`realpath` 14、
  `existsSync` 9、`readPackageManifest` 16。
- **TUI 模块加载**（剖析 384ms）：node 模块加载器自身 135（`compileSourceTextModule` 45.5），
  node 内置 52；经解析劫持（`wrapped`/`adapted`）的解析共 146，其中路由逻辑（`routeUrl`）34；
  `contract.ts` 的版本校验 9；`string-width` 顶层执行 11.6。加载 455 个模块、10.6MB：`zod` 95
  （经 `@deepseek-ai/dsh-user-questions`，`plugin.ts` 的 `mountDshQuestionSeams` 同步挂载它，
  要挪出首帧得改 DSH 的挂载时序，没做）、本包 chunks 85、`semver` 46（profile 里那份，3.7 处理）、
  `lodash-es` 43、`diff` 19。
- **apply**（剖析 36ms）：`plugin.ts` 的 `apply` 30，其中 `createChannel` 12。
- **渲染首帧**（剖析 123ms）：React 93；**`checkForTuiUpdate` → `fetchLatestVersion` 37**
  （→ 3.7）。

#### 5.8.3 3.7 的 A/B

两套预构建 lib：A 是 HEAD `08342019` 重新编译的，B 是 3.7 改完的。两臂共用同一个隔离 profile，
每轮只切 `lib/`、不重编译，各用一份热编译缓存。按 ABBA 逐轮交替跑 16 对，每臂先各预热 2 轮。
差值 = A − B，正数表示 B 更快。

| 指标 | A 中位 | B 中位 | 配对中位差 | bootstrap 95% CI | B 更快 | 精确置换 p |
| --- | --- | --- | --- | --- | --- | --- |
| **render-start → render-done** | 100.5 | 70.5 | **26** | **[22.5, 37]** | **16/16** | — |
| entry-hijacked → entry-modules | 332 | 312 | 8 | [−14, 24.5] | 9/16 | — |
| `render-done` | 713 | 678 | 31.5 | [−4, 58] | 11/16 | 0.14 |
| `render-done`（剔除首帧期间 Windows CPU > 60% 的 1 对） | 717 | 675 | 37 | [−4, 71] | 11/15 | 0.016 |
| `prompt` | 716.5 | 679.5 | 33.5 | [−3, 58.5] | 11/16 | 0.13 |
| render-done → `entry-first-frame-flushed` | 87 | 81.5 | −0.5 | [−8, 9] | 7/16 | — |
| `startup-adopted` | 2158 | 2156.5 | 24.5 | [−101, 85] | 9/16 | 0.73 |

- **更新检查让出首帧**：效果确定，渲染段 −26ms，16/16 同号，置信区间远离 0。挪走的开销没有冒到
  首帧写出之后（render-done → fff 差 ≈0）。
- **`semver`**：模块数确定少了 33 个，但耗时（+8ms）在本机噪声里分不出来，只能算方向正确。
- **`render-done` 总计**：中位快 32–37ms，与渲染段的收益一致；前几段配对差的噪声有 ±30ms，
  16 对下全量还不显著（p=0.14）。
- **CPU 负载两臂相当**：首帧期间 Windows 总 CPU，A 臂平均 39.5%、B 臂 36.2%；WSL 内其他进程
  两臂都约 5%。只有一对的 B 轮撞上 60% 负载（823ms），也就是被剔除的那一对。
- **测试修复**：`verify-update.mjs` 自 `82af3c44`（lib 打包）起就坏了。它手工列了要镜像的文件，
  但没包括 `chunks/`；另外 3 个按 `export async function …` 定位的源码文本断言，在打包后的产物里
  找不到锚点。现改为镜像整棵 `lib/types` 的 `.js`，锚点改用不带 `export` 的函数声明。
  `verify-update-checksum.tsx` 的两条「无界流超上限中断」断言在 HEAD 上也失败，而且时有时无
  （和时序相关），不在本次范围内。
