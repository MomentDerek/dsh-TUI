# DSH Agent Teams 支持设计（#1241）

DSH 的实验性 Agent Teams（`@deepseek-ai/dsh-experimental-*` 四个包，`0.2.0-rc.2`）在 TUI 里的适配方案与已确认的事实。只消费上游公开行为：不 import 团队包，投影值本地收窄，开启由上游 bundle 负责。

## 已实测的事实

以下事实来自真实的 `0.2.0-rc.2` 团队服务与工具，模型为脚本化桩；`scripts/verify-agent-teams.ts` 的 fixture 就是这些形态。

- **每个根会话都是隐式 Lead。** 服务挂上后，任何根 Agent 的 `tryMembership` 都返回 `{ role: 'lead', name: 'lead' }`，`agentTeam` 投影在没有任何团队事件时就是 `{ members: [lead], tasks: [] }`。因此「存在团队」= 至少一个 teammate、或有任务、或有 `failure`，而不是成员非空。
- **团队工具装在每个根 Agent 上，与 preset 无关。** `tool-agent-team` 在 `agent/created` 时按成员身份装到 Agent 自己的 `ctx`，所以团队模式是 profile 级的。Agent 作用域会遮蔽祖先层同名工具，所以团队的 `send_message` 等会盖住旧版控件；但 `subagent` / `subagent_fork` 名字不同，会和 `spawn_teammate` 并存。上述遮蔽结论只实测了「根层全局 vs Agent 作用域」，没有实测「preset 常驻作用域 vs Agent 作用域」。
- **teammate 就是 continuable 子代理。** `subagent/start` 的 `id` = 成员 `id` = teammate 的 sessionId；事件本身不带描述，teammate 会话的 `subagent/descriptor.label` 是 `spawn_teammate` 的 `description`。teammate 会话头是 `origin: 'subagent'`、`parentSession: <Lead>`、`delegationDepth: 1`。
- **团队消息的形态。** 落在目标会话中，是一条 `user/message`，`source = { kind: 'team-message', teamId, messageId, senderId, senderName }`；`content[0]` 恰为 `Team message <messageId> from <senderName>:`，后面跟发送者的原始内容块。实录的方向是 teammate→Lead；Lead→teammate 走宿主专用的 Steer 路径，未实录，按同一 `TeamMessageSource` 类型假定形态相同。Lead 另外会收到 `subagent-settled` 通知（已有的注入上下文，不显示）。
- **团队服务经 `ctx.root` 注册投影。** `TeamService` 调 `ctx.root.sessionProjections.register`，在 dsh-tui 宿主的 root 守卫下会被拒（`root.effect is unavailable from a plugin activation`），团队服务与工具都不激活。`host-access.ts` 把这一调用改经调用方自己的上下文发出，注册随调用方 fiber 卸载，root 本身仍然关闭（`verify-plugin-lifecycle.ts` 覆盖）。上面的实测没有经过这道守卫。
- **状态语义不同。** teammate 回合结束时 `subagent/end stopReason: completed`，但名单里 `phase` 仍是 `active`，上游合成的状态是 `inactive`（发消息即可唤醒）。

## 第一阶段（本 PR）

- **开启**：用户把 `@deepseek-ai/dsh-experimental-agent-team-profile` 加进 TUI profile。`registerBundledPresets`（`src/dsh-adapter/bundled-presets.ts`）检测到启用中的 `@deepseek-ai/dsh-experimental-tool-agent-team` 行后，在它注册的每个 preset 里禁用 `tool-subagent`、`tool-subagent-fork`、`tool-subagent-control`、`tool-subagent-list-agents`；官方 preset 改定义里的嵌套行，liangshen 用 include 的 `patches`。不改 `cordis.patch.yml`，也不新增依赖。
- **投影**：`src/dsh-adapter/session-projection-store.ts` 是「单 key + 本地收窄 + 绑定时 seed + 只留当前会话」的小工厂；`team-roster.ts` 是它的第一个使用者，teammate 会话经 `parentSession` 读 Lead 的值。经 channel 的 `team` getter 暴露，UI 只依赖端口类型 `TeamView`。
- **消息气泡**：translate 按身份剔除前缀块，映射到中立来源 `team-message`（带 `sender`）；投影器产出 `label: 'team-message'` 的 user 行，不计入回退目标和最近提问；`TeamMessageBubble` 渲染。teammate 收到的消息落在它自己的会话里：子代理 transcript 读取（`subagent-transcript.ts`）只额外保留 `team-message` 来源的 user 事件，共享 fold 产出 `team-message` 叶子，Detail 与 Agent View 两处用同一气泡渲染（`verify-dsh-child-transcript.ts` T11–T12）。实时一侧：子代理 store 把它记为 `team-message` 输出行（带 `sender` 与消息 id，卡片尾行写成 `✉ <发送者>: …`），合并时与历史页按 id 去重；剥前缀由 `team-tools.ts` 的 `teamMessageOf` 统一完成（`verify-agent-teams.ts`）。
- **工具卡片**：`spawn_teammate` 并入子代理行；其余工具在上游没有 presenter 时由 `team-tools.ts` 给出单行卡片。三个与旧版控件同名的工具，调用按参数区分（团队用 `target`，旧版用 `agent_id`），结果按记录形态区分。

## 第二阶段

- **统一 agent 视图（已完成）**：Ctrl+A 仪表盘与 agents 侧栏收到 `channel.team` 时进入团队模式（`SubagentDashboard` 的 `team` prop）。合并在纯模块 `src/components/teamRoster.ts`：子代理行的 `agentId` 就是 `subagent/start` 的 id，也就是成员 `id`，按它连接；不是成员的子代理行（workflow / ralph）列在「其他子代理」下，原样渲染。teammate 卡片沿用 `SubagentCard`，成员名代替 description，团队状态代替 continuable 标记。状态合成规则如下：`phase: 'failed'` 优先（附 `error`）；`provisioning` 显示准备中；`active` 时子代理行 running/starting 才算运行中，跑完、失败或还没有行都是空闲（发消息即可唤醒），不显示成已完成；上一轮失败时卡片下补一行错误（侧栏 badge 也算这一行）。只在名单里、还没有子代理行的成员显示为单行，能聚焦但不能进详情或 Agent View。任务板只读：状态、subject、`ownerName`（窄宽度省略）、阻塞（pending 且未 `ready`）、写入范围警告数。`failure` 显示为错误横幅。侧栏 badge 把 `phase: 'failed'` 的成员计入未读错误。`verify-team-dashboard.tsx` 覆盖合并、两种形态、窄宽度与宽字符成员名。
- **状态栏摘要**：`team 2/3 running · tasks 3/7`，按宽度逐级降级。
- **进入 teammate 会话**：先进只读详情，再「进入会话」（Lead 留在后台）。agent-view、session-tree 和心跳都按 `origin === 'subagent'` 排除了 teammate，需要为团队成员开例外。teammate 的首条消息以 `source: user` 落盘，内含 `<system-reminder>You are teammate …</system-reminder>` 前缀块，渲染时需要剥掉，否则会显示成人类气泡。

## 已知限制

- bundle 的启用/停用在下次启动时生效：preset 只在注册时调整。
- 只支持 `0.2.0-rc.2`，安装命令必须钉版本：npm 的 `latest` 是 `0.1.5-alpha.2`（团队投影没有 `wire` 视图，`channel.team` 读不到）；`0.2.1-rc.1` 起团队消息改为 `source: { kind: 'agent-message', form: 'relay' }`、前缀改为 `Team message from <name>:`，`teamMessageOf` 不匹配，气泡不显示。跟进 0.2.1 时与版本线一起改。
- preset 按 profile 行判断，不看团队服务是否真正激活：服务激活失败时旧版 `subagent` 行已被禁用、`spawn_teammate` 又不存在，模型只剩 workflow。
  同样只在 preset 注册时扫一次 loader：团队行写进 `group: true` 的组里、或启动后才挂上时会漏判，TUI preset 保留旧版委派行。
- 仪表盘的团队模式不区分「Lead 视角」与「teammate 视角」：第一阶段 teammate 会话不作为 channel 会话打开，所以只有 Lead 会看到它；「进入 teammate 会话」时要一起处理。
- 任务板显示全部非删除任务，不分页；任务很多时靠仪表盘的滚动。
- 子代理详情里的发消息走 `ctx.subagents.prompt`（宿主控制面，teammate 也是 Lead 的 continuable 子代理），不经团队邮箱；团队模式下这条路径没有实测。
- `team_task_list` 卡片只显示当前页，不提示上游的 `nextCursor`（超过 50 个任务时看起来像全部）。
- `/export` 只导出人类输入：团队消息不在导出的 .md 里，由它引发的回复缺少因由。
- `channel.team` 在 teammate 会话里按 header 的 `parentSession` 读 Lead：Lead 已不在 `agents.list()` 时读不到；Lead 名下的普通子代理也会读到团队。第一阶段没有界面读它，第二阶段「进入 teammate 会话」前要改为按成员名单判定。
- profile 自己声明的 preset（`dsh-agent-preset` 行）TUI 不接管，其中的旧版控件仍然存在；Agent 作用域对 preset 作用域的遮蔽没有实测。
- 旧的目录式 preset 名单（`ensurePackagedPresets`）不调整。
- 上游限制：teammate 共用工作目录、团队只在单进程内、任务负责人不会自动释放。
