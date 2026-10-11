# 象棋与覆棋：立体棋盘和对局互动

## 网页操作

中国象棋和覆棋均默认二维棋盘。点击「立体棋盘」切换为本地 Three.js r160 绘制的立体棋盘；拖动旋转，滚轮或双指缩放，「视角复位」恢复本人朝下的视角。黑方朝下仅改变展示，坐标仍为 x=0..8、y=0..9。点击棋子和合法落点完成行棋，下方折叠的二维辅助棋盘也支持键盘操作。

展示模式保存在当前页面内存中，切换不改变对局。两秒刷新更新棋子及提示，保留相机视角。离开立体模式或切换房间释放场景资源。WebGL 初始化失败或上下文丢失时恢复二维棋盘，并显示中文提示。棋盘适配日间、夜间主题及减少动画偏好。

当前行动方通过棋盘边缘、选手卡高亮及「轮到红方 / 黑方」「轮到你」共同提示。等待悔棋确认、暂停、结束和历史回放有独立状态。覆棋的立体展示仅接收服务端公开投影，暗子只显示「暗」及覆盖位置的走法提示。

本人操作区可发送好棋、佩服、哈哈、侥幸、想想、这…、完了、不服、快点、承让十种固定表情。每方发送间隔至少 1.5 秒，气泡持续 4 秒，事件同时写入历史。收到表情不会额外唤醒 AI。

## 悔棋与认输

双方都可申请撤回自己的最近一手；若对手已应手，一起撤回两手，回到申请者落子前，由申请者重新行动。对手需明确同意；真人点击「同意悔棋 / 拒绝悔棋」，AI 领取确认任务并提交决定。

同一时间仅有一个请求，同一棋盘版本每方最多申请一次。无本人棋步、未开局、暂停或结束时不可申请；旧存档中没有回退检查点的棋步也不可撤回。覆棋若回退范围包含揭子或吃掉暗子，按钮显示禁用原因，服务端同时拒绝申请。普通明棋步骤可撤回。

请求冻结走棋剩余时间。确认时限使用房间行动时限，确认超时或 AI 连续两次无效确认视为拒绝。拒绝后恢复请求前的走棋剩余时间和错误预算；同意后恢复申请者原棋步提交前的剩余时间及完整规则状态，包括重复局面计数、上一手、活动棋谱、覆棋吃子和静默手数。管理员暂停也冻结确认时限；撤销任一席位取消待确认请求。

认输立即判本人负，并取消走棋和悔棋任务。真人操作有确认弹窗；AI 可自主使用认输命令。结束结果写入历史，待命 AI 收到既有的结束通知。

## AI 命令及协议

使用本人凭据；客户端路径、凭据名称沿用邀请输出。`status` 和领取到的棋类 `job.interactions` 提供当前 `boardRevision`、悔棋可用性及原因、固定表情枚举、冷却时间和命令说明。

```sh
node "CLIENT_ABSOLUTE_PATH" emote --credential tmp/red.credential.json --emote good
node "CLIENT_ABSOLUTE_PATH" undo-request --credential tmp/red.credential.json --revision 7
node "CLIENT_ABSOLUTE_PATH" resign --credential tmp/red.credential.json
```

`--revision` 必须采用最近状态返回的版本。普通行棋任务为 `kind: "move"`，继续兼容 `{ "from": [0,6], "to": [0,5] }`。悔棋确认任务为 `kind: "undo-response"`，由对手沿用原领取、提交和本机 / 远端唤醒流程处理：

```json
{"type":"undo-response","requestId":"领取结果中的 requestId","accept":true}
```

使用原 `submit --task TASK_ID --attempt ATTEMPT_ID --file tmp/response.json` 命令提交，`accept: false` 表示拒绝。提交后继续 `resume`。发起悔棋及处理结束时会换发任务身份，原任务失效；收到旧通知后先 `resume`，以新领取结果决定行动。已保存的成功回执仍支持相同载荷的幂等重试。

| 接口 | 本人操作 |
| --- | --- |
| `POST /api/player` | 真人 `emote`、`undo-request`、`resign`，原 `submit` 处理确认任务 |
| `POST /desktop` | AI 相同操作，原 `claim / resume / submit` 继续兼容 |
| `action: "emote"` | `{ "action": "emote", "emote": "good" }`；仅接受固定枚举 |
| `action: "undo-request"` | `{ "action": "undo-request", "boardRevision": 7 }` |
| `action: "resign"` | `{ "action": "resign" }` |

公共对局增加 `boardRevision`、`undoRequest` 和带唯一 ID 的表情事件。本人状态增加 `interactions`。公开请求只包含 ID、双方、撤回手数及截止时间；私有回退检查点、冻结预算、暗子身份和规则内部计数不进入公共投影。

## 历史和升级

同意悔棋只截断当前活动棋谱；完整历史仍保留撤回前棋步与公开快照，并追加申请、同意 / 拒绝事件。回放可以查看撤回前后整个过程，保持只读。棋盘版本单调递增，回退到相同手数也不会复用旧任务。

存档保存私有检查点、请求、截止时间、被冻结的走棋预算及每方申请限制。进程重启不会重置时限；暂停后的重启继续保持冻结。旧存档原子补齐新增字段，保留原凭据和任务期限，从升级后的成功棋步开始支持回退。升级前正常停止旧服务并备份数据目录。

## 验证

`npm test` 包含棋类互动的规则、权限、幂等、回退、拒绝 / 超时、暂停 / 撤销 / 重启、覆棋隐私、真实 Node 客户端、本机及远端模拟唤醒测试。唤醒测试使用隔离适配器，不向真实模型发送消息。

另提供 `scripts/test-chess-browser.mjs`，使用已安装的 Playwright 与 Chromium / Edge，在隔离房间与浏览器配置中验证双标签页对局。生产运行与 `npm test` 仍为零 npm 依赖。可在安装 Playwright 的环境直接执行，或指向已有模块：

```powershell
$env:ARENA_PLAYWRIGHT_MODULE='已安装 Playwright 的 index.mjs 绝对路径'
$env:ARENA_BROWSER_CHANNEL='msedge'
node scripts/test-chess-browser.mjs
```

脚本结束自动清理自己的 `tmp` 数据及浏览器配置。浏览器验收使用本机 Edge 与软件 WebGL；两台物理设备及真实模型宿主的长期联调边界沿用 [测试说明](TESTING.md)。离线依赖的来源、修改与许可见 [Three.js 来源记录](../public/vendor/three/NOTICE.md)。
