# task-dispatch 来源与协议映射

源：用户授权私有仓库 `https://github.com/wjzhaoo/task-dispatch`，2026-10-06 通过已连接 GitHub 工具读取当前源文件。

实际检查文件：`runtime/server.cjs`、`runtime/desktop-client.cjs`、`runtime/core/desktop.cjs`、`runtime/core/invitations.cjs`、`runtime/core/bindings.cjs`、`runtime/core/storage.cjs`、`skills/task-dispatch/references/connection.md`、`package.json`。

- `vendor/task-dispatch/storage.cjs`：原文件原样保留，调用其中的 `atomic`（独占临时文件、fsync、同目录 rename、Windows EBUSY/EPERM 有界重试）。未使用其依赖上游 attempts 的 Store。
- 上游 worker 编号 / 独立 reviewer → 游戏 seat / 独立 judge，均不共享 token
- 上游 invitation 接收端明确 provider → 本项目邀请保留明确平台选择，拒绝 auto；增加一次性凭据与过期校验
- 上游真实宿主 wake/Hook / 平台适配 → 当前只提供显式 wait-only；不假装完成宿主验证或自动唤醒
- 上游 `POST /desktop` action claim/submit → 保留 action 与 taskId/attemptId/result 形状，每个 attempt 绑定 clientId 和 seat
- 上游 submit durable receipt conflict → 同一提交结果重放返回 duplicate，冲突结果拒绝；游戏状态与回执在同一原子事务中保存
- 上游 start-work 的人工门禁 → 所有玩家与裁判绑定后，仅管理台可开始
- 上游 resume 续接规则 → 客户端至多等待60秒，不把 idle 当 completed，明确下一步
- 上游手动安全交接 → 管理台显式撤销旧身份，换绑不延长当前行动期限，不借用旧凭据
- 上游自动模型进程/真实 API → 完全未继承；本项目零模型调用

游戏规则、前端、HTTP 管理路由与状态机是本项目新增实现。此映射是设计与局部源码复用声明，**不是完整移植，也不是原服务 API 全兼容声明**。

已核验源 blob SHA（逐文件精确标识，不冒充整个仓库 commit）：
- storage.cjs：`8ce72e22be9b7fe094f65333ff346e5897e0e448`
- invitations.cjs：`314895f6ee062f98bfc16dac050bab0ae06eee74`
- desktop.cjs：`d85121c2f2498b757c3c60c93418a1d68133caa3`
