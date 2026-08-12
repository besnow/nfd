# NFD

NFD 是一个运行在 Cloudflare Workers 上的 Telegram 双向私聊转发机器人。

访客向机器人发送消息后，消息会转发给管理员；管理员直接回复该转发消息，即可把回复发送给原访客。项目使用 Workers KV 保存消息映射、信任状态、屏蔽状态和验证会话，并通过静默风控、图标验证、限速及广告指纹减少骚扰消息。

> NFD 只处理机器人私聊，不处理群组、超级群组或频道消息。

## 功能

- Telegram 私聊消息双向转发
- 普通咨询直接转发，可疑消息触发两轮图标验证
- 管理员首次成功回复后自动信任该访客
- 支持 `/block`、`/unblock`、`/checkblock` 管理命令
- 已确认广告生成文本指纹，相同广告再次出现时自动静默屏蔽
- 按 Telegram UID 进行软限速和临时限制
- 命中外部欺诈 UID 数据库时提醒管理员
- 访客和管理员使用独立的 `/start` 说明
- Webhook 注册和注销接口均要求 Bearer Token 认证

## 工作流程

1. 访客私聊机器人发送消息。
2. 已屏蔽、处于临时限制或超过限速的消息会被静默丢弃。
3. 已信任访客的消息直接转发给管理员。
4. 未信任访客的消息会进行广告指纹和风险判断：
   - 低风险消息直接转发；
   - 达到风险阈值的消息要求完成两轮图标验证；
   - 命中管理员已确认的广告指纹时，发送者会被自动屏蔽。
5. 验证成功后，触发验证的原消息会自动转发，无需访客重复发送。
6. 管理员回复转发消息后，回复会发送给原访客；发送成功后，该访客会加入永久信任名单。

## 项目文件

| 文件 | 用途 |
| --- | --- |
| [`worker.js`](./worker.js) | Cloudflare Worker 主程序 |
| [`worker.test.js`](./worker.test.js) | 使用 Node.js 运行的行为测试 |
| [`data/startMessage.md`](./data/startMessage.md) | 访客发送 `/start` 时看到的说明 |
| [`data/adminMessage.md`](./data/adminMessage.md) | 管理员发送 `/start` 时看到的说明 |

## 部署准备

开始前需要准备：

- 一个由 [@BotFather](https://t.me/BotFather) 创建的 Telegram Bot
- Bot Token
- 管理员本人的 Telegram 数字 UID
- 一个 Cloudflare 账号
- 一个随机 Webhook 密钥，例如使用 `openssl rand -hex 32` 生成

建议在 BotFather 中使用 `/setjoingroups` 禁止机器人被添加到群组。即使没有关闭，Worker 也只会处理私聊更新。

## 部署到 Cloudflare Workers

### 1. 创建 Worker

在 Cloudflare 中创建一个 Worker，将 [`worker.js`](./worker.js) 的完整内容复制到在线编辑器并部署。

该脚本使用 Service Worker 事件监听写法，不需要构建命令或第三方依赖。

### 2. 创建并绑定 KV

创建一个 Workers KV Namespace，然后在 Worker 中添加 KV 绑定：

| 绑定名称 | Namespace |
| --- | --- |
| `nfd` | 选择刚创建的 KV Namespace |

绑定名称区分大小写，必须是 `nfd`。

### 3. 配置变量

在 Worker 的变量与机密配置中增加：

| 名称 | 内容 | 建议类型 |
| --- | --- | --- |
| `ENV_BOT_TOKEN` | BotFather 提供的 Bot Token | Secret |
| `ENV_BOT_SECRET` | 自行生成的随机密钥 | Secret |
| `ENV_ADMIN_UID` | 管理员本人的 Telegram 数字 UID | Text |

`ENV_ADMIN_UID` 应填写管理员个人账号 UID，不是机器人 ID、群组 ID 或频道 ID。

`ENV_BOT_SECRET` 同时用于：

- Telegram Webhook 的 `secret_token`
- `/registerWebhook` 和 `/unRegisterWebhook` 的 Bearer Token

完成变量和 KV 绑定后，再部署一次 Worker。

### 4. 注册 Webhook

将下面的域名替换为实际 Worker 地址：

```bash
read -rsp 'ENV_BOT_SECRET: ' BOT_SECRET && echo
curl --fail-with-body -X POST \
  -H "Authorization: Bearer ${BOT_SECRET}" \
  https://your-worker.workers.dev/registerWebhook
unset BOT_SECRET
```

返回 `Ok` 表示注册成功。此接口会把 Telegram Webhook 设置为：

```text
https://your-worker.workers.dev/endpoint
```

如需注销 Webhook：

```bash
read -rsp 'ENV_BOT_SECRET: ' BOT_SECRET && echo
curl --fail-with-body -X POST \
  -H "Authorization: Bearer ${BOT_SECRET}" \
  https://your-worker.workers.dev/unRegisterWebhook
unset BOT_SECRET
```

管理接口只接受 `POST`。未提供正确 Bearer Token 的请求会被拒绝。

## 使用方法

### 访客

- 发送 `/start` 查看简短使用说明。
- 直接发送文字、图片、视频或文件。
- 普通咨询通常直接转发；出现验证时，根据提示连续选择两次指定图标。
- 验证成功后，当前原消息会自动发送，无需重复提交。

### 管理员

- 发送 `/start` 查看管理员专用说明。
- 回复机器人转发的访客消息，回复内容会发送给原访客。
- 首次成功回复后，访客会自动加入信任名单，以后不再进行风险判断或图标验证。
- 管理命令必须回复在对应的转发消息上：

| 命令 | 作用 |
| --- | --- |
| `/block` | 永久屏蔽该访客、撤销信任，并记录该消息的广告指纹 |
| `/unblock` | 解除屏蔽，并移除该消息对应的广告指纹 |
| `/checkblock` | 检查该访客当前是否被屏蔽 |

管理命令不会发送给访客。管理员 UID 不进行访客风控和限速。

## 静默风控

风险分达到 `3` 时触发验证。当前代码使用下列信号累计风险分：

| 信号 | 风险分 |
| --- | ---: |
| URL、Telegram 链接或常见域名 | +3 |
| `@用户名`、电话号码或邮箱 | +3 |
| 明确广告短语或组合营销句式 | +3 |
| 同一消息命中两个或更多普通推广词 | +3 |
| 命中一个普通推广词 | +1 |
| 图片、视频、动画或文件 | +1 |
| Telegram 转发消息，包括纯文字 | +3 |
| 通过其他机器人发送 | +3 |
| 带外部 URL、登录链接或 Web App 的按钮 | +3 |
| 多行堆叠内容或异常重复字符 | +1 |
| 未信任访客在首次消息后的 60 秒内继续发送 | +2 |

这些分数可以叠加。单独发送普通截图通常不会触发验证，普通的两段式咨询也不会仅因连续发送而达到阈值。

命中风险阈值只会触发验证，不会直接屏蔽访客。只有管理员执行 `/block` 后产生的广告指纹，才会用于自动静默屏蔽其他发送相同广告的 UID。

## 图标验证

- 每轮显示 6 个随机图标，访客按文字提示选择目标图标。
- 需要连续完成 2 轮。
- 任意一轮选错后会从第 1 轮重新开始。
- 累计选错 2 次会被限制 1 小时。
- 验证会话和待转发消息保留 10 分钟。
- 同一会话正常只保留首次触发验证的消息。
- 验证成功只放行当前保存的消息，不提供临时免验证时段。
- 未被管理员信任的访客之后再次发送可疑消息时，需要重新验证。

## 防骚扰限速

限速按访客 Telegram UID 计算：

- 每分钟最多处理 5 条消息
- 每小时最多处理 20 条消息
- 超额消息静默丢弃
- 同一分钟窗口最多记录一次超限触发
- 最近一小时内有 3 个不同分钟窗口触发超限后，静默限制该 UID 24 小时

限速基于 Workers KV 的最终一致性模型，是 best-effort 软限速，不是严格原子计数。计数写入遇到 KV 同 Key 写入限制或短暂故障时，代码会允许消息继续处理，避免正常访客因计数故障被误丢弃。

## 欺诈 UID 提醒

消息成功转发后，Worker 会检查发送者 UID 是否存在于 `worker.js` 中 `fraudDb` 指向的外部数据库。命中时，管理员会收到“检测到骗子”的提醒。

当前数据源为：

```text
https://raw.githubusercontent.com/LloydAsp/nfd/main/data/fraud.db
```

如需使用自己的欺诈 UID 列表，请修改 `worker.js` 中的 `fraudDb`。文件格式为每行一个 UID。

## 远程文案

访客和管理员 `/start` 文案会在收到命令时从 GitHub `main` 分支实时读取：

- `data/startMessage.md`
- `data/adminMessage.md`

因此只修改这两个文案并合并到 `main` 后，通常不需要重新部署 Worker。GitHub Raw 缓存可能导致更新短暂延迟。

如果使用 Fork 部署，请把 `worker.js` 中的 `startMsgUrl` 和 `adminMsgUrl` 改为自己的仓库地址，否则机器人仍会读取本仓库的文案。

## Worker 路由

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| `/endpoint` | `POST` | 接收 Telegram Webhook；校验 `X-Telegram-Bot-Api-Secret-Token` |
| `/registerWebhook` | `POST` | 注册 Webhook；要求 Bearer Token |
| `/unRegisterWebhook` | `POST` | 注销 Webhook；要求 Bearer Token |
| 其他路径 | 任意 | 返回 `404` |

## KV 数据

所有状态继续使用同一个 `nfd` KV Namespace：

| Key | 内容与有效期 |
| --- | --- |
| `trusted-{UID}` | 管理员成功回复后的永久信任状态 |
| `isblocked-{UID}` | 管理员设置的屏蔽状态 |
| `msg-map-{消息ID}` | 管理员端消息 ID 到访客 chat ID 的映射 |
| `spam-fingerprint-{SHA256}` | 管理员确认的广告文本指纹，保留 30 天 |
| `captcha-{UID}` | 当前验证状态，最长约 10 分钟 |
| `captcha-claim-{challengeId}` | 验证回调处理权，TTL 不超过当前会话 |
| `pending-message-{UID}` | 当前待验证消息，最长约 10 分钟 |
| `captcha-block-{UID}` | 验证失败后的 1 小时限制 |
| `untrusted-window-{UID}` | 未信任访客短时间连续发送状态，约 2 分钟 |
| `rate-minute-{UID}-{窗口}` | 分钟计数，约 2 分钟 |
| `rate-hour-{UID}-{窗口}` | 小时计数，约 2 小时 |
| `rate-strikes-{UID}` | 最近一小时的超限分钟窗口 |
| `rate-block-{UID}` | 多次超限后的 24 小时限制 |

Workers KV 是最终一致性存储。代码会尽量避开同一 Key 每秒多次写入，并对关键消息映射进行有限重试，但不提供跨 Worker 实例的强原子保证。

## 测试

测试只使用 Node.js 内置模块，建议使用 Node.js 18 或更高版本：

```bash
node --check worker.js
node --check worker.test.js
node worker.test.js
```

测试包含普通消息、拆分广告、两轮验证、重复回调、KV 写入限制、消息映射、自动信任、广告指纹和失败恢复等场景。测试中的部分错误日志来自故障模拟，最终出现以下内容即表示通过：

```text
worker tests passed with silent risk control and KV write-limit enforcement
```

## 更新说明

- 修改 `worker.js` 后，需要在 Cloudflare 中替换代码并重新部署。
- 只修改访客或管理员 `/start` 文案时，通常不需要重新部署 Worker。
- Worker 地址、Bot Token 和 `ENV_BOT_SECRET` 未变化时，不需要重新注册 Webhook。
- 更新代码不需要重建 KV Namespace，也不要删除原有 KV 数据。
- Bot Token 或 Webhook 密钥一旦泄露，应立即轮换；不要把真实密钥提交到仓库、命令记录或公开聊天中。

## 致谢

- [telegram-bot-cloudflare](https://github.com/cvzi/telegram-bot-cloudflare)
