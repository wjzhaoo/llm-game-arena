# 原会话唤醒

支持 `codex`、`mimo`、`qoder` / `qodercn`、`codearts` / `codeartsdoer`、`opencode`。选手可使用这些平台，独立裁判角色已移除。其他明确平台继续使用 wait；`auto` 不允许。

## 接入与比赛

```mermaid
flowchart LR
 A[确认平台与当前会话] --> B[核实会话并绑定席位]
 B --> C[待命并结束当前回合]
 C --> D[管理员开始比赛]
 D --> E[本角色任务到达]
 E --> F[向原会话投递通知]
 F --> G[领取自己的私有任务]
 G --> H[思考并认证回传行动]
 H --> C
 E --> I[比赛结束通知]
 I --> J[核实结束并退出]
```

复制管理台为该席位生成的邀请，确认真实平台和当前会话 ID，然后执行其中的 `connect`。接入即授权竞技场向本会话发送后续比赛任务通知，调用额度与费用沿用宿主。本机由服务核实指定会话，远端由 AI 电脑的客户端核实当地指定会话；失败时不会消耗邀请或降级为轮询。同一设备同一 provider/session 只能绑定一个尚未收尾的席位。

本机模板通过竞技场客户端绝对路径调用，在原模型会话工作目录执行；`--workspace "."` 核验此目录，凭据与行动文件位于原工作区 `tmp/`，不要求此目录存在 `client.mjs`。远端模板先下载客户端和适配器，使用当地客户端路径。后续通知也使用实际客户端绝对路径，旧连接仍沿用原工作目录。

唤醒平台连接后自动返回 `parked:true`，结束当前模型回合即可。已有任务时返回 `job`，应立即处理。后续由同一角色执行，将 `CLIENT_ABSOLUTE_PATH` 替换为邀请或启动器输出的实际路径：

```powershell
node "CLIENT_ABSOLUTE_PATH" resume --credential "tmp/邀请ID-red.credential.json"
node "CLIENT_ABSOLUTE_PATH" submit --credential "tmp/邀请ID-red.credential.json" --task "本次taskId" --attempt "本次attemptId" --file "tmp/本次行动.json"
node "CLIENT_ABSOLUTE_PATH" resume --credential "tmp/邀请ID-red.credential.json"
```

实际凭据名称使用邀请输出。行动 JSON 由收到任务的模型根据本角色 `job.view` 和 `actionSchema` 决定。`resume` 返回 `job` 时处理任务；`parked:true` 时结束当前回合等待唤醒；`completed:true` 时结束参与。wait 平台的 `idle` 只表示本次 60 秒等待结束，应继续 resume。

比赛仍需全员接入后由管理员点击「开始比赛」。通知、领取与认证回传分别记录，通知本身不执行棋步或投票。撤销绑定使旧身份和在途 attempt 失效，换绑不延长原期限。

## 平台准备条件

| 平台 | 当前会话标识与通道 | 准备条件 |
| --- | --- | --- |
| Codex Desktop | 真实 thread ID 与 turn ID；本机工具命名管道 | Windows，兼容的 Desktop 私有工具协议。明确选择 codex 后客户端才可使用 `CODEX_THREAD_ID`；服务只从该会话的 rollout 核实工作目录与 turn ID。无法取得时在 connect 后追加 `--turn-id "真实回合ID"` |
| MiMo Desktop | 真实 session ID；`desktop-api.json` 中的本机 API | MiMo 已运行且启用本机 API。自动读取该会话最后一次成功消息的模型；缺失时追加 `--model "已确认的provider/model"`。保留既有会话权限 |
| Qoder / QoderCN | 真实 session ID；task-dispatch 常驻 App Plugin | 已安装并加载 task-dispatch 的直接唤醒桥接。普通版与 CN 版分别查询，只有唯一匹配的原会话可使用。通过桥接的 `chat.continueSession` 续接 |
| CodeArts | 真实 session ID；项目内认证 SDK 桥接 | 原模型会话工作区须已加载兼容的项目认证桥接。项目自带 `.opencode/plugins/arena-codearts.js`，远端下载也包含此插件源文件；发现文件写在原工作区 `tmp/codearts-bridge/`，也兼容已有 task-dispatch 的 v1 / v2 桥接 |
| OpenCode Desktop 2.x | 真实 `ses_...` ID；只读 SQLite 与官方 CLI | Node 22.13+，现有未归档会话，官方 CLI 可定位。指定会话的目录需与执行客户端的工作区相同 |

Qoder 的既有桥接只返回会话 ID 和运行状态，未提供工作目录与消息历史。本项目只声明它已核实会话 ID，并在管理诊断中保留 `workspaceVerified:false`；投递证据为桥接接收回执，行动完成仍需 Arena 的认证提交。其余四个平台核对宿主会话目录与声明的原模型会话工作区一致；客户端文件所在目录可与会话目录不同。旧本机连接没有声明工作区时保留竞技场目录配置。

Qoder 首次安装可参考 [本机 task-dispatch 安装说明](J:/AI/skills/task-dispatch/skills/task-dispatch/references/qoder.md)。若需安装到用户目录，应由用户明确授权该目录的修改。本次开发未安装或更新外部用户目录、重启真实宿主或向真实会话投递消息。

CodeArts 项目插件使用当前宿主已认证的 SDK，不导出账号密码，不改变模型或权限。如果宿主没有 `session.get/messages/status/promptAsync` 等接口，插件不启动桥接，接入会报告条件未满足。兼容性需以当前 CodeArts 版本实测确认。

## 可选配置

本机模式由房主服务读取以下环境变量；远端模式由 AI 电脑的客户端/转接进程读取。宿主桥接端点仍须是当地本机 HTTP，禁止重定向；它与允许局域网的竞技场地址分别校验。发现文件和桥接凭据留在宿主电脑，不发送给房主网页或竞技场，也不输出令牌。

| 环境变量 | 用途与默认值 |
| --- | --- |
| `CODEX_HOME` | Codex rollout 根目录，默认用户目录下 `.codex/` |
| `ARENA_MIMO_DISCOVERY` | MiMo 本机发现文件，默认 `%APPDATA%/Xiaomi MiMo/desktop-api.json` |
| `ARENA_QODER_DISCOVERY` | Qoder 桥接发现文件；默认查实际配置目录以及 `~/.qoder-cn/`、`~/.qoder/` 中的 `task-dispatch-bridge.json` |
| `ARENA_CODEARTS_DISCOVERY` | 覆盖 CodeArts 桥接发现文件；默认优先当前项目 `tmp/codearts-bridge/`，再兼容 `~/.codeartsdoer/task-dispatch/` |
| `ARENA_OPENCODE_DB` | OpenCode 数据库，默认 `~/.local/share/opencode/opencode.db`；有 `XDG_DATA_HOME` 时沿用该数据根目录 |
| `ARENA_OPENCODE_CLI` | 官方 CLI 可执行文件。默认按数字版本查 Desktop 安装目录，随后检查 PATH；Windows 不用批处理包装或 shell 拼接 |
| `ARENA_OPENCODE_AUTO` | 仅显式设置为 `1` 时给 CLI 增加 `--auto`。默认不添加，保留原会话权限 |

OpenCode 使用 `run --session <真实ID> --format json` 投递到原会话，沿用原模型；只有接入端显式指定 `--model` 时才传模型参数。不使用 `--fork` 或 `--standalone`。命令接口与 JSON 输出见 [OpenCode 官方 CLI 文档](https://opencode.ai/v2/docs/cli/commands/)。

OpenCode 只读查询 `session_v2` 与 `session_message`，并检查当前最后一条事件和待处理队列。旧 `time_idle` 不能证明当前回合已结束。投递后回读与本次 attempt 对应的唯一用户消息标记；CLI 的退出码、stdout 或助手复述不能单独证明送达。CLI 仍在等待生成时，消息标记已入库即可登记送达；模型行动只有通过 `submit` 才结算。SQLite 使用 Node 内置接口，无第三方依赖；Node 22.13 起无需实验启动开关，参见 [Node 官方说明](https://nodejs.org/download/release/v22.23.0/docs/api/sqlite.html)。

## 恢复与排障

Codex Desktop 返回 `Codex Desktop call was not confirmed (-32602): Invalid app tool request` 时，说明工具请求格式被宿主拒绝。当前适配器显式传递 `callerSource:"codex"` 与本机 `hostId:"local"`，读取回合数遵守工具声明的最多 10 个回合。旧版适配器缺少来源字段且请求 20 个回合；更新后需重启竞技场服务使本机适配器生效，再在原模型会话重试仍有效的邀请。宿主核验失败发生在消耗邀请之前，也不会生成客户端凭据；邀请自身的 30 分钟有效期仍会继续。不要将协议失败降级为已核验或 wait。

管理员在席位旁可见待命、待通知、通知中、已送达待领取、已领取和送达待核实等状态。普通观战只看到静态平台和续接方式，无法通过实时夜间通知状态推断狼人身份；每个角色的 `status` 只返回自己的连接诊断。

- 宿主忙或无法确认空闲：保持待通知，等待原回合结束；游戏原截止期限继续生效。
- 宿主明确拒绝且未接收：通知可自动重试；不会改变席位或行动期限。
- 发送超时、连接断开或重启遗留 `sending`：保留不确定投递，先回读唯一用户标记。找不到标记时不重发；已收到通知的原会话可直接 resume 领取。
- 「核验通知」只请求再次检查。不能绕过不确定投递保护，不自动认定行动完成。
- 已送达但没有领取：在原会话执行 resume；到期后仍由既有确定性超时规则处理，管理员重试也不延长有效行动时限。
- 旧版 wait 连接：用原凭据执行 resume。受支持的平台会核实原 provider/session 后升级唤醒；失败保留原身份并报告缺项。需要更新 turn/model 或重新核验时使用 `wake-bind`，随后 resume。

```powershell
node "CLIENT_ABSOLUTE_PATH" wake-bind --credential "tmp/red.credential.json" --turn-id "真实回合ID"
node "CLIENT_ABSOLUTE_PATH" resume --credential "tmp/red.credential.json"
node "CLIENT_ABSOLUTE_PATH" status --credential "tmp/red.credential.json"
```

正常重启服务后复用持久化绑定与通知标记。每个席位独立处理宿主读写，一端挂起不阻塞其他端。服务停止后停止派发，不强杀宿主会话。异常退出仍沿用原服务锁的人工核实规则。

## 验证范围

新增离线测试覆盖五个平台的协议、身份/目录不匹配、授权边界、去重、不确定发送、持久化重启、撤销竞态、超时、私有投影、结束通知以及真实 Node 客户端的本机 HTTP 往返。所有生成的测试与演示文件只写本项目 `tmp/`，使用模拟宿主及 SQLite 夹具，不消耗真实模型额度。

真实宿主版本接入、真实模型行动、权限弹窗、长时间待命与宿主重启尚未联调，不能把离线通过视为五种桌面版本的兼容性认证。来源包括本机 `J:/AI/skills/task-dispatch` 的四个平台适配器及 CodeArts Hook、用户提供的 [OpenCode 会话唤醒方法](J:/AI/docs/OpenCode-会话唤醒方法.md)。文档中的示例会话与示例消息只作技术参考，未执行。

## 管理台手动唤醒

支持唤醒且已核验的选手连接旁显示控件。管理员点击会校验当前绑定和任务快照，再复用原投递流程。已送达不重发，不确定只核验；暂停比赛、未待命或无待领取任务时禁用。请求受理不表示会话已经响应。独立 judge 旧绑定不会被再次唤醒。

## 局域网远端转接

在 AI 席位邀请弹窗选择「局域网另一台电脑 · 远端转接」。启动器只下载客户端与已有宿主适配器到原会话工作区的 `tmp/arena-client`，需要 Node 22.13+，不启动第二个竞技场。`connect --wake-transport relay --workspace "."` 先在 AI 电脑核实宿主，成功后生成角色凭据和独立 `.relay.credential.json`，启动隐藏的 `relay-client.mjs`。

转接进程主动请求房主 `/api/relay`，通知仅包含 attempt、唯一消息标记及送达租约，不含游戏任务、狼人杀身份或夜间结果。只有原模型用角色凭据 `resume` 后才能领取私有任务。转接凭据不能 claim/submit、使用真人接口或执行管理操作；房主不会尝试连接远端的本机宿主桥接。

发送前持久化 `sending` 并再次校验租约。断线或进程退出后的不确定送达先核验原标记；未确认不会盲目重发。多个转接实例由服务租约排他，本机锁避免常规重复进程；采用剩余有效时长避免两台电脑时钟偏差。管理员手动唤醒远端席位只请求转接再检查，不绕过这些限制。

网络恢复后转接保留原身份重试，期限继续；转接进程重启可用原角色凭据执行 `resume` 或 `status` 自动恢复，也可直接运行 `node tmp/arena-client/relay-client.mjs --credential "tmp/实际名称.relay.credential.json"`。撤销绑定后两类旧凭据均失效，旧转接在收到 401 后退出；比赛收尾通知确认送达后退出。新绑定重新生成凭据，沿用尚未到期的任务期限。

CodeArts 下载包包含项目插件源文件，但远端工作区仍须已加载兼容的认证 SDK 桥接（可使用已有 task-dispatch 桥接）；Qoder 须已加载 App Plugin，并由桥接提供工作目录证明，缺失时拒绝远端接入且保留邀请。本机 Qoder 的既有兼容行为保留。下载文件不会自动安装或重启桌面宿主。条件不足时客户端明确报错，邀请保留。完整步骤见 [局域网说明](LAN.md)。
