# NFD

NFD 是一个运行在 Cloudflare Workers 上的 Telegram 双向私聊转发机器人。

新访客先在 Telegram 内完成 Cloudflare Turnstile 验证，消息才会转发给管理员；管理员直接回复该转发消息，即可把回复发送给原访客。项目使用 Workers KV 保存消息映射、信任状态、屏蔽状态、验证会话和转发记录，并通过首次验证、限速及广告指纹减少骚扰消息。

> NFD 只处理机器人私聊，不处理群组、超级群组或频道消息。

## 功能

- Telegram 私聊消息双向转发
- 未信任且无有效验证资格的访客，发送任何消息都需要先通过 Telegram Mini App 内的 Turnstile 验证
- 验证通过后可正常交流 24 小时，期间发消息不会延长有效期
- 管理员首次成功回复后自动信任该访客
- 支持 `/block`、`/unblock`、`/checkblock`、`/checkuser` 管理命令
- 查询访客当前状态及指定消息当时的放行原因，转发记录保留 30 天
- 已确认广告生成文本指纹，未验证且未信任的访客发送相同广告时自动静默屏蔽
- 按 Telegram UID 进行软限速和临时限制
- 命中外部欺诈 UID 数据库时提醒管理员
- 访客和管理员使用独立的 `/start` 说明
- Webhook 注册和注销接口均要求 Bearer Token 认证

## 工作流程

1. 访客私聊机器人发送消息。
2. 已屏蔽、处于临时限制或超过限速的消息会被静默丢弃。
3. 已信任访客，或仍在 24 小时验证有效期内的访客，消息直接转发给管理员。
4. 其他访客先检查广告指纹：命中管理员已确认的广告指纹时，发送者会被自动屏蔽；未命中则暂存首条消息，并发送在 Telegram 内打开验证页的按钮。普通问候、图片、文件等都适用，不按内容风险分决定是否验证。
5. 验证未完成时，后续消息不会转发，也不会覆盖首条暂存消息。
6. Worker 确认 Telegram 身份和 Turnstile 服务端验证均有效后，首条暂存消息会自动转发，无需重复发送；之后 24 小时内可正常交流。等待验证期间发送的其他消息需要在验证通过后重新发送。
7. 管理员普通回复发送成功后，该访客会加入永久信任名单，以后免验证。管理命令和发送失败的回复不会授予信任。

`/start` 只返回使用说明，不会转发给管理员，也不会授予验证资格。

## 项目文件

| 文件 | 用途 |
| --- | --- |
| [`worker.js`](./worker.js) | Cloudflare Worker 主程序 |
| [`worker.test.js`](./worker.test.js) | 使用 Node.js 运行的行为测试 |
| [`data/startMessage.v4.md`](./data/startMessage.v4.md) | Turnstile 版本访客发送 `/start` 时看到的说明 |
| [`data/adminMessage.v4.md`](./data/adminMessage.v4.md) | Turnstile 版本管理员发送 `/start` 时看到的说明 |
| [`data/startMessage.md`](./data/startMessage.md)、[`data/adminMessage.md`](./data/adminMessage.md) | 保留给尚未升级的旧版 Worker 使用的说明 |

## 部署准备

开始前需要准备：

- 一个由 [@BotFather](https://t.me/BotFather) 创建的 Telegram Bot
- Bot Token
- 管理员本人的 Telegram 数字 UID
- 一个 Cloudflare 账号
- 一个 Cloudflare Turnstile 站点及其 Site Key、Secret Key
- 一个固定的 HTTPS Worker 地址或已绑定到 Worker 的 HTTPS 自定义域名
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

### 3. 创建 Turnstile 站点

按 [Cloudflare Turnstile 站点配置说明](https://developers.cloudflare.com/turnstile/get-started/widget-management/dashboard/)，在 Turnstile 页面添加站点：

- Widget Mode 选择 **Managed**。
- Hostname 填写验证页实际使用的 Worker 主机名，例如 `your-worker.your-subdomain.workers.dev`；不要包含 `https://`、路径或查询参数。使用自定义域名时填写实际域名。
- 保存 Site Key 和 Secret Key，分别用于下一步的公开配置与机密配置。

验证页通过机器人私聊消息中的 [Mini App 按钮](https://core.telegram.org/bots/webapps#launching-mini-apps-from-inline-buttons)打开，使用 Telegram 提供的身份数据。无需为此配置 BotFather 的 `/setdomain`。

### 4. 配置变量

在 Worker 的变量与机密配置中增加：

| 名称 | 内容 | 建议类型 |
| --- | --- | --- |
| `ENV_BOT_TOKEN` | BotFather 提供的 Bot Token | Secret |
| `ENV_BOT_SECRET` | 自行生成的随机密钥 | Secret |
| `ENV_ADMIN_UID` | 管理员本人的 Telegram 数字 UID | Text |
| `ENV_TURNSTILE_SITE_KEY` | Turnstile 站点的 Site Key，可公开 | Text |
| `ENV_TURNSTILE_SECRET_KEY` | 同一 Turnstile 站点的 Secret Key，仅用于服务端验证 | Secret |
| `ENV_PUBLIC_URL` | 验证页使用的固定 HTTPS origin，例如 `https://your-worker.your-subdomain.workers.dev` | Text |

`ENV_ADMIN_UID` 应填写管理员个人账号 UID，不是机器人 ID、群组 ID 或频道 ID。

`ENV_PUBLIC_URL` 必须与真实对外访问地址一致，且主机名已加入 Turnstile 站点。只填写 HTTPS origin，不要包含业务路径、查询参数、片段或用户名密码；末尾 `/` 可省略。验证链接由此配置生成，不使用请求传入的任意主机名。

`ENV_BOT_SECRET` 同时用于：

- Telegram Webhook 的 `secret_token`
- `/registerWebhook` 和 `/unRegisterWebhook` 的 Bearer Token

完成全部变量和 KV 绑定后，再部署一次 Worker。缺少 Turnstile 配置或服务端验证异常时，尚无有效 v4 验证资格的未信任访客不会被放行，也不能获得新资格，不会退回旧图标验证。已有有效 v4 资格仍按原来的 24 小时期限生效，已有永久信任记录继续保留；封禁和临时限制仍优先执行。

### 5. 注册 Webhook

将下面的域名替换为实际 Worker 地址：

```bash
read -rsp 'ENV_BOT_SECRET: ' BOT_SECRET && echo
curl --fail-with-body -X POST \
  -H "Authorization: Bearer ${BOT_SECRET}" \
  https://your-worker.your-subdomain.workers.dev/registerWebhook
unset BOT_SECRET
```

返回 `Ok` 表示注册成功。此接口会把 Telegram Webhook 设置为：

```text
https://your-worker.your-subdomain.workers.dev/endpoint
```

如需注销 Webhook：

```bash
read -rsp 'ENV_BOT_SECRET: ' BOT_SECRET && echo
curl --fail-with-body -X POST \
  -H "Authorization: Bearer ${BOT_SECRET}" \
  https://your-worker.your-subdomain.workers.dev/unRegisterWebhook
unset BOT_SECRET
```

管理接口只接受 `POST`。未提供正确 Bearer Token 的请求会被拒绝。

### 6. 验证部署

使用尚未被管理员信任且无有效验证资格的 Telegram 账号发送“你好”，确认管理员暂未收到消息，再点击机器人提供的验证按钮，在 Telegram 内完成验证。成功后首条消息应自动转发，之后的消息可在固定 24 小时内继续发送。

分别在实际使用的手机和桌面 Telegram 客户端测试按钮打开、Turnstile 加载和验证成功后的转发。不要只在外部浏览器打开验证链接测试：外部浏览器没有该 Mini App 的 Telegram 身份数据，不能完成认证。若客户端不支持或验证页加载失败，应先更新客户端、检查网络与 Turnstile 主机名配置；不能以跳过验证确认部署成功。

管理员回复该消息执行 `/checkuser`，确认当前验证状态及该条消息的放行原因；再用普通回复测试自动永久信任。直接打开 Worker 根路径得到 `404` 或 `No handler for this request` 属于正常现象，根路径不是验证入口。

## 使用方法

### 访客

- 发送 `/start` 查看简短使用说明。
- 直接发送文字、图片、视频或文件。
- 首次联系时，即使只发送“你好”，也需点击机器人提供的验证按钮，在 Telegram 内完成验证。已被管理员信任或仍在有效验证期内的访客免验证。
- 完成验证前，消息不会发送给管理员，只保留首条待发送消息。
- 验证成功后，首条原消息会自动发送，无需重复提交；等待期间发送的其他消息请重新发送。
- 验证资格从验证成功起固定保留 24 小时，期间发消息不会续期。到期后若尚未被管理员信任，再次发消息需要重新验证。

### 管理员

- 发送 `/start` 查看管理员专用说明。
- 回复机器人转发的访客消息，回复内容会发送给原访客。
- 首次普通回复发送成功后，访客会自动加入永久信任名单，以后免验证；无须额外执行信任命令。
- 管理命令必须回复在对应的转发消息上：

| 命令 | 作用 |
| --- | --- |
| `/block` | 永久屏蔽该访客、撤销永久信任和 24 小时验证资格，并记录该消息的广告指纹 |
| `/unblock` | 解除屏蔽，并移除该消息对应的广告指纹；不会恢复原有信任或验证资格 |
| `/checkblock` | 检查该访客当前是否被屏蔽 |
| `/checkuser` | 查看该访客当前封禁、信任、有效验证状态，以及所回复消息当时的放行原因 |

管理命令不会发送给访客，也不会授予信任。管理员 UID 不进行访客验证和限速。确认是广告时请使用 `/block`；普通回复“不要发广告”等文字也会让对方获得永久信任。

### 查询消息为何被转发

回复某条已转发的访客消息并发送 `/checkuser`，可分别查看：

- **当前状态**：访客现在是否被封禁、是否已永久信任、是否还有有效的 24 小时验证资格。
- **当时的放行原因**：这条消息是由于永久信任、仍在验证有效期内，还是刚刚通过验证而转发。

转发记录保留 30 天，`/block` 不删除历史记录。用户之后被信任或屏蔽，不会改写旧消息当时的放行原因。升级前的旧消息、已过期或未成功保存记录的消息，会显示原因未知；不能用当前状态或不足的日志反推过去的放行依据。

## 验证与信任

消息是否放行取决于验证和信任状态，不再依赖关键词、媒体类型或短时间连续发送的风险分：

| 状态 | 消息处理 |
| --- | --- |
| 未验证、验证已过期或验证尚未完成 | 不转发；保留首条消息，要求完成验证 |
| 已通过验证，尚未获得永久信任 | 验证成功起 24 小时内正常转发，不因继续发消息延长有效期 |
| 管理员普通回复发送成功，已永久信任 | 免验证，正常转发 |
| 已被 `/block` 屏蔽 | 始终拦截，验证或信任不能绕过 |

所有访客仍受临时限制和软限速约束。验证通过或永久信任后，不再按广告指纹检查其后续消息；管理员仍可随时通过 `/block` 屏蔽。

广告指纹只用于尚未验证且未信任的访客：管理员执行 `/block` 后，相同广告的规范化文本指纹会保留 30 天，命中时自动静默屏蔽发送者。Turnstile 增加自动群发的成本，不保证通过验证的内容一定不是广告。

## Turnstile 验证

- 访客从机器人私聊消息中的按钮打开 Telegram Mini App，并按 Turnstile 提示完成验证。
- Mini App 提交 Telegram 原始 `initData`、验证会话 ID 和 Turnstile token。Worker 校验 `initData` 的 HMAC 签名、签发时间及用户 UID，确保完成验证的账号就是发起会话的访客。
- Worker 再向 Cloudflare 服务端验证 token，检查 `success`、预期 `hostname`、`action` 和绑定会话的 `cdata`。客户端显示成功或单独提交 UID 不能代替这些检查。
- 身份不匹配、数据过期、Turnstile 校验失败或配置异常时，本次验证请求不会授予新资格或转发暂存消息。已有有效 v4 资格仍按原期限生效；旧图标按钮不能授予资格。
- 待完成的验证会话和待转发消息保留 10 分钟。
- 同一会话只保留首次触发验证的消息。完成前继续发问候、图片或其他内容，都不会直接转发，也不会覆盖首条消息。
- 验证成功后，首条暂存消息自动转发，并授予固定 24 小时验证资格。
- 24 小时内后续消息无需重复验证，继续发消息不会续期。
- 验证资格到期且尚未获得永久信任时，再次发消息需要重新验证。

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

当前 Turnstile 版本的访客和管理员 `/start` 文案，会在收到命令时从 GitHub `main` 分支实时读取：

- `data/startMessage.v4.md`
- `data/adminMessage.v4.md`

旧版 Worker 仍读取 `data/startMessage.md` 和 `data/adminMessage.md`，这两个文件保留旧版功能说明。因此只合并本次 PR、尚未部署新 Worker 时，线上旧版不会提前显示 Turnstile 或 `/checkuser` 的说明；部署新版后才会切换到 `v4` 文案。

已部署相应版本后，只修改其文案并合并到 `main`，通常不需要再次部署 Worker。GitHub Raw 缓存可能导致更新短暂延迟。新增命令或改变验证方式时，必须同步部署支持该功能的 Worker，不能仅更新旧版本正在读取的文案。

如果使用 Fork 部署，请把 `worker.js` 中的 `startMsgUrl` 和 `adminMsgUrl` 改为自己的仓库地址，否则机器人仍会读取本仓库的文案。

## Worker 路由

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| `/endpoint` | `POST` | 接收 Telegram Webhook；校验 `X-Telegram-Bot-Api-Secret-Token` |
| `/verify?challenge={ID}` | `GET` | Telegram Mini App 验证页，从机器人消息中的按钮打开 |
| `/verify/complete` | `POST` | 接收 JSON：`initData`、`challengeId`、`turnstileToken`；执行服务端校验 |
| `/registerWebhook` | `POST` | 注册 Webhook；要求 Bearer Token |
| `/unRegisterWebhook` | `POST` | 注销 Webhook；要求 Bearer Token |
| 其他路径 | 任意 | 返回 `404` |

## KV 数据

所有状态继续使用同一个 `nfd` KV Namespace：

| Key | 内容与有效期 |
| --- | --- |
| `trusted-{UID}` | 管理员成功回复后的永久信任状态 |
| `verified-{UID}` | 版本 4、方式为 Turnstile 的验证资格，自验证成功起固定 24 小时 |
| `isblocked-{UID}` | 管理员设置的屏蔽状态 |
| `msg-map-{消息ID}` | 管理员端消息 ID 到访客 chat ID 的映射 |
| `delivery-audit-{管理员端消息ID}` | 该条消息当时的放行原因、相关验证或信任时间及转发时间，保留 30 天 |
| `spam-fingerprint-{SHA256}` | 管理员确认的广告文本指纹，保留 30 天 |
| `captcha-{UID}` | 版本 3、方式为 Turnstile 的当前验证会话，最长约 10 分钟 |
| `captcha-claim-{challengeId}` | 验证完成处理记录，TTL 不超过当前会话 |
| `pending-message-{UID}` | 当前待验证消息，最长约 10 分钟 |
| `captcha-block-{UID}` | 兼容读取旧版验证失败的剩余限制，至原有效期结束；新版本不再写入 |
| `rate-minute-{UID}-{窗口}` | 分钟计数，约 2 分钟 |
| `rate-hour-{UID}-{窗口}` | 小时计数，约 2 小时 |
| `rate-strikes-{UID}` | 最近一小时的超限分钟窗口 |
| `rate-block-{UID}` | 多次超限后的 24 小时限制 |

Workers KV 是最终一致性存储。代码会尽量避开同一 Key 每秒多次写入，并对关键消息映射进行有限重试，但不提供跨 Worker 实例的强原子保证。

升级后继续保留原有永久信任和屏蔽记录。旧版 `verified-{UID}`（包括图标验证生成的版本 3）不视为有效验证资格；只有旧版资格且尚未被永久信任的访客，需完成新的 Turnstile 验证。已有有效 v4 资格按原期限生效。旧图标会话和按钮不能授予新资格；旧的 `untrusted-window-{UID}` 数据不再使用，可等待其自动过期。

## 测试

测试只使用 Node.js 内置模块，建议使用 Node.js 18 或更高版本：

```bash
node --check worker.js
node --check worker.test.js
node worker.test.js
```

测试覆盖首次验证门禁、Telegram 身份签名与时效、Turnstile 服务端结果校验、24 小时资格与过期、旧验证资格迁移、重复提交、自动信任、封禁优先级及转发记录查询等场景。测试中的部分错误日志来自故障模拟。自动测试不能替代真实手机和桌面 Telegram 客户端中的验证流程检查。

## 从图标验证升级

1. 在 Cloudflare 创建 **Managed** Turnstile 站点，加入验证页实际使用的 Worker 主机名。
2. 保留原有 Bot Token、Webhook 密钥、管理员 UID 和 `nfd` KV 绑定，新增 `ENV_TURNSTILE_SITE_KEY`、`ENV_TURNSTILE_SECRET_KEY`、`ENV_PUBLIC_URL`。
3. 检查 `ENV_PUBLIC_URL` 与 Turnstile 主机名一致，替换 `worker.js` 并手动部署。只合并 PR 或更新远程说明文案不会升级线上 Worker。
4. 用未信任且无有效验证资格的 Telegram 账号，按“验证部署”步骤在手机和桌面客户端完成实际测试，再用 `/checkuser` 检查放行记录。

无需重建 KV、迁移业务账号或清除永久信任名单。旧版 24 小时验证资格自动失效，尚未获得永久信任的相关访客需重新验证；旧消息的历史放行原因无法补录为已知。没有配置 Turnstile 时不能继续使用旧图标验证代替，尚无有效 v4 资格的未信任访客会被拦在验证环节；已有有效 v4 资格仍保留至原定期限。

## 更新说明

- 修改 `worker.js` 后，需要在 Cloudflare 中替换代码并重新部署。
- 只修改已部署版本对应的 `/start` 文案时，通常不需要重新部署 Worker；从旧版升级到 Turnstile 仍须配置变量并部署新版。
- Worker 地址、Bot Token 和 `ENV_BOT_SECRET` 未变化时，不需要重新注册 Webhook。
- 更新代码不需要重建 KV Namespace，也不要删除原有 KV 数据。
- Bot Token 或 Webhook 密钥一旦泄露，应立即轮换；不要把真实密钥提交到仓库、命令记录或公开聊天中。

## 致谢

- [telegram-bot-cloudflare](https://github.com/cvzi/telegram-bot-cloudflare)
