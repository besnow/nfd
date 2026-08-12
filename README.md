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
- 仅接收 Telegram 私聊消息，并通过静默风险判断、两轮图标验证、自动信任、广告指纹、UID 限速和静默封禁减少骚扰

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
   - `/start` 返回的使用说明保存在 [`data/startMessage.md`](./data/startMessage.md)，可以按需要修改
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
- 用户回复普通文字给转发的消息时，会回复到原消息发送者；回复成功后，该用户会自动加入永久信任名单
- 用户回复`/block`, `/unblock`, `/checkblock`等命令会执行相关指令，**不会**回复到原消息发送者
- 群组、超级群组和频道消息会被忽略；管理员 UID 不需要验证，也不受访客限速影响
- 陌生用户发送普通咨询内容时不会看到验证码，消息会直接转发。Worker 只对包含网址、Telegram 链接、联系方式、多个推广词或其他组合风险特征的消息触发验证；单独发送普通截图不会触发验证。
- 陌生用户的任何转发消息（包括纯文字）都会达到验证阈值；通过其他机器人发送的消息，以及带有 URL、登录链接或 Web App 按钮的消息，也会直接达到验证阈值。因此无需 OCR 也能拦截拆成多条发送的转发广告。
- `@用户名`、电话号码或邮箱会直接达到验证阈值；“群发、批量私信、采集群、强拉活人、自动获客”等明确推广短语，以及“还在／一键／全自动＋群发／批量／获客／采集”等营销问句结构，也会直接触发验证。陌生用户在 60 秒内继续发送消息会增加 2 分，但普通分段咨询仍低于阈值。
- 可疑用户需要连续完成两轮图标验证。每轮根据文字提示从随机排列的 6 个图标中选择一个，按钮分为两行；任意一轮选错都会从第一轮重新开始，累计选错 2 次会被限制 1 小时并收到简短提示。
- 验证会话 10 分钟内有效，有效且已成功发送的题目存在时不会重复发送。可疑消息会保存 10 分钟，连续两轮验证成功后自动转发，无需重新发送。
- 图标验证只放行当前保存的消息，不会产生临时通行证；同一未信任用户之后再次发送转发消息、链接等可疑内容时，需要重新验证。管理员正常回复成功后，用户才会写入 `trusted-{UID}` 永久信任状态。
- 管理员对广告消息执行 `/block` 时，会同时撤销该 UID 的永久信任，并保存规范化后的广告文本指纹 30 天；其他 UID 再次发送相同广告时会被静默屏蔽。对原消息执行 `/unblock` 会同时移除对应指纹，便于纠正误判。
- `/start` 直接返回欢迎信息，不会保存、转发或触发验证。
- 图标验证的 `callback_data` 只包含随机 challenge ID 和选项 ID，不包含目标名称或正确答案。
- 风险判断仅使用当前 Telegram 消息中已有的文本、实体和媒体类型，不依赖外部服务。命中阈值只会触发验证，不会直接封禁；只有命中管理员已经确认的广告指纹才会自动屏蔽。
- 在 Workers KV 的最终一致性限制下，机器人正常情况保留首次观察到的待验证消息；同一 Worker 实例内会按 UID 串行创建，但不声称跨实例原子性。
- 验证码创建时先向 Telegram 发送题目，拿到消息 ID 后再将完整的 `active` 状态写入 KV 一次，不会对同一 Key 紧接着执行两次写入。
- 正确和错误答案都先尝试删除当前 Telegram 验证消息，只有删除成功的回调能继续。删除后使用独立的 challenge claim Key 记录处理权；claim 超过 30 秒且 UID 仍未验证时可重新创建验证，不会永久卡住。
- 转发成功后，管理员回复映射最多写入 3 次；映射失败不会被误报为转发失败。永久屏蔽、临时限制或超过限速的消息都会被静默丢弃。

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
防骚扰场景。如果计数写入遇到 KV 同 Key 写入限制或短暂故障，消息会正常继续处理，避免误丢正常用户消息。

## KV 数据

继续使用现有的 `nfd` KV 绑定，不需要增加依赖或新的 Namespace。主要键如下：

| 键 | 内容与有效期 |
| --- | --- |
| `trusted-{UID}` | 管理员成功回复该用户后的永久信任状态；信任用户不再进行风险判断或图标验证 |
| `captcha-{UID}` | 当前图标题的随机 ID、UID、轮次、目标名称、6 个图标选项、正确选项 ID、失败次数、状态、聊天/消息信息和过期时间，10 分钟；完成后写入短期 `completed` 状态，必须更新时至少间隔 1100 毫秒 |
| `captcha-claim-{challengeId}` | Telegram 验证消息删除成功后的 UID 和 `claimedAt`；每个 challenge 只写一次，TTL 不超过当前验证会话 |
| `pending-message-{UID}` | 保留当前验证会话首次观察到的消息 chat ID、message ID、状态和 `expiresAt`；验证完成后标记为 `completed`，下一次可疑消息会建立新会话 |
| `captcha-block-{UID}` | 连续验证失败后的静默限制，1 小时 |
| `rate-minute-{UID}-{窗口}` | 分钟窗口消息计数（键额外保留约 2 分钟） |
| `rate-hour-{UID}-{窗口}` | 小时窗口消息计数（键额外保留约 2 小时） |
| `rate-strikes-{UID}` | `{ "windows": [分钟窗口, ...] }`，保存最近一小时内不同的超限分钟窗口，有效期1小时 |
| `rate-block-{UID}` | 达到 3 次限速触发后的静默封禁，24 小时 |
| `untrusted-window-{UID}` | 陌生用户第一次消息的时间，保存约 2 分钟；60 秒内的后续消息增加 2 分风险 |
| `isblocked-{UID}` | 管理员通过 `/block` 设置的永久屏蔽状态 |
| `spam-fingerprint-{SHA256}` | 管理员确认的规范化广告文本指纹及来源 UID，保存 30 天 |
| `msg-map-{消息ID}` | 转发给管理员的消息 ID 到访客 chat ID 的映射；管理员回复依赖此键 |

## 欺诈数据源
- 文件[fraud.db](./fraud.db)为欺诈数据，格式为每行一个uid
- 可以通过pr扩展本数据，也可以通过提issue方式补充
- 提供额外欺诈信息时，需要提供一定的消息出处

## Thanks
- [telegram-bot-cloudflare](https://github.com/cvzi/telegram-bot-cloudflare)
