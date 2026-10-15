# dsh-TUI 适配 DSH Auto review 权限预设：评估与 issue 草案

- 日期：2026-10-13
- 状态：设计稿 + issue 正文草案，未实现
- 关联：`ccch1mneyyy/dsh-TUI`（issue 待开）
- 上游：`@deepseek-ai/dsh-experimental-auto-review@0.2.0-rc.2`、`@deepseek-ai/dsh-permission-presets@0.2.0-rc.2`
- 范围：`src/dsh-adapter/channel/`（`mode-roster.ts`、`permissions.ts`、`mode-permission-actions.ts`、`command-completions.ts`）、`src/components/PermissionsPicker.tsx`、`src/dsh-adapter/approvals.ts`

---

## 0. 背景

DSH 随 0.2.0-rc.2 发布实验性插件 `@deepseek-ai/dsh-experimental-auto-review`
（插件列表标题「自动授权审查」）。它不是一个独立的审批策略，而是把
`sandbox=danger-full-access` + `approval=ask` 捆成一个**当前会话专属**的命名权限
预设 `auto`，由当前模型在每次工具调用前做一次授权审查。

上游 606 条 issue（截至核实日）中没有任何一条跟踪「Auto review 权限预设」的 TUI
适配，本文即为此缺口撰写的评估与 issue 草案。

## 1. 上游行为（已逐条核实）

- 承载方：`@deepseek-ai/dsh-permission-presets`。`custom`（派生的非预设态）与
  `auto` 是保留名，写进配置表会抛错（`lib/index.js:175-176`）。
- 固定 bundle：`AUTO_PRESET_SPEC = { sandbox: 'danger-full-access', approval: 'ask' }`
  （`lib/index.js:58`）。`ask` 把审查拒绝路由给用户；`never` 下拒绝即终局
  （in-process 子代理钉 `never`）。
- 可见性：`get names(): readonly string[]` = 配置项按声明序 + Auto（integration
  live 时，`lib/index.js:239`）；`optionOf(name)` 支持「已配置项 / live `auto` /
  `custom`」；`resolve(name)` 返回其 knob bundle。
- 变更通知：`permission-presets/catalog-changed(): void`，payload-free，消费者先
  订阅再重读完整 catalog（`lib/typert.host.js:660-662`）。
- 注册 API：`registerAuto(admit: () => void): () => Promise<void>`——重复注册抛
  `permission: preset "auto" is already registered`，返回的 disposer 移除 Auto。
- 审查范围：每个 native 调用 + 每个已启动的 PTC `tools.*` inner call 在执行 body
  前审一次；外层 `run_code` 传输刻意排除。
- 风险分级：low（项目本地普通工作、本会话创建对象的精确清理）→允许；medium
  （不可逆删除既有对象、生产操作、外部写入、安全变更）→需当前人类或直接父级明确
  授权；high（跨信任边界敏感外泄）→永远拒绝；模糊/效果冲突→拒绝。审查失败或畸形
  响应 fail-closed，绝不执行。
- 入口与默认：composer 或 `/permission` picker 中带 `EXP` 上标的 `Auto review`，
  需确认当前会话风险对话框；`/permission auto` 直接切；General settings 与
  未来会话默认不提供 Auto，Auto 不能成为 default。
- 拒绝呈现：走普通工具卡，折叠行标识 Auto review，展开显示「body 未执行」+ 可选
  reason（durable structured error detail，不进主模型内容）。reason 呈现由 Web 的
  `client/ui-tool` 拥有。
- 代价：每次调用额外一次模型请求（无缓存/重试/截断）；Auto 无文件沙箱。
- 卸载：把 live Auto Session 迁到 Full access。

## 2. TUI 现状与适配缺口

基础可用性大概率已经通：Shift+Tab roster 与 `/permission` 走
`readRuntimePermissionSnapshot`（`src/dsh-adapter/channel/mode-roster.ts`）→
`permissionPresetSnapshotFromService`（`src/dsh-adapter/channel/permissions.ts`），
后者用 registry `names` + `optionOf` + `current` 组 roster，只把 `custom` 判为
不可用，因此 `auto` 会自然出现在列表里。真正的缺口：

| # | 缺口 | 定位 |
| --- | --- | --- |
| A | 未订阅 `permission-presets/catalog-changed`，Auto 的 live 注册/移除不会即时刷新 | 全仓 `src/` 无该串 |
| B | 非内置条目没有本地化，回退到 `option.name`/裸 key，zh 下显示不出「自动授权审查」 | `src/components/PermissionsPicker.tsx`、`src/dsh-adapter/channel/command-completions.ts`（只映射三个内置值） |
| C | 选择 Auto 前无风险提示、无 `EXP` 标记 | `src/components/PermissionsPicker.tsx` |
| D | `persistPermissionPref` 只跳过 `undefined`/`custom`，会把 `auto` 记成下一会话偏好 | `src/dsh-adapter/channel/mode-permission-actions.ts:151-154` |
| E | Auto 的工具卡最终拒绝（`body 未执行` + reason）是否在当前工具卡渲染路径呈现，待核对 | `src/channel/projection.ts`、`src/dsh-adapter/approvals.ts:47` |

## 3. Issue 正文草案

```markdown
[功能] 适配 DSH Auto review 权限预设（@deepseek-ai/dsh-experimental-auto-review）

## 背景

DSH 随 0.2.0-rc.2 发布实验性插件 `@deepseek-ai/dsh-experimental-auto-review`
（locale 标题「自动授权审查」）。它由 `dsh-permission-presets` 承载，把
`sandbox=danger-full-access` + `approval=ask`（`AUTO_PRESET_SPEC`）捆成一个
**当前会话专属**的命名权限预设 `auto`：每个 native 调用和每个已启动的 PTC
`tools.*` inner call 在执行 body 前由当前模型审一次（外层 `run_code` 传输刻意
排除）。风险分级 low→允许 / medium→需当前人类或直接父级明确授权 / high→永远
拒绝，模糊或效果冲突→拒绝。选 Auto 会把 approval policy 设为 `ask`，被拒调用
问用户；in-process 子代理钉 `never`（拒绝终局）。插件随 dsh 安装但默认关闭，
需从 Web Plugins 页开启或显式 `dsh plugin --profile web add`。

TUI 目前能读到 registry 的 roster（Auto 会出现在 Shift+Tab / `/permission`），
但对 Auto 的实时变更、本地化、风险确认与拒绝呈现均未适配。

## 现状（代码定位）

- roster 读取：`src/dsh-adapter/channel/mode-roster.ts` 的
  `readRuntimePermissionSnapshot`（仅 `availability==='runtime'` 返回）→
  `src/dsh-adapter/channel/permissions.ts` 的
  `permissionPresetSnapshotFromService`（用 registry `names` + `optionOf` +
  `current`，仅把 `custom` 判为不可用，`auto` 会通过）。
- 切换/记忆：`src/dsh-adapter/channel/mode-permission-actions.ts`
  （`runPermissionPreset`、`persistPermissionPref`、`compositionDefaultPreset`）。
- 呈现：`src/components/PermissionsPicker.tsx`、
  `src/dsh-adapter/channel/command-completions.ts`。
- 审批面板：`src/dsh-adapter/approvals.ts`（`ApprovalSnapshot.reason`）。
- 全仓无 `permission-presets/catalog-changed` 订阅。

## 目标

- 订阅 `permission-presets/catalog-changed`（payload-free；先订阅后重读
  catalog），收到即重建 roster，让 Auto 的 live 注册/移除在 Shift+Tab、
  `/permission` 与补全里即时反映。
- 为 roster 中非内置条目（`auto` 等）正确本地化：从 registry `optionOf` 元数据
  取标题/描述，避免回退到裸 key；zh 下显示「自动授权审查」。
- 选择 Auto 前给出当前会话风险提示并标注实验性（对齐 Web 的 `EXP` 上标 + 风险
  对话框），避免用户在不知情下启用「模型自动放行 Full access」。
- 核对并修正 `persistPermissionPref`：Auto 是 current-session-only、不进新会话
  默认，不应被记为下一会话权限偏好。
- 在 TUI 自有的工具卡渲染路径覆盖 Auto 的最终拒绝：折叠行标识 Auto review，
  展开显示 body 未执行 + 可选 reason（structured error detail，不进主模型内容）。
- 双语文档同步。

## 非目标

- 不改 DSH 内核、`dsh-experimental-auto-review`、`dsh-permission-presets` 或审批
  通道；不实现审查策略本身。
- 不改阻塞/其它权限预设（read-only / workspace-write / danger-full-access）的既有
  行为。
- 不把 Auto 加进 General settings 或新会话默认（其契约明确禁止）。

## 验收

- profile 内 enable/remove Auto layer 后，Shift+Tab、`/permission`、
  `/permission` 补全三者均即时反映，无需重启或切会话。
- zh 界面下 Auto 显示「自动授权审查」及其描述，不退化为英文/裸 key。
- 选择 Auto 出现风险提示；取消则不改动权限。
- 切换到 Auto 后，下一新会话不被记为 Auto（回落到有效默认）。
- Auto 拒绝的工具卡在展开态显示「未执行」+ reason。
- 默认关闭时，TUI 行为与现状完全一致。

## 参考 / 相关 API（@deepseek-ai/dsh-permission-presets@0.2.0-rc.2）

- `get names(): readonly string[]`、`optionOf(name): PresetOption`、
  `resolve(name): PresetSpec`、`set(session, name): void`、
  `@Remote('catalog') catalog()`、`registerAuto(admit): () => Promise<void>`。
- 事件 `permission-presets/catalog-changed(): void`（payload-free）。
- 保留名 `custom` / `auto`。
- 既有相近项：#864（第三方 preset 接入）、#1212（审批条被裁出屏）。
```

## 4. 事实核查来源

- 插件 tarball：`package.json`（名/版本）、`locale/zh.json`（标题与描述、
  逐字一致）、`cordis.patch.yml`（单行 `id: auto-review`）、
  `lib/types/index.d.ts`（`name`/`inject`/`apply`）、`README.md`。
- 预设服务：`@deepseek-ai/dsh-permission-presets@0.2.0-rc.2` 的
  `lib/index.js`（`AUTO_PRESET_SPEC`、`names` getter、保留名断言、
  `registerAuto`）与 `lib/typert.host.js`（方法签名与 `catalog-changed` emit）。
- TUI 缺口：`src/` 全仓 grep（`catalog-changed` 零命中）与逐个文件逐行核对。
- 上游 issue：606 条标题 + 正文全文 grep「授权审查 / 自动审查 / auto review /
  experimental-auto」零命中。
