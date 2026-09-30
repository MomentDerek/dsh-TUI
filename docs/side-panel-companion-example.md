# Companion（宠物）Panel：侧栏 Panel 系统的示例设计

- 日期：2026-09-30
- 状态：Draft · **示例**。本文演示一个非列表型、带动画与图片的 Panel 如何落到
  [侧栏分栏布局与 Panel 系统技术设计](side-panel-design.md) 的架构上；它不是
  主架构的组成部分，主文档任何决定都不依赖本文。
- 前置阅读：主文档 §6（Panel 系统）、§16.4（Companion 不需要事件总线）、
  §18（插件渲染面与 API）。

---


## 1 目标与非目标

目标：把今天散落在开屏 splash 里的鲸鱼 / 女仆形象、idle 动画、点击爱心、求
star 彩蛋收成一个**可选、可换皮、可被插件扩展、跟随会话状态的伙伴系统**，主
形态是侧栏 `companion` Panel，次形态是开屏 splash（保持现状）与 1~3 行 compact。

非目标：不做养成 / 数值系统、不写入会话日志、不新增网络请求、不为宠物再造
图片管线、不在 `minimalUi` 下出现。

## 2 三层：心情 → 姿态 → 皮肤

```text
会话投影（只读）                纯函数                 皮肤无关词汇            具体渲染
working / spinnerMode  ─┐
workingActivity          ├─▶ resolveCompanionMood ─▶ CompanionMood ─▶ planPose ─▶ CompanionPose ─▶ Skin.render
approval / question      │        (inputs, now)                      (state, mood, now)              │
subagents / jobs / goal  │                                                                            ├─ whale（层叠像素，现有 whaleIdle 规划器）
lastInputAt / celebration┘                                                                            ├─ whale-girl（30×30 半块像素）
                                                                                                      ├─ maid-portrait（<Image transparent>，回退到 whale-girl）
                                                                                                      └─ 插件皮肤（纯数据帧表，§6）
```

**心情（mood）** 是会话层语义，所有皮肤共享：

```ts
export type CompanionMood =
  | 'sleeping'      // 空闲超过 sleepAfter 且无未读事项
  | 'idle'          // 空闲
  | 'waiting'       // 请求已发、首 token 未到（activity.phase==='waiting' / spinnerMode==='requesting'）
  | 'thinking'      // 推理中
  | 'working'       // 工具运行中（activity.phase==='tool'）
  | 'responding'    // 正文流式中
  | 'attention'     // 有待处理的审批 / 问卷 / 子代理等待输入 / 失败的后台任务未读
  | 'celebrate'     // 回合完成（phase==='done' 短暂）/ goal 完成 / star / 节日彩蛋
  | 'error'         // 最近一回合以错误结束

export interface CompanionMoodInputs {
  readonly working: boolean
  readonly spinnerMode: SpinnerMode                     // channel-display.ts
  readonly activity: ActivityView | undefined           // activity-store.ts（可缺，插件未装时）
  readonly attention: { approvals: number; questions: number; subagentsWaiting: number; jobsFailedUnread: number }
  readonly goalPhase: 'none' | 'active' | 'complete'
  readonly lastTurnError: boolean
  readonly lastInputAt: number
  readonly celebration: { kind: 'star' | 'holiday' | 'turn-done' | 'goal-done'; until: number } | undefined
  readonly sleepAfterMs: number
}

export function resolveCompanionMood(input: CompanionMoodInputs, now: number): { mood: CompanionMood; since: number; bubble?: string }
```

优先级：`attention` > `error` > `celebrate` > 工作态（waiting / thinking / working /
responding）> `sleeping` > `idle`。`bubble` 取 `activity.phrase ?? activity.label+detail`
（已是 zh/en 双语），截到皮肤给的气泡宽度；不再自造文案。

**姿态（pose）** 是皮肤无关的动画词汇，由现有分层规划器泛化而来：

```ts
export interface CompanionPose {
  readonly mood: CompanionMood
  readonly tick: number            // 0.. 单调递增，皮肤按自己的帧率取模
  readonly blink: boolean
  readonly gesture: 'none' | 'wag' | 'flutter' | 'spout' | 'nod' | 'wave'   // 皮肤可只支持子集，未支持退化为 none
  readonly heart: 0 | 1 | 2 | 3    // 点击爱心 pass（现有 HEART_SEQUENCE）
  readonly sleepZ: 0 | 1 | 2 | 3 | 4 | 5
  readonly facing: 'left' | 'right'
}
```

`whaleIdle.ts` 的 `WhaleIdleState` / `nextWhaleIdleStep` 保持不动，`planPose` 是它
的薄包装：把 mood 映射到今天的 `working: boolean` 输入（waiting/thinking/working/
responding → working=true），把 `WhaleLayerPose` 的 tail/fin/spout 映射到 `gesture`。
开屏 splash 的 `LogoV2` 继续直接消费 `WhaleLayerPose`，不受影响。

## 3 皮肤接口

```ts
export interface CompanionSkin {
  readonly id: string                                   // 'whale' | 'whale-girl' | 'maid-portrait' | 'plugin:xxx'
  readonly title: string                                // i18n key（内置）或字面量（插件）
  readonly cells: { readonly columns: number; readonly rows: number }   // 固定占位，永不随帧变化
  readonly bubble?: { readonly maxColumns: number; readonly placement: 'above' | 'right' }
  readonly graphics: 'none' | 'optional' | 'required'   // required 且无图片协议时该皮肤不可选
  readonly supports: ReadonlySet<CompanionPose['gesture']>
  render(pose: CompanionPose, ctx: SkinRenderContext): React.ReactNode
}

interface SkinRenderContext {
  readonly image: TerminalImageSource | undefined       // 已解码 RGBA（仅 graphics != none 且已就绪）
  readonly theme: Theme                                 // 语义色
  readonly minimal: boolean
}
```

内置三皮肤：

| 皮肤 | 占位 | 数据 | 说明 |
| --- | --- | --- | --- |
| `whale` | 13×40 | `whaleFrames.ts` + `whaleLayers.ts` 层叠合成 | `WhaleArt pose=…`，与开屏共用 `LAYERED_CACHE` |
| `whale-girl` | 15×30 | `whaleGirlSprite.ts` 半块像素 | `WhaleGirlArt`；`heart>0` 时用 `WhaleGirlHappyArt` 的心形行 |
| `maid-portrait` | 按格子像素比等比拟合到 ≤ 30 列 | `assets/whale-girl` 两张立绘（`useMaidPortraits`） | `<Image transparent>`；`mood` 切 normal / happy 立绘；无图片协议时自动回退 `whale-girl` |

## 4 Companion Panel 组件

```text
┌ [ ♥ Companion ] ─────────────┐
│                              │
│        （皮肤 13×40）          │
│                              │
│  ⏵ 正在读取 package.json      │  ← bubble（activity.phrase / line，1~2 行）
│  Working 8.2s · 3 tools      │  ← 从 phaseStartedAt / toolCount 派生，本地计时
│                              │
│  click: ♥   Enter: poke      │  ← PanelHint 行由宿主渲染
└──────────────────────────────┘
```

- 布局：皮肤居中，`cells` 固定；宽度不足 `cells.columns + 2` 时切到 compact
  皮肤（`whale` 的 `RENDERED[STANDARD]` 裁到 7 行；插件皮肤必须提供 `small` 帧表）。
- 时钟：`useAnimationFrame(visible && !sleeping ? 120 : sleeping ? 1000 : null)`；
  `visible=false`（非 active Panel / 侧栏收起）**零定时器**；终端失焦时
  `ClockProvider` 自动降频。
- 交互：点击 → 爱心 pass（现有语义）；`Enter`（焦点在右栏）→ poke：气泡显示完整
  `activity.line` 3 秒；`s` → Send to Chat 当前活动摘要（复用 §6.7）；双击不定义。
- 睡眠：`sleepAfterMs` 默认 60s（开屏 splash 保持 10s 的 `SLEEP_DELAY_MS`，
  Panel 常驻，10s 会频繁入睡）；有 `attention` 时不入睡。
- compact（1~3 行）：`[♥] 思考中 12s ▂▃▅` —— 首格 mood 图标（主题色）+ 活动
  短句 + 现有 spinner 帧；不画皮肤。
- `minimalUi`：Panel 不可启用（选择器灰掉并提示）。

## 5 与现有开屏 splash 的关系

| | 开屏 splash（`LogoHeader`） | Companion Panel |
| --- | --- | --- |
| 位置 | 转录顶部，随转录滚走 | 侧栏，常驻 |
| 设置 | `dsh-tui.whale` / `whaleIdle` / `whaleGirl` / `splashFont`（不变） | `dsh-tui.companion.*`（§7） |
| 规划器 | `whaleIdle.ts`（直接） | 同一个，经 `planPose` |
| 帧表 / 立绘 | `whaleFrames` / `whaleGirlSprite` / `assets/whale-girl` | 同一份，同一缓存 |
| 求 star / 节日彩蛋 | `splashEggs.ts` 改文字，`StarPrompt` | 作为 `celebration` 输入触发 `celebrate` mood；不改 splash 逻辑 |

两者同时存在时不冲突：splash 只在空会话或滚到顶部时可见（`whaleArtVisible` 门
控 `scrollTop < 16`），Panel 在会话进行中承担「一直看得见」的角色。

## 6 插件皮肤：纯数据，不执行代码

插件不提供 `render` 函数，只提供帧表；宿主用内置 `SpriteSkin` 渲染。与主题
（`tuiThemes`）同一信任模型：descriptor 视为不可信输入，全有或全无校验。

```ts
export interface TuiCompanionSkinDescriptor {
  readonly id: string                           // plugin:sub 命名空间
  readonly title: string
  readonly cells: { columns: number; rows: number }          // ≤ 40×20
  readonly small?: { columns: number; rows: number }         // ≤ 30×7，窄栏用
  readonly palette: Record<string, [number, number, number] | null>   // 单字符 → RGB / 透明
  readonly frames: Record<string, readonly string[]>          // 帧名 → cells.rows 行，每行 cells.columns 个 palette 字符
  readonly moods: Partial<Record<CompanionMood, readonly string[]>>    // mood → 帧名循环；缺省回落到 'idle'
  readonly overlays?: { heart?: readonly string[]; sleep?: readonly string[]; blink?: string }   // 叠加帧（与 whaleLayers 同语义）
  readonly image?: { rgba: Uint8Array; width: number; height: number; moods?: Partial<Record<CompanionMood, 'rgba'>> }  // 可选立绘，走 <Image>，受 1024px / 4 MiB 预算
}
```

校验：字符全在 palette、每帧尺寸一致、`moods` 引用的帧存在、总字节 ≤ 256 KiB、
图片受现有插件图片预算；任一失败整份拒绝并 toast 一次。注册经
`ctx.tuiPanels.companion.registerSkin(descriptor)`（主文档 §18.2），释放即回落到默认
皮肤。放 Phase 7。

## 7 设置

| key | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `dsh-tui.companion.skin` | select | `inherit` | `inherit`（跟随 `whaleGirl`：开 → `maid-portrait`，否则 `whale`）/ `whale` / `whale-girl` / `maid-portrait` / 插件 id |
| `dsh-tui.companion.bubble` | boolean | `true` | 是否显示活动气泡 |
| `dsh-tui.companion.sleepAfter` | number（秒） | `60` | 入睡延迟；`0` 不入睡 |
| `dsh-tui.companion.celebrations` | boolean | `true` | 回合完成 / goal 完成 / 节日的 `celebrate` mood |

是否启用 Companion 本身 = `dsh-tui.sidePanel.panels` 里是否有 `companion`（主文档 §10），
不另设开关。

## 8 验证

- `verify-companion-mood.ts`（纯函数）：优先级表逐格；`attention` 阻止入睡；
  `celebration.until` 到期回落；`activity` 缺失（插件未装）时只靠 `working` /
  `spinnerMode` 也能给出 waiting / thinking / responding。
- `verify-companion-pose.ts`：`planPose` 与 `nextWhaleIdleStep` 帧级一致（沿
  `verify-whale-idle.mjs` 的 parity 写法）。
- `verify-companion-panel.tsx`：三皮肤在 40 / 30 / 28 列侧栏下的占位不变；
  `visible=false` 时无定时器（`ClockProvider` 订阅数为 0）；连续 50 帧左栏零 diff；
  无图片协议时 `maid-portrait` 回退 `whale-girl`。
- `verify-companion-skin-descriptor.ts`：坏 palette / 尺寸不一 / 超预算 / 引用缺帧
  逐一被拒。
