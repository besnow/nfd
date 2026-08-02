## 更新

欢迎使用我们NFD2.0项目🎉，1分钟内快速搭建教程：

> 用户先去[@BotFather](https://t.me/NodeForwardBot/BotFather)，输入 `/newbot` ，按照指引输入你要创建的机器人的昵称和名字，点击复制机器人吐出的token
> 
> 然后到[@NodeForwardBot](https://t.me/NodeForwardBot)粘贴，完活。
> 
> 详细信息可以参考：[https://www.nodeseek.com/post-286885-1](https://www.nodeseek.com/post-286885-1)

NFD2.0拥有无限配额（自建有每日1k消息上限），且托管在[cloudflare snippets](https://developers.cloudflare.com/rules/snippets/)，理论上不会掉线。如果需要自建，参考下面的自建教程。

# NFD
No Fraud / Node Forward Bot

一个基于cloudflare worker的telegram 消息转发bot，集成了反欺诈功能

## 特点
- 基于cloudflare worker搭建，能够实现以下效果
    - 搭建成本低，一个js文件即可完成搭建
    - 不需要额外的域名，利用worker自带域名即可
    - 基于worker kv实现永久数据储存
    - 稳定，全球cdn转发
- 接入反欺诈系统，当聊天对象有诈骗历史时，自动发出提醒
- 支持屏蔽用户，避免被骚扰
- 仅接收 Telegram 私聊消息，并通过 20 以内的加减法验证、UID 限速和静默封禁减少骚扰

## 搭建方法
1. 从[@BotFather](https://t.me/BotFather)获取token，并且可以发送`/setjoingroups`来禁止此Bot被添加到群组
2. 从[uuidgenerator](https://www.uuidgenerator.net/)获取一个随机uuid作为secret
3. 从[@username_to_id_bot](https://t.me/username_to_id_bot)获取你的用户id
4. 登录[cloudflare](https://workers.cloudflare.com/)，创建一个worker
5. 配置worker的变量
    - 增加一个`ENV_BOT_TOKEN`变量，数值为从步骤1中获得的token
    - 增加一个`ENV_BOT_SECRET`变量，数值为从步骤2中获得的secret
    - 增加一个`ENV_ADMIN_UID`变量，数值为从步骤3中获得的用户id
6. 绑定kv数据库，创建一个Namespace Name为`nfd`的kv数据库，在setting -> variable中设置`KV Namespace Bindings`：nfd -> nfd
7. 点击`Quick Edit`，复制[这个文件](./worker.js)到编辑器中
8. 部署后使用下面的命令注册 Webhook。管理接口只接受 `POST`，并要求与
   `ENV_BOT_SECRET` 完全一致的 Bearer Token（不要把真实密钥提交到仓库或 shell 历史）：

   ```bash
   read -rsp 'ENV_BOT_SECRET: ' BOT_SECRET && echo
   curl --fail-with-body -X POST \
     -H "Authorization: Bearer ${BOT_SECRET}" \
     https://xxx.workers.dev/registerWebhook
   unset BOT_SECRET
   ```

   如需取消 Webhook，使用相同的认证方式：

   ```bash
   read -rsp 'ENV_BOT_SECRET: ' BOT_SECRET && echo
   curl --fail-with-body -X POST \
     -H "Authorization: Bearer ${BOT_SECRET}" \
     https://xxx.workers.dev/unRegisterWebhook
   unset BOT_SECRET
   ```

## 使用方法
- 当其他用户给bot发消息，会被转发到bot创建者
- 用户回复普通文字给转发的消息时，会回复到原消息发送者
- 用户回复`/block`, `/unblock`, `/checkblock`等命令会执行相关指令，**不会**回复到原消息发送者
- 群组、超级群组和频道消息会被忽略；管理员 UID 不需要验证，也不受访客限速影响
- 陌生用户首次发送 `/start`（或其他消息）时会收到 20 以内的随机加减法验证。
  用户只需从随机排列的 3 个不同数字按钮中点击一次；减法结果不会为负数，且只有一个正确答案。
  验证题 10 分钟内有效，有效且已成功发送的题目存在时不会重复发送新题。
  `/start` 不会被保存为待转发消息；其他首条消息会保存 10 分钟，验证成功后自动转发给管理员，无需重新发送。
  验证通过的 UID 会永久保存，以后不需要重复验证
- 验证码创建时先以 `pending` 状态写入 KV，10 秒内的并发消息会复用该创建过程；Telegram
  成功返回消息 ID 后才切换为 `active`。超过 10 秒仍为 `pending` 的异常题目才允许重新创建
- 每次选错都会立即换成新题目并使旧按钮失效；连续答错 3 道题会被静默限制 1 小时。
  新题继承当前验证会话的原始过期时间，不会因答错重新开始 10 分钟。
  永久屏蔽、临时限制或超过限速的消息都会被静默丢弃
- 正确答案回调先移除按钮并将 Telegram 消息改为“验证处理中”，只有成功完成该编辑的回调才会转发消息，
  防止快速重复点击导致重复转发。处理状态超过 30 秒后可重新创建验证，不会永久卡住。转发成功后，管理员回复映射最多写入 3 次；
  映射失败不会被误报为转发失败。

## 防骚扰限速

限速按 Telegram UID 计算，管理员除外：

- 每分钟最多处理 5 条消息
- 每小时最多处理 20 条消息
- 超额消息不作回复，也不会转发
- 同一分钟窗口无论丢弃多少条消息，最多记录一次限速触发
- 最近一小时内有 3 个不同分钟窗口触发限速后，该 UID 会被静默封禁 24 小时

这些计数是基于 Cloudflare KV 最终一致性模型的 **best-effort 软限速**，不是严格原子限速。
每个 UID 使用一个 strike 状态，并用分钟窗口集合去重，因此并发读取延迟可能导致少计、状态覆盖
或延迟封禁，但同一次状态更新不会把同一分钟重复累计成多个触发。它主要用于普通的机器人私聊
防骚扰场景。

## KV 数据

继续使用现有的 `nfd` KV 绑定，不需要增加依赖或新的 Namespace。主要键如下：

| 键 | 内容与有效期 |
| --- | --- |
| `verified-{UID}` | 已通过验证的标记，永久保存 |
| `captcha-{UID}` | 当前算术题的随机 ID、UID、`createdAt`、`pending`/`active`/`processing` 状态、3 个数字选项、正确选项 ID、失败次数、聊天/消息信息和过期时间，10 分钟 |
| `pending-message-{UID}` | 验证前第一条非 `/start` 消息的 chat ID 和 message ID；TTL 与当前验证会话的原始过期时间同步，验证完成后删除 |
| `captcha-block-{UID}` | 连续验证失败后的静默限制，1 小时 |
| `rate-minute-{UID}-{窗口}` | 分钟窗口消息计数（键额外保留约 2 分钟） |
| `rate-hour-{UID}-{窗口}` | 小时窗口消息计数（键额外保留约 2 小时） |
| `rate-strikes-{UID}` | `{ "windows": [分钟窗口, ...] }`，保存最近一小时内不同的超限分钟窗口，有效期1小时 |
| `rate-block-{UID}` | 达到 3 次限速触发后的静默封禁，24 小时 |
| `isblocked-{UID}` | 管理员通过 `/block` 设置的永久屏蔽状态 |
| `msg-map-{消息ID}` | 转发给管理员的消息 ID 到访客 chat ID 的映射；管理员回复依赖此键 |
| `lastmsg-{UID}` | 上一次向管理员发送安全提醒的时间 |

## 欺诈数据源
- 文件[fraud.db](./fraud.db)为欺诈数据，格式为每行一个uid
- 可以通过pr扩展本数据，也可以通过提issue方式补充
- 提供额外欺诈信息时，需要提供一定的消息出处

## Thanks
- [telegram-bot-cloudflare](https://github.com/cvzi/telegram-bot-cloudflare)
