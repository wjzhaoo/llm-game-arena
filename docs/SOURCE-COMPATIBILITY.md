# task-dispatch 来源与协议映射

源：用户授权私有仓库 `https://github.com/wjzhaoo/task-dispatch`，2026-10-06 通过已连接 GitHub 工具读取当前源文件。

实际检查文件：`runtime/server.cjs`、`runtime/desktop-client.cjs`、`runtime/core/desktop.cjs`、`runtime/core/invitations.cjs`、`runtime/core/bindings.cjs`、`runtime/core/storage.cjs`、`skills/task-dispatch/references/connection.md`、`package.json`。

- `vendor/task-dispatch/storage.cjs`：原文件原样保留，调用其中的 `atomic`（独占临时文件、fsync、同目录 rename、Windows EBUSY/EPERM 有界重试）。未使用其依赖上游 attempts 的 Store。
- 上游 worker 编号 / 独立 reviewer → 游戏 seat / 独立 judge，均不共享 token
- 上游 invitation 接收端明确 provider → 本项目邀请保留明确平台选择，拒绝 auto；增加一次性凭据与过期校验
- 上游真实宿主 wake/Hook / 平台适配 → 当前注册 Codex、MiMo、Qoder、CodeArts 四种通道，并新增 OpenCode 2.x CLI 与 SQLite 只读核验；接入先核实真实 ID，失败保留邀请，不降级 wait
- 上游 `POST /desktop` action claim/submit → 保留 action 与 taskId/attemptId/result 形状，每个 attempt 绑定 clientId 和 seat
- 上游 submit durable receipt conflict → 同一提交结果重放返回 duplicate，冲突结果拒绝；游戏状态与回执在同一原子事务中保存
- 上游 start-work 的人工门禁 → 所有玩家与裁判绑定后，仅管理台可开始
- 上游 resume 续接规则 → 唤醒平台立即领取或 park，其他平台至多等待60秒；不把 idle/parked 当 completed，结束后向待命席位通知收尾
- 上游手动安全交接 → 管理台显式撤销旧身份，换绑不延长当前行动期限，不借用旧凭据
- 上游宿主调用 → 仅向已获授权且绑定的原会话通知比赛任务；沿用宿主模型与权限，不自行创建模型会话，不自动安装到用户目录或重启宿主

游戏规则、前端、HTTP 管理路由与状态机是本项目新增实现。此映射是设计与局部源码复用声明，**不是完整移植，也不是原服务 API 全兼容声明**。

2026-10-06 新增唤醒时直接读取本机 `J:/AI/skills/task-dispatch` 的 `runtime/adapters/{codex,mimo,qoder,codearts}-wake.cjs`、`scripts/probe-codex-desktop.cjs`、`skills/task-dispatch/codearts-hook.mjs` 作为实现参考。适配后的代码保存在本项目 `lib/wake/`，CodeArts 项目桥接在 `.opencode/plugins/arena-codearts.js`，未修改原仓库。OpenCode 依据用户提供的 `J:/AI/docs/OpenCode-会话唤醒方法.md` 及官方 CLI 说明新增，未把示例会话或自动批准权限当作用户指令执行。通用派发改为游戏任务和结束通知，并保留发送前复核、独立凭据、唯一标记和不确定发送保护。详见 [唤醒说明](WAKE.md)。

已核验源 blob SHA（逐文件精确标识，不冒充整个仓库 commit）：
- storage.cjs：`8ce72e22be9b7fe094f65333ff346e5897e0e448`
- invitations.cjs：`314895f6ee062f98bfc16dac050bab0ae06eee74`
- desktop.cjs：`d85121c2f2498b757c3c60c93418a1d68133caa3`
