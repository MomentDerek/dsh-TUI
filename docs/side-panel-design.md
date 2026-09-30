# dsh-TUI 侧栏（Side Panel）分栏布局与 Panel 系统：技术设计

- 日期：2026-09-30
- 状态：Draft（基于 v0.12.0 代码实测修订；上一版 RFC 见文末「与上一版 RFC 的差异」）
- 范围：Chat 主屏的左右分栏、右侧 Panel 宿主与注册表、现有辅助组件迁移、插件 Panel 接缝
- 核心原则：**主聊天链路不重写，侧栏只重新组织持续存在的辅助状态。**

---

## 0. 一句话定义

完整保留现有 `Chat.tsx` 及其消息、Thinking、工具卡、Markdown、图片、输入框
与状态行，把 Goal/Todo、后台 Jobs、子代理、伙伴形象等「跨回合持续存在的辅助
状态」从主界面外围抽离到右侧一个统一、可扩展、可供插件注册的 **侧栏 Panel
Surface**。用户看到的是新布局；代码层面绝大多数对话逻辑仍是原来那套。

本文把上一版 RFC 的目标落到本仓库的真实结构上。最重要的三个修正：

1. **命名**：RFC 里的 "Workspace" 在本仓库已被占用——`/workspace`、
   `ctx.tuiWorkspaces`、`WorkspacePicker`、`/home` 工作区首页都指「工作目录 /
   URI provider」（`src/workspaces.ts`、`src/dsh-adapter/workspaces.ts:210`）。
   新概念统一叫 **侧栏（Side Panel）**：服务 `ctx.tuiPanels`，设置前缀
   `dsh-tui.sidePanel.*`，命令 `/panel`，快捷键动作 `sidePanel`。
2. **只在 fullscreen 生效**：inline 模式的帧高等于内容自然高度，超出终端的
   行被推进原生 scrollback 后冻结（`src/ink/renderer.ts:125`、
   `src/ink/log-update.ts:285-345`），一个「钉在视口里的右栏」在 inline 下无法
   存在；inline 也没有鼠标命中与终端图片。inline 下侧栏降级为现有的
   「整屏早返回」形态（见 §6.3）。
3. **不需要新造 SurfaceBounds Context**：`PageMargin`
   （`src/components/PageMargin.tsx`）已经用「嵌套 `TerminalSizeContext` 覆盖 +
   `PageInsetContext` 坐标补偿」实现了同一机制，且全仓库没有任何组件直读
   `stdout.columns`——所有宽度数学都走 `useTerminalSize()`。分栏层照它再嵌套
   一层即可，RFC 担心的「大量组件错误依赖终端宽度」问题在本仓库基本不存在。

---

## 1. 现状盘点（Phase 0 结论）

### 1.1 根树与 Chat 主 return

```text
plugin.ts:1559-1561
  fullscreen:  <AlternateScreen> <PageMargin> <Chat/> </PageMargin> </AlternateScreen>
  inline:      <PageMargin> <Chat/> </PageMargin>

Chat.tsx 早返回链（4250-4474，每个都 fullscreen ? node : <AlternateScreen>）
  中断面板 / plugin scene / SessionSupervisor / SessionTree / Settings
  / SubagentDetailScene / JobsPanel / SubagentDashboard / TrajectoryScene

Chat.tsx 主 return（4531-5275）
  <Box column flexGrow width="100%">                 ← 根
    PinnedTurnHeader                                 ← 上滚时出现
    <Box row flexGrow marginRight={-pageInsetX}>     ← 转录行（出血到终端右边）
      <ScrollBox stickyScroll>
        LogoHeader（鲸鱼 / 女仆 splash，随转录滚走）
        LoadedContextPanel（rows.length===0 时）
        MessageList（内嵌 SubagentMessage / JobCard / JobGroupHeader）
      </ScrollBox>
      TimelineRail | ScrollbarGutter | null           ← 2 列 gutter
      imagePreviewNode（absolute）
    </Box>
    <Box column flexShrink={0}>                      ← 底部 chrome
      NewMessagesPill
      ActivityLine | WorkingSpinner
      CompactionStatusRow
      GoalTodoPanel                                  ← 迁移候选
      AutoRecapRow / BalanceReportRow
      插件 statusEntries 文本行
      PluginStatusViewBoundary × statusViews         ← 插件富状态（≤3 行/个）
      <Box column>                                   ← 输入簇
        approval | ExtensionDialog | Tips | Recap | Btw | question（替换链）
        PromptInput
        StatusLine
        OverlayAbove（absolute bottom:100%，各 picker）
      </Box>
    </Box>
    TooltipLayer / PromptEditorLayer / StarPrompt / WhaleCouponPrompt  ← 根级浮层
  </Box>
```

### 1.2 宽度来源（决定分栏可行性的关键）

| 类别 | 位置 | 分栏后 |
| --- | --- | --- |
| 数值宽度全部来自 `useTerminalSize().columns`（context） | `MessageList:715`、`PromptInput:1036`、`AssistantToolUseMessage:592/608/611/710`、`MarkdownTable:158`、`MermaidDiagram:66`、`MathBlock:60`、`StatusLine:185/483/534`、`CommandSuggestions:52`、`FileSuggestions:116`、`JobCard:135`、`SubagentMessage:73`、`WorkingSpinner:41`、`CompactionStatusRow:53`、`LogoV2:233`、`TranscriptImages:41` | **无需改动**：左栏子树覆盖 `TerminalSizeContext` 后自动拿到聊天列宽 |
| 纯 flex / `width="100%"` | `Markdown`、`StreamingMarkdown`、`ToolUseLoader`、`OverlayAbove`（absolute 跟随父容器） | 无需改动 |
| `measureElement` 按父容器测量 | `Divider:124`、`SearchBox:142`、`InlineMathParagraph:222`、`ImagePreviewOverlay:113` | 无需改动 |
| Chat 顶层 hook 取值后显式下传 | `Chat.tsx` 的 `terminalColumns` → `TimelineRail`/`ScrollbarGutter terminalWidth`（4640/4649）、`imagePreviewRegion`（4510）、`PinnedTurnHeader`（5294）、wake 条（3087） | **需要改**：Chat 的 hook 调用在分栏层之上，要改读分栏层算出的 `chatColumns` |
| 依赖 `PageInset` 做「出血」到终端边缘 | 转录行 `marginRight={-pageInsetX}`（4557）、`Divider.tsx:88-96` 的 `columns + 2*inset.x`、`PromptEditor.tsx:62-80` 全屏编辑器覆盖 | **需要改**：出血只能到分栏边界，见 §4.4 |
| 屏幕坐标换算 | `Tooltip.tsx:190/258-274`（`anchorCol - inset.x`，钳到 `columns`） | TooltipLayer 留在 Chat 根级（分栏层之外），保持读真实页宽即可 |
| 百分比宽度 | `PageMargin.tsx:101-104` 注释：带 padding 的父盒里 `%` 按含 padding 的全宽解析 | 分栏宽度**必须用数值**（`Math.floor`），不要写 `"68%"` |

结论：RFC §68-70「审查哪些 Renderer 错误使用终端宽度」这项工作量在本仓库很
小，真正的工作在出血与坐标补偿（§4.4）、选区（§4.6）与键盘焦点（§7）。

### 1.3 可迁移的辅助组件

| 组件 | 现状 | 数据源 | 迁移判断 |
| --- | --- | --- | --- |
| `GoalTodoPanel` | 底部 chrome 内（4716），`Ctrl+Q` 折叠，无宽高 props，`paddingX=2`，最多 8 条，自带 `setInterval(1s)` | `channel.goal` / `channel.todos`（`channel-ui.ts:211/216`） | **第一批**。移出底部 chrome，输入框上方立刻少 2~10 行 |
| `JobsPanel` | 整屏早返回（4410），`/jobs` 或点击 JobCard 打开，固定列宽 2/9/11/6/9，自带 `useInput` 吞键 | `channel.backgroundJobs` / `jobControl`（`:294/296`，`BackgroundJobStore`） | **第一批**。转录里的 `JobCard`/`JobGroupHeader` **不迁**（属于对话时序）；整屏 JobsPanel 保留为 inline 回退 |
| `SubagentDashboard` / `SubagentDetailScene` | 整屏早返回（4430/4387），`Ctrl+A` 打开 | `channel.subagents` / `subagentControl`（`:285/287`） | **第一批**。转录里的 `SubagentMessage` 不迁 |
| `LogoHeader`（Whale / WhaleGirl / MaidPortrait） | `ScrollBox` 第一个子节点，随转录滚走；`whaleIdle` 仅 `scrollTop<16` 时动 | 设置 `whale/whaleIdle/whaleGirl`，`useMaidPortraits` | **第二批（Companion）**。开屏 splash 仍留在转录顶部；Companion Panel 是同一套 sprite/portrait 的第二视图 |
| 插件富状态视图 | `PluginStatusViewBoundary`（4750），`tuiStatus.registerView`，≤3 行/个、总预算 6 行 | `tuiStatus` store | **接缝原型**。Panel API 直接沿用它的 props/ui 受限模型（§8） |
| `LoadedContextPanel` | 转录顶部，仅空会话时 | `channel.loadedContext` | 后续可选 |
| `ActivityLine`、`WorkingSpinner`、`StatusLine`、`ContextBarView` | 底部 chrome / 状态行 | 工作状态投影 | **不迁**：属于当前回合的即时状态 |
| Thinking / 工具卡 / Markdown / 图片 / 输入框 / 补全 / 问卷 / 审批 | 转录与输入簇 | 会话事件真源 | **不迁，不复制** |

### 1.4 现成可复用的基础设施

- **双栏先例**：`SessionSupervisor.tsx:533-600`——`flexDirection="row" overflow="hidden"`，
  左栏数值宽 `railWidth`，1 列 `│` 分隔，右栏 `sessionWidth`；宽度在
  `useSessionSupervisor.ts:519-523` 按列数与 30% 比例钳制；`onClick`/`onMouseEnter`
  切换 `activePane`。分栏层可直接以它为模板。
- **动画时钟**：`ClockProvider`（`src/ink/components/ClockContext.tsx`，单一
  16ms interval，失焦 32ms，无订阅者不跑）+ `useAnimationFrame(ms|null)`
  （离屏自动暂停）。RFC 的 "AnimationClock" 已存在，Panel 只需遵守「不用裸
  `setInterval`」。
- **鼠标**：`hit-test.ts` 按节点屏幕矩形命中，滚轮 `dispatchWheel` 按命中
  节点派发——右栏可以有自己的 `ScrollBox`；拖拽协议已有回归
  （`verify-drag-protocol.tsx`）。
- **插件隔离**：`PluginSceneBoundary` / `PluginStatusViewBoundary`；注册链
  `requirePluginCaller` → `activationFiber` → `bindCallerEffect`
  （`host-access.ts:412-443/617`）；能力名登记在
  `ADAPTER_CAPABILITY_EFFECT_CLASSES` / `ADAPTER_CAPABILITY_SLICES`
  （`src/adapter/kernel/runtime.ts`），未登记直接抛错。
- **设置**：`src/settings/definitions.ts` 单点定义 → `dsh-adapter/index.ts` Schema
  → `plugin.ts` format/parse → 生成 `lib/settings.json`，`verify:settings` 门禁。
- **模块级 live store**：`tuiDisplayPrefs.ts` 的 `createLiveSetting`
  （`subscribe/get/apply`，供 `useSyncExternalStore`），`PageMargin` 用它接收
  位于 Chat 之上的设置变化。

---

## 2. 最重要的边界

### 2.1 Chat Panel 不是新的聊天实现

以下功能**全部继续使用当前实现**，不为侧栏重写或复制：消息列表、用户/助手
消息、流式、Thinking、工具调用与结果、Markdown、代码块、图片、LaTeX、diff、
状态行、输入框、slash 命令、补全、附件、问卷、审批。

### 2.2 输入框属于 Chat Panel

```text
SidePanelLayout
├── Chat Panel（= 现有 Chat 主 return 的三段：置顶头 + 转录行 + 底部 chrome/输入簇）
│   └── PromptInput / StatusLine / OverlayAbove
└── Side Panel（Panel 导航 + Panel Host）
```

不出现「全局输入框」。侧栏永远不能替换、隐藏、移动 Chat 或输入区。

### 2.3 左右职责

| | 回答的问题 | 内容 |
| --- | --- | --- |
| 左：Conversation Surface | Agent 在和我说什么？ | 正文、Thinking、工具卡、流式、图片、Markdown、用户输入——**一次对话行为** |
| 右：Side Panel Surface | 当前任务 / 环境 / Agent 体系是什么状态？ | Goal/Todo、Jobs、子代理、Companion、插件 Panel——**跨回合持续状态** |

划分依据是「是否属于对话时序」，不是「信息多不多」。因此工具调用留在左侧；
如果未来需要「所有工具历史」视图，那是新增的 Tool Activity Panel，消费同一
份 `channel.rows` 投影，不是把工具卡搬走。

### 2.4 同一数据允许多个视图，但只有一份状态

Jobs 同时出现在转录（JobCard）和侧栏（Jobs Panel），都读 `channel.backgroundJobs`；
子代理同理。不允许出现 `ToolCallState` / `ToolPanelState` 两套投影。会话事件
日志仍是真源（见 [architecture.md](architecture.md) 「Session 是真源」）。

---

## 3. 总体架构

```text
                     DSH session/event 日志（真源）
                                │
                    dsh-adapter/channel.ts 投影
        ┌──────────────┬────────┴─────────┬──────────────┐
        │              │                  │              │
   rows / working   goal / todos    backgroundJobs    subagents   … workingActivity
        │              │                  │              │
        ▼              └────────┬─────────┴──────────────┘
  现有 Chat 渲染链              │
        │              Panel Adapter（每个内置 Panel 一个，只做呈现适配）
        │                       │
        │                PanelRegistry（内置 + 插件 ctx.tuiPanels）
        │                       │
        │                  PanelHost（bounds / focus / error boundary / scroll）
        ▼                       ▼
┌────────────────────────────────────────────────────────────────┐
│ SidePanelLayout（只管「左边多宽、右边多宽、谁有焦点」）            │
│ ┌────────────────────────────────┐ │ ┌─────────────────────────┐ │
│ │ Chat Panel                     │ │ │ [Todo] ● • • +2         │ │
│ │ 现有消息 / 工具 / Thinking 渲染 │ │ ├─────────────────────────┤ │
│ │ 现有输入簇 + 状态行             │ │ │ Panel Host              │ │
│ └────────────────────────────────┘ │ └─────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

职责一句话：

- `SidePanelLayout`：左右宽度、焦点区、divider。
- 现有 Chat：一切对话内容。
- Panel 系统：一切辅助内容。
- 现有 channel 投影 / store：业务状态。
- Adapter：把现有组件放进右栏。

---

## 4. SidePanelLayout

### 4.1 插入点：Chat 主 return 内部，不是 Chat 外面

早返回链里的整屏页面（Settings、SessionSupervisor、TrajectoryScene、plugin
scene 等）必须保持整屏宽，所以分栏层**不能**包在 `<Chat/>` 外面。改动落在
`Chat.tsx:4531` 的主 return：

```tsx
// 改造后（示意）
<Box ref={wakeTickRef} flexDirection="column" flexGrow={1} width="100%">
  <SidePanelLayout
    columns={pageColumns}          // PageMargin 之后的内容区宽度
    rows={pageRows}
    state={sidePanel}              // §4.5
    side={<SidePanelColumn … />}   // 导航 + PanelHost
  >
    <Box flexDirection="column" flexGrow={1}>
      {/* 原 PinnedTurnHeader */}
      {/* 原转录行 */}
      {/* 原底部 chrome + 输入簇 */}
    </Box>
  </SidePanelLayout>
  {/* TooltipLayer / PromptEditorLayer / StarPrompt / WhaleCouponPrompt 保持在根级 */}
</Box>
```

`SidePanelLayout` 对左栏子树做三件事，与 `PageMargin` 同构：

1. `TerminalSizeContext.Provider value={{ columns: chatColumns, rows }}`；
2. 数值宽度盒 `<Box width={chatColumns} flexDirection="column" overflow="hidden">`；
3. 提供 §4.4 的 `SurfaceEdgesContext`（出血边界）。

`PageInsetContext` **不覆盖**：左栏原点仍是页内容区原点，Tooltip 的
`anchorCol - inset.x` 换算保持正确。

### 4.2 几何常量与规则

```ts
// src/components/sidePanel/dimensions.ts（纯函数，供回归脚本直接断言）
export const CHAT_MIN_COLUMNS = 64     // 保住 2 列 gutter（RAIL_MIN_TERMINAL_WIDTH=60）+ 工具卡缩进
export const PANEL_MIN_COLUMNS = 28    // Jobs panel variant 的最窄可读宽度
export const DIVIDER_COLUMNS = 1
export const DEFAULT_RATIO = 0.68      // 聊天列占比
export const ZOOM_RATIO = 0.20

export function canSplit(columns: number): boolean {
  return columns >= CHAT_MIN_COLUMNS + PANEL_MIN_COLUMNS + DIVIDER_COLUMNS   // ≥ 93
}

export function resolveSplit(columns: number, ratio: number): { chat: number; panel: number } {
  const chat = clamp(Math.floor(columns * ratio), CHAT_MIN_COLUMNS, columns - PANEL_MIN_COLUMNS - DIVIDER_COLUMNS)
  return { chat, panel: columns - chat - DIVIDER_COLUMNS }
}
```

- 不写死 `columns < 100` 之类阈值，一律从最小宽度推导。
- 常量以现有实测为锚：gutter 在 60 列以下隐藏（`ink/timeline-rail.ts:32-35`）；
  Edit/Write 工具卡在 `columns >= 110` 自动切双栏 diff
  （`AssistantToolUseMessage.tsx:611`）——分栏后聊天列通常 < 110，diff 会回到
  unified，这是**预期行为**，不是 bug；`SessionSupervisor` 的侧轨按 30% 钳制。
  具体数值在 Phase 1 用回归脚本在 100 / 120 / 160 / 200 列下校准后再冻结。

### 4.3 三种模式 + 窄屏回退

| 模式 | 布局 | 说明 |
| --- | --- | --- |
| `split`（默认开启时） | `Chat │ Panel`，68:32 | 聊天列 = `resolveSplit` |
| `collapsed` | `Chat` 全宽 | 现有渲染链按新宽度重排；gutter 恢复出血到终端右边 |
| `zoom` | `Chat │ Panel`，20:80 | 聊天列仍 ≥ `CHAT_MIN_COLUMNS`；进入时记录 `ratioBeforeZoom`，退出恢复用户手调比例而非默认值 |
| 窄屏（`!canSplit`）或 inline | 不分栏 | 打开 Panel 时走现有「整屏早返回 + `<AlternateScreen>`」形态（JobsPanel / SubagentDashboard 今天就是这样）；Panel 组件不感知差别，只是拿到全宽 |

模式切换**不做逐帧宽度动画**：每一列宽度变化都触发整棵转录重排（Markdown
wrap、工具卡、图片放置、Sixel 重传），瞬时切换在终端里反而体验更好。

### 4.4 出血（bleed）与全屏浮层

新增一个小 context 表达「本 surface 左右各可出血多少列」，由 `PageMargin`
提供默认值 `{ left: x, right: x }`，分栏层为左栏覆盖为 `{ left: x, right: 0 }`、
右栏 `{ left: 0, right: x }`：

```ts
export interface SurfaceEdges { readonly left: number; readonly right: number }
export const SurfaceEdgesContext = React.createContext<SurfaceEdges>({ left: 0, right: 0 })
```

需要改读它的三处：

1. `Chat.tsx:4557` 转录行 `marginRight={-pageInsetX}` → `-edges.right`；
2. `design-system/Divider.tsx:88-96` 的出血宽 `columns + 2*inset.x` →
   `columns + edges.left + edges.right`；
3. `PromptEditor.tsx:62-80` 全屏草稿编辑器：不改坐标数学，而是 **编辑器打开
   期间分栏层渲染为 `collapsed`**（与 `imagePreviewNode` 在编辑器打开时移到
   根级的现有做法一致），编辑器照旧覆盖整页；关闭后恢复侧栏。

`OverlayAbove`（picker）是 `position="absolute" bottom="100%" left=0 right=0`
钉在输入簇上，天然只覆盖聊天列，无需改动。`ImagePreviewOverlay` 相对转录行
定位，`region.columns` 改读 `chatColumns`（§4.7）。`TooltipLayer` 留在根级。

### 4.5 布局状态

```ts
export interface SidePanelLayoutState {
  open: boolean
  ratio: number                 // 聊天列占比，用户手调后持久化
  mode: 'split' | 'zoom'
  focus: 'chat' | 'panel'
  activePanelId?: string
  ratioBeforeZoom?: number
}
```

不包含 `inputFocused`、`thinking`、`toolRunning`、todo/jobs/agents 数据——那些
不是布局的职责。Chat 内部的输入焦点、补全、选区、modal 继续由 Chat 自己管
（`chatOverlay.ts` 状态机不动）。

状态所在：`open` / `ratio` / `mode` 用 `tuiDisplayPrefs.createLiveSetting` 模块
级 store（与 `pageMargin` 同款），因为它既要被 Chat 内的按键改，也要被
`/settings` 与 `cordis.yml` 改；`focus` / `activePanelId` / `ratioBeforeZoom`
是 Chat 的 React state。

### 4.6 选区

全屏文本选区是**线性、按整行屏幕坐标**的（`ink/selection.ts:1467-1468/1519-1523`，
三击选整行）：在左栏跨行拖选会把右栏同一行的字一起复制进去。V1 处理：

- 右栏根盒加 `noSelect`（`styles.ts:436`，已有 `NoSelect` 组件），从选区与
  copy-on-select 中排除；
- 右栏内容的复制走 Panel 自己的动作（焦点在右栏时 `y` / `Ctrl+C` 复制当前
  项，复用现有 OSC 52 路径）；
- 按列裁剪选区（真正的双列选区）列为后续项，需要动 `selection.ts`，单独提案。

### 4.7 Chat 内唯一允许的改动清单

只允许「布局适配型」修改：

1. 主 return 三段包进 `SidePanelLayout`（§4.1）；
2. Chat 顶层 `terminalColumns` 的显式下传改读 `chatColumns`：`TimelineRail` /
   `ScrollbarGutter` 的 `terminalWidth`、`imagePreviewRegion.columns`、
   `PinnedTurnHeader`、wake 条；
3. 转录行 `marginRight` 改读 `SurfaceEdgesContext`；
4. 移除已迁走的 `GoalTodoPanel` 挂载（分栏开启时；窄屏 / inline 回退时仍挂）；
5. 键盘链新增 `focus === 'panel'` 分支与 `sidePanel*` 动作（§7）；
6. 全屏编辑器打开期间强制 `collapsed`。

除此之外不碰 `MessageList`、`PromptInput`、消息渲染器与 `ink/`。

---

## 5. Divider 与 Resize

- 中缝 1 列 `│`，用主题语义色：无焦点 `subtle`，右栏有焦点时 `accent`
  （或加粗为 `┃`）。不用强边框抢视觉。
- Resize：V1 键盘（焦点在右栏时 `+`/`-` 或 `Shift+←/→`，步长 4 列，持久化
  `ratio`）；V1.1 鼠标拖 divider（复用 `onDragStart/Move/End` 捕获式拖拽协议，
  与 `verify-drag-protocol.tsx` 同一套语义）。
- 点击左栏 → `focus='chat'`；点击右栏 → `focus='panel'`（照
  `SessionSupervisor` 的 `activateRail`/`activateList`）。

---

## 6. Panel 系统（只服务右栏）

### 6.1 右栏结构

```text
Side Panel Column（width = panel, height = rows）
├── PanelBar        1 行：[ 2. Jobs ]  • ● • ! •  +2      （胶囊 + 状态点，窗口化）
├── PanelHost       flexGrow：Active Panel（Error Boundary + ScrollBox）
└── PanelHint       1 行：焦点在右栏时的按键提示（i18n）
```

### 6.2 Panel Definition / Props / Capabilities

```ts
export interface PanelDefinition {
  id: string                       // /^[a-z][a-z0-9_-]*(:[a-z][a-z0-9_-]*)*$/，插件用 plugin:sub 命名空间
  title: string                    // 内置 Panel 走 i18n key；插件给字面量
  order?: number
  minColumns?: number              // 低于时 PanelBar 显示但 Host 提示「宽度不足」
  defaultEnabled?: boolean
  source: 'builtin' | 'plugin'
  pluginId?: string
  capabilities?: PanelCapabilities
  component: React.ComponentType<PanelProps>
}

export interface PanelProps {
  readonly width: number
  readonly height: number
  readonly focused: boolean
  readonly visible: boolean        // 非 active 时 false：组件应停掉高频刷新，store 继续更新
  readonly mode: 'split' | 'zoom' | 'fullscreen'   // fullscreen = 窄屏/inline 回退
}

export interface PanelCapabilities {
  scroll?: boolean
  search?: boolean
  selection?: boolean
  zoom?: boolean
  sendToChat?: boolean
}
```

Panel **不知道**自己在右侧、比例多少、终端总宽多少；只知道 width / height /
focused / visible / mode。以后把侧栏改到底部，Panel 不用重写。

### 6.3 PanelHost 职责

- 计算 bounds 并以 `PanelProps` 传入；**同时**为 Panel 子树再嵌套一层
  `TerminalSizeContext`（columns = panel width），这样把现有组件（它们读
  `useTerminalSize()`）直接放进来也能拿到正确宽度。
- 每个 Panel 独立 `PanelErrorBoundary`（照 `PluginStatusViewBoundary`：出错只
  隐藏该 Panel、记 `reportPanelError`、同 key 重注册用 `registrationId` 重挂）。
  插件 Panel 崩溃时，Chat 的输入、流式、工具卡必须完全不受影响——**硬要求**。
- 非 active Panel 不挂载（`visible=false` 只对声明了 `keepMounted` 的 Panel
  有意义；V1 不提供 `keepMounted`，重新打开时直接读最新 store）。
- 焦点在右栏时接管键盘（§7），Chat 主 `useInput` 链在 `focus==='panel'` 时让位。
- 右栏内的 `ScrollBox` 按命中节点接收滚轮。
- 不知道 Chat 消息、输入、Thinking、工具。

### 6.4 PanelRegistry

```ts
class PanelRegistry {
  register(definition: PanelDefinition, owner: PanelOwner): () => void   // 重复 id → DUPLICATE_CONTRIBUTION_ID
  list(): readonly PanelDefinition[]                                    // 按 order，再按注册顺序
  get(id: string): PanelDefinition | undefined
  subscribe(listener: () => void): () => void
}
```

内置 Panel 在 `plugin.ts` 组装期注册；插件经 `ctx.tuiPanels`（§8）。Chat 侧
的 PanelBar 只画 **已启用**（`dsh-tui.sidePanel.panels` 设置）且已注册的 Panel。

### 6.5 通知与 Soft Follow

不做每帧 `hasNotification()` 轮询。各 store 已有版本/订阅（`channel.subscribe`、
`BackgroundJobStore`、`SubagentActivityStore`），Adapter 在 store 变化时向
`PanelNotificationStore` 写入：

```ts
interface PanelNotificationState { level: 'info' | 'warning' | 'error'; unread: number; latestAt: number }
```

PanelBar 状态点：`•` idle、`●` active / unread、`!` warning、`×` error，颜色由
主题控制，不用 emoji 做布局字符。后台 Panel 更新**不自动切换**，只亮点；用户
打开该 Panel 时清零。`minimalUi` 下状态点退化为纯字符（与 `JobsPanel` 去
emoji 的现有做法一致）。

### 6.6 Panel 过多

```text
[ Jobs ]  · · ● · ·  +7        （窗口化，不是一长串点）
```

`/panel` 无参数打开 Panel 选择器（复用 `Select` 原语，走 `chatOverlay.ts` 新增
`{ kind: 'panel'; index }` 变体，保持 overlay 互斥结构）。

### 6.7 Send to Chat

侧栏与 Chat 最重要的连接。现状：`PromptInput` 对外只有 `fillText`
（整段替换草稿并丢弃图片，`PromptInput.tsx:517-522/958-970`），**没有**
`attachContext` / `insertText`。最接近的先例是 IDE 选区通道：`ChannelUi.selection`
在提交时自动附成 `<attached-file … selection>` 块（`channel/ide-selection.ts`、
`channel.ts:309-352`）。

方案：在 channel 层新增「附加上下文」投影与动作（属于 `dsh-adapter/channel.ts`
职责，不在 TUI 里造第二套输入）：

```ts
// ChannelUi 新增（ui-policy.ts 登记 effect 分类：attachContext = mutate）
readonly attachedContexts: readonly AttachedContext[]
attachContext(input: { source: 'panel'; sourceId: string; title: string; content: string }): void
detachContext(id: string): void

interface AttachedContext { id: string; source: 'panel'; sourceId: string; title: string; content: string; chars: number }
```

- `PromptInput` 在输入行上方显示 `[⧉ Job #142]` 这类 chip（与 `[Image #N]`
  同一行区），Esc 层级里加「有附加上下文时先清」；
- 提交时经 `composer` 与 `@` 展开同一条路径附成 `<attached-context source=…>`
  块，沿用 `MENTION_MAX_FILE_CHARS` 上限；
- 会话切换 / rewind / resume 时随其他会话级投影一起清空（契约见
  contributing.md 「会话与通道状态」）。

Phase 4 与 Jobs Panel 一起落地；V1 前几阶段不阻塞。

---

## 7. 键盘、焦点与命令

### 7.1 焦点模型

全局只有 `focus: 'chat' | 'panel'`。Chat 内部的输入 / 消息选择 / 补全 / modal
继续由 Chat 与 `chatOverlay.ts` 管理；`ink/focus.ts` 的 `FocusManager` Chat
今天没用，本设计也不引入。

优先级插入位置（`Chat.tsx:3259-4160` 的单一 `useInput` 链）：在现有「早返回
面板让位」之后、`help / approval / question / overlay` 之前加一段：
`focus === 'panel'` 且无 approval / question / dialog 时，按键交给
`PanelHost`，Chat 的全局动作不再匹配。**审批、问卷、插件对话框仍先于一切**。

### 7.2 键位

| 动作 id（进 `SHORTCUT_ACTIONS`，`/settings → Shortcuts` 可重映射） | 默认 | 语义 |
| --- | --- | --- |
| `sidePanel` | `ctrl+b` | 未开：打开并聚焦；已开且焦点在 Chat：聚焦右栏；焦点已在右栏：关闭并回到 Chat。VS Code 同键位；tmux 用户会被前缀吞掉，需重映射（文档注明） |
| `sidePanelZoom` | `alt+z` | 切换 zoom |
| Esc（焦点在右栏） | 固定 | `focus → chat`，并调用现有 `promptControllerRef` 焦点输入；不新增光标管理 |

选键依据：`FIXED_RESERVED_COMBOS` 与现有动作占用了
Ctrl+A/C/D/E/G/J/K/L/O/P/Q/R/T/U/V/W、Alt+S/V/Up、Tab、Shift+Tab、Esc
（`src/utils/keymap.ts:201-217/333-351`）；Ctrl+H/I/M 与 Backspace/Tab/Enter
同码，Ctrl+S 在部分终端是 XOFF，Ctrl+Z 是挂起信号。可用：Ctrl+B/F/N/X/Y、
Alt+其他字母、Ctrl+Shift+字母。

焦点在右栏时的 Panel 内按键（不进全局表，PanelHint 行提示）：
`←/→` 或 `[`/`]` 切 Panel、`1-9` 直达、`↑/↓ PgUp/PgDn` 滚动、`Enter` Panel 主
动作、`s` Send to Chat、`z` zoom、`+/-` 调宽、`y` 复制、`Esc` 回 Chat。

绝不在 Chat 输入态下抢 `Tab`（补全 / follow-up）、方向键（历史 / 多行）、
普通字母、`Ctrl+A/E`（行首行尾）。

### 7.3 命令

本地命令（`src/commands.ts` 声明、`Chat.tsx` 分发、`i18n.ts` 加 `cmd-desc-panel`）：

```text
/panel               打开 Panel 选择器
/panel <id>          打开并聚焦指定 Panel（todo / jobs / agents / companion / <plugin:id>）
/panel toggle        等同 sidePanel 动作
/panel zoom
/panel manage        Panel 启用管理（勾选列表，写设置 dsh-tui.sidePanel.panels）
```

子命令补全经 `tuiCommandTrees.register({ root: 'panel', children })`。现有
`/jobs` 在分栏开启时改为打开 Jobs Panel；窄屏 / inline 仍打开整屏 JobsPanel。
`Ctrl+A`（dashboard）同理映射到 Agents Panel。

---

## 8. 插件接缝 `ctx.tuiPanels`

沿用 `tuiScenes` / `tuiStatus` 的写法，不发明新模式：

- **服务行**：`cordis.patch.yml` 新增 `dsh-tui-panels` 行（或并入
  `dsh-tui-extensions` 行），`package.json exports` 加 `./panels` 子路径，
  `patch-surface.snapshot.json` 同步（`verify:patch-surface`）；`src/panels.ts`
  是转发 shim，实现在 `src/dsh-adapter/panels.ts`。
- **注册**：`register(descriptor, identity?)` → `requirePluginCaller` →
  `activationFiber` owner → `bindCallerEffect` 挂 disposer；写 effect ledger；
  重复 id 抛 `DUPLICATE_CONTRIBUTION_ID`。插件释放时其 Panel 自动撤下，若正
  是 active Panel 则回到上一个。
- **能力名**：`host.panels.register`（register）、`host.panels.list`（read-only）、
  `host.panels.open` / `close`（mutate）、`host.panels.notify`（mutate）、
  `host.panels.subscribe`（subscribe）——四处同步：
  `ADAPTER_CAPABILITY_EFFECT_CLASSES`、`ADAPTER_CAPABILITY_SLICES`、kernel slice、
  upstream driver 与 `host-facade.ts` 映射；每个方法入口
  `assertCapabilityShadowPolicy`。
- **manifest**：若要求 manifest 声明，需在 dsh-ecosystem-spec 新增
  `panels.dsh/v1alpha1#Panel` contributes 类型（与 `commands` 的准入同构）。
  在 spec 落地前 `ctx.tuiPanels` 标为 **实验性**（`docs/plugins.md` 分级表）。
- **props 收窄**：插件 Panel 拿到的是

  ```ts
  interface TuiPanelProps extends PanelProps {
    readonly React: typeof React
    readonly ui: TuiPanelUi          // Box（去 focus/keyboard/ref，保留 click/hover/drag/wheel）、Text、Image、ScrollBox、useTerminalSize
    readonly host: {
      readonly notify(level: 'info' | 'warning' | 'error'): void      // 只影响自己的状态点
      readonly sendToChat(input: { title: string; content: string }): void   // 经 §6.7 通道
      readonly keys: PanelKeySubscription                             // 仅在自己 focused 时收到按键
    }
  }
  ```

  **不**直接给完整 `ChannelUi`（scene 给了，但 Panel 常驻且数量多，面要更窄）；
  需要读投影时给策展过的只读快照（goal/todos/jobs/subagents/working）。
- 与 `tuiStatus.registerView` 的关系：status view 继续存在（1~3 行、无键盘），
  Panel 是它的「大版本」。同一插件可以两者都注册，宿主不自动迁移。

插件能：注册 Panel、注册命令 / 快捷键、点亮自己的状态点、Send to Chat。
插件不能：替换 / 隐藏 / 移动 Chat 或输入框、改 Chat 渲染器、强制布局比例、
关闭别人的 Panel、在未聚焦时收键盘。

---

## 9. 现有组件迁移原则与 Adapter

**已有组件不重写。** 每个迁移项 = 一个 Adapter + 原组件的呈现适配：

```tsx
export function TodoPanelAdapter(props: PanelProps) {
  return <GoalTodoPanel channel={channel} variant="panel" />   // 仍读 channel.goal / channel.todos
}
```

原组件逐步支持 `variant: 'default' | 'panel'`：panel variant 更紧凑、去外层
padding / 重复标题、按窄宽度换行、把裸 `setInterval` 换成 `useAnimationFrame`
并在 `visible=false` 时传 `null` 暂停。业务逻辑与 store 不变。

| 顺序 | Panel id | 原组件 | 适配要点 |
| --- | --- | --- | --- |
| 1 | `todo` | `GoalTodoPanel` | 去 `paddingX=2`，`MAX_TODOS` 改按 height 计算；`setInterval(1s)` → `useAnimationFrame(1000)`；`Ctrl+Q` 折叠改为在 Panel 内折叠 goal 段；`StatusLine` 的 `GoalStatusChip` 保留（同一数据的第二视图） |
| 2 | `jobs` | `JobsPanel` | 固定列宽 2/9/11/6/9 改为按 width 分配（窄时省略 duration/pid 列）；`useInput` 改由 PanelHost 转发；`onKill` 复用 `jobControl`；整屏形态保留给回退 |
| 3 | `agents` | `SubagentDashboard` + `SubagentDetailScene` | Dashboard 作为 Panel 主视图，`Enter` 进 Detail（Panel 内二级视图），`Esc` 返回；分隔线 `min(72, columns-6)` 自动跟随收窄的 context |
| 4 | `companion` | `WhaleArt` / `WhaleGirlArt` / `MaidPortrait` + `whaleIdle` 状态机 | 默认 **禁用**；ASCII 先做；图形版复用现有 `<Image>` 与终端图片后端，**禁止**再造 Kitty / Sixel 渲染器；驱动统一走 `Application Events → Activity Bridge → Companion State Resolver`，Bridge 读 `workingActivity` 投影与 `channel.working`，不从 Jobs/Tools 各接一条 |

Thinking、工具卡、`SubagentMessage`、`JobCard`、`LogoHeader` 开屏 splash 全部
保持原实现原位置。

---

## 10. 设置与持久化

用户可配置项走设置（三处一次：`definitions.ts` 定义、`dsh-adapter/index.ts`
Schema、`plugin.ts` format/parse；`SETTING_GROUPS` 新增 `side-panel` 分组；
`pnpm compile` 生成 `lib/settings.json`；`verify:settings` 门禁）：

| key | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `dsh-tui.sidePanel.enabled` | boolean | `true` | 总开关；`false` 时 `/panel` 与 `Ctrl+B` 走窄屏回退形态 |
| `dsh-tui.sidePanel.open` | boolean | `false` | 启动时是否展开（首个版本默认收起，降低升级冲击） |
| `dsh-tui.sidePanel.ratio` | number | `0.68` | 聊天列占比，手调后回写 |
| `dsh-tui.sidePanel.panels` | 逗号分隔 id | `todo,jobs,agents` | 启用的 Panel，顺序即 PanelBar 顺序；`companion` 需显式加入 |

不新增 `~/.dsh-tui/*.json` 文件：`activePanelId` 与 `ratioBeforeZoom` 是进程内
状态，重启回到首个启用 Panel。Companion 是否开启就是 `panels` 里有没有
`companion`，不另建设置系统。

优先级遵守现有约定：cordis.yml / 环境显式配置 > 持久化用户选择 > 默认。

---

## 11. 性能约束

- Panel 与 Adapter **禁止**裸 `setInterval` / `setTimeout` 链；一律
  `useAnimationFrame(ms | null)`，`visible=false` 或 `!focused && 静态` 时传
  `null`。
- 切换 Panel、开合侧栏、zoom 都会改聊天列宽 → 整棵转录重排。这是可接受的
  单次成本；**禁止**周期性改宽度（动画、随内容抖动的 PanelBar 宽度等）。
- 右栏 Panel 的 store 在侧栏收起时继续更新（它们本来就在 channel 里），UI 不
  挂载。
- Chat 不休眠：焦点在右栏时，左栏流式、工具卡、Thinking、消息更新照常。
- 沿用有界缓存原则：`PanelNotificationStore` 每 Panel 一条记录，无历史列表。

---

## 12. 验证计划

新增脚本沿用 `scripts/lib/term-test.mjs`（xterm headless + `settled` /
`viewportLines`），在 `scripts/run-ci-group.mjs` 的 `GROUPS` 表登记，并按
[contributing.md](contributing.md) 验证矩阵补一行。

| 脚本 | 断言 |
| --- | --- |
| `verify-side-panel-geometry.ts`（纯函数） | `canSplit` / `resolveSplit` 在 80 / 93 / 100 / 120 / 160 / 200 列的边界；zoom 恢复 `ratioBeforeZoom`；最小宽度钳制 |
| `verify-side-panel-layout.tsx` | 100 / 120 / 160 列下 split / collapsed / zoom 三态：divider 列位置、输入框与状态行不越过 divider、gutter 停在聊天列右缘、右栏首行是 PanelBar；`term.resize` 跨阈值后与全新渲染帧一致（照 `verify-resize-reflow.tsx` 的「最终状态等价」预言机） |
| `verify-side-panel-bleed.tsx` | `Divider` 与转录行出血只到 divider；`PageMargin` 有边距时右栏不被左栏 `-marginRight` 侵入；全屏编辑器打开时侧栏收起、关闭后恢复 |
| `verify-side-panel-keys.tsx` | Chat 输入态下 `Tab` / 方向键 / 字母 / `Ctrl+A/E` 不被侧栏消费；`Ctrl+B` 三态循环；`Esc` 回输入框且光标可继续输入；审批 / 问卷打开时侧栏按键让位 |
| `verify-side-panel-selection.tsx` | 左栏跨行拖选的复制文本不含右栏内容 |
| `verify-side-panel-boundary.tsx` | 插件 Panel render 抛错：只该 Panel 显示错误卡；期间提交一条消息、流式与工具卡照常 |
| `verify-side-panel-images.tsx` | 侧栏开启时转录缩略图 / 大图预览的 x 偏移与裁剪正确；右栏内 `<Image>` 可绘制（复用 `verify-image-inspection` 的 harness） |
| 迁移项各一 | `verify-goal-todo.mjs` 扩 panel variant；`verify-jobs-panel` 扩 Panel 形态与整屏回退；子代理同理 |

既有必跑：`pnpm build`（含 `verify:boundary` / `verify:i18n` /
`verify:patch-surface` / `verify:settings` / `verify:chat-overlay`）、CI 三项
回归（`repro-askpanel`、`verify-askpanel-layout`、`repro-toolcards`）、
`verify-resize-reflow`、`verify-divider-width`、`verify-terminal-images*`、
`verify-copy-on-select`、`verify-pointer-events`、`verify-drag-protocol`。
环境可用时在 fullscreen 下于 90 / 120 / 200 列手动演练，并在 inline 与
tmux（`Ctrl+B` 前缀）下确认回退与提示。

---

## 13. 分阶段落地

| 阶段 | 交付 | 退出条件 |
| --- | --- | --- |
| **0 · 边界盘点** | 本文 §1 | 已完成 |
| **1 · Shell** | `SidePanelLayout` + `dimensions.ts` + `SurfaceEdgesContext`；右栏只画 `Side Panel` 占位；`Ctrl+B` / `/panel toggle`；设置四项 | 几何与布局回归通过；侧栏收起时所有现有回归零 diff |
| **2 · Chat 宽度与出血** | §4.7 六项改动；`verify-side-panel-bleed` / `-images` / `-selection` | 侧栏开启时 Thinking / 工具卡 / Markdown / 图片 / 输入框 / picker 在 68:32、100:0、20:80 与 resize 下正确 |
| **3 · Panel Core** | `PanelRegistry` / `PanelHost` / `PanelBar` / `PanelErrorBoundary` / `PanelNotificationStore` / Panel 选择器 overlay / 焦点键盘链 | `verify-side-panel-keys` / `-boundary` 通过；内部 API，不对插件开放 |
| **4 · 迁移** | `todo` → `jobs`（含 §6.7 Send to Chat 通道）→ `agents`；`GoalTodoPanel` 从底部 chrome 移除（分栏时） | 各 Panel 与整屏回退双形态回归；原 store 零复制 |
| **5 · Companion** | `companion` Panel（默认禁用），ASCII 先、图形复用 `<Image>` | 与 `whaleIdle` 状态机共用一份 sprite / 帧表 |
| **6 · 插件 API** | `ctx.tuiPanels`、能力四表、patch-surface、`exports`、spec contributes 类型、`docs/plugins.md` 分级（实验性） | `verify:plugin-*` 系列扩展通过；至少一个内置 Panel 改经同一 API 注册以验证消费面 |
| **7 · 后续** | Files / Context Inspector / Sessions / Tool Activity / 双列选区 / divider 拖拽 / 底部区域 | 不阻塞主架构 |

---

## 14. 跨文件同步清单（按 contributing.md）

- 快捷键：`src/utils/keymap.ts` `SHORTCUT_ACTIONS`、`Chat.tsx` 分发、`HelpMenu`、
  `docs/interaction{,.en}.md` 快捷键表、双 README。
- 命令：`src/commands.ts`、`Chat.tsx runCommand`、`i18n.ts` `cmd-desc-panel`、
  `tuiCommandTrees`、帮助、双 README。
- 设置：`src/settings/definitions.ts`、`src/dsh-adapter/index.ts` Schema、
  `plugin.ts` format/parse、`cordis.patch.yml` / `cordis.yml` 示例行、
  `docs/user-guide{,.en}.md` 设置表、`docs/configuration{,.en}.md`。
- 插件接缝：`cordis.patch.yml` 服务行 + `patch-surface.snapshot.json`、
  `package.json exports`、`src/api.ts` 类型策展、`docs/plugins{,.en}.md` 分级、
  `ADAPTER.md`、dsh-ecosystem-spec contributes 类型。
- 架构：`docs/architecture{,.en}.md` 模块边界表加 `SidePanelLayout` /
  `PanelHost` 一行；`AGENTS.md` 仓库布局加 `src/components/sidePanel/`。
- 文案：全部走 `t()`，`verify:i18n` 门禁。

---

## 15. 验收标准

**Chat**：侧栏开启后，用户消息、助手消息、Thinking、工具卡、流式、Markdown、
图片、输入、补全、审批、问卷的行为与改造前一致；唯一变化是可用宽度。

**迁移组件**：Todo / Jobs / Agents 继续读原 store，不复制状态、不实现第二套
逻辑；侧栏收起时数据继续更新；窄屏 / inline 回退到整屏形态。

**输入**：输入框永远属于 Chat；侧栏开关不影响输入逻辑；Esc 一步回输入框；
补全不被侧栏快捷键破坏；侧栏收起后输入框自动扩宽。

**插件**：能新增右栏 Panel；不能破坏 Chat、替换输入、改渲染器、控制主布局；
Panel 崩溃不中断对话。

---

## 16. 与上一版 RFC 的差异

| RFC 条目 | 修订 | 依据 |
| --- | --- | --- |
| 命名 "Workspace" | 改为 "侧栏 / Side Panel"，服务 `tuiPanels` | `/workspace`、`tuiWorkspaces`、`/home` 已占用该词 |
| §14/20 窄屏「Switch / Overlay」 | 窄屏与 **inline 模式** 统一回退到现有整屏早返回形态 | inline 帧高随内容、无鼠标 / 图片，右栏无法钉住 |
| §69 新增 `SurfaceBoundsProvider` | 复用 `TerminalSizeContext` 覆盖 + `PageInsetContext`；新增仅 `SurfaceEdgesContext`（出血） | `PageMargin` 同机制已在产；无组件直读 `stdout.columns` |
| §68/70 「审查 Terminal Width 依赖」为最大工作量 | 降为小项；主要工作转到出血、选区、焦点键盘链、Send to Chat 通道 | §1.2 表 |
| §9 「包在 ExistingChat 外面」 | 包在 Chat **主 return 内部**，早返回整屏页面不分栏 | Settings / Supervisor / Trajectory 必须整屏 |
| §18 `CHAT_MIN_WIDTH=56 / WORKSPACE_MIN=26` | 64 / 28，以 gutter 60 列阈值与 Jobs 列宽为锚，Phase 1 校准后冻结 | `timeline-rail.ts:32-35`、`JobsPanel.tsx:113-141` |
| §22 Resize | 键盘 V1、拖拽 V1.1 不变；拖拽复用既有捕获式拖拽协议 | `verify-drag-protocol.tsx` |
| §49 避免 `Ctrl+A` | `Ctrl+A` 已是 dashboard 动作；默认键选 `Ctrl+B`（VS Code 同键，注明 tmux 需重映射） | `keymap.ts:201-217/333-351` |
| §56-57 `ctx.chat.attachContext` | 落到 channel 层 `attachContext` 投影 + `PromptInput` chip，沿 IDE 选区通道路径 | 现状只有整段替换的 `fillText` |
| §60 新建 `AnimationClock` | 已有 `ClockProvider` + `useAnimationFrame`；规则改为「禁止裸定时器」 | `ink/components/ClockContext.tsx` |
| §63 `WorkspacePreferences` 文件 | 用户可配项走设置（`definitions.ts` 单点），不新增 `~/.dsh-tui` 文件 | 设置链 + `verify:settings` |
| §65 `src/tui/workspace/...` 目录 | `src/components/sidePanel/`（布局、Panel 原语、Adapter）+ `src/dsh-adapter/panels.ts`（接缝）+ `src/panels.ts`（shim），不移动现有文件 | 仓库布局与 adapter 边界门禁 |
| 新增 | 选区按整行线性，右栏 V1 `noSelect`；全屏编辑器打开时侧栏收起；`minimalUi` 下状态点去 emoji；PanelBar 走 `chatOverlay.ts` 状态机 | `selection.ts`、`PromptEditor.tsx`、`minimalUiMode.ts`、`chatOverlay.ts` |
