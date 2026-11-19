# EasySub Workers + D1 个人版

一个 Worker、一个 D1 数据库，一个私人账号。电脑使用项目已有的本地优先 Vue 界面，手机使用作者发布的 EasySub Android 0.3.0 Alpha APK。两端都通过 HTTPS 同步。浏览器首次打开会进入「账号与同步」，连接并确认合并后，在线页面约每 15 秒自动同步一次，也可点「立即同步」。

## 通过 Cloudflare 网页部署

在 D1 创建数据库 `easysub`，将 Database ID 填入本目录 `wrangler.jsonc` 的 `d1_databases[0].database_id`，保留绑定名 `DB`。在 Workers 和 Pages 中创建或打开 `easysub-worker`，连接此仓库并填写以下构建设置。

| 设置 | 值 |
| --- | --- |
| 生产分支 | `cloudflare-workers` |
| 根目录 | `cloudflare` |
| 构建命令 | `npm run build` |
| 部署命令 | `npx wrangler d1 migrations apply DB --remote && npx wrangler deploy` |
| 构建变量 | `NODE_VERSION=24` |

保存后向生产分支提交一次更改，在 Worker 的「部署」中查看该提交的构建日志。首次部署成功后，在「设置 → 变量和机密」的生产环境添加 `ADMIN_USERNAME`、`ADMIN_PASSWORD` 和 `TOKEN_SECRET`（随机生成，至少 32 个字符），保存并部署参数后登录。Telegram 和邮件可同时配置或稍后启用，参数见下文。

## 通过命令行部署

准备 Node.js 24 和 Cloudflare 账号。从工作目录执行以下命令。已下载源码的用户可直接进入其中的 cloudflare 目录，从 npm ci 开始。Windows PowerShell 也可逐行执行。

```sh
git clone --branch cloudflare-workers https://github.com/wipoman/easysub.git
cd easysub/cloudflare
npm ci
npm run build
npm test
npx wrangler login
npx wrangler d1 create easysub
```

复制创建结果中的数据库 UUID。在本目录的 `wrangler.jsonc` 中，给已有的 `d1_databases[0]` 添加 `"database_id": "你的UUID"`，保留绑定名 `DB`。若 Wrangler 已自动写入，请核对同一绑定只出现一次。接下来执行：

```sh
npx wrangler d1 migrations apply DB --remote
npm run deploy
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put TOKEN_SECRET
```

按提示分别输入自己的登录名、强密码和随机签名密钥。密钥至少 32 个字符，可用 `node -p "require('crypto').randomBytes(32).toString('hex')"` 在自己电脑生成。所有设备共用这一个账号。轮换 TOKEN_SECRET 会注销现有会话。之后升级代码时使用同一数据库和密钥，重新构建、应用新增迁移并部署。

## Telegram 和邮件

在 Cloudflare 控制台打开该 Worker 的「设置 → 变量和机密」，也可以用 `npx wrangler secret put 变量名` 逐项填写。密钥保存在 Worker 端。

| 渠道 | 必填配置 |
| --- | --- |
| Telegram | `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`。私聊请先向机器人发送 /start，发往频道需让机器人拥有发帖权限。 |
| 邮件（Resend HTTPS API） | `RESEND_API_KEY`、`EMAIL_FROM`、`EMAIL_TO`。使用服务允许的发件人和收件人，正式发送可使用已验证域名的发件地址。 |

填好一个渠道即可使用，也可同时开启两个。为有效的周期订阅填写提前提醒天数，例如 `7,3,1,0` 包含到期日。北京时间每天 09:00 扫描，09:15、09:30、09:45 继续处理未确认的投递。每个渠道独立记账。Telegram 已接收但连接中断时，重试可能再次送达。把测试订阅的日期和提前天数设为下一次扫描可命中的组合，即可验证真实收件。首版两种外部渠道用于续费到期提醒。手机本地通知沿用原 APK 的规则。

## 两端验收

1. 在电脑打开部署结果中的 HTTPS 地址，测试连接并确认合并。手机在「账号与同步」填写同一 HTTPS 根地址和账号。已绑定另一实例的手机，请先导出并验证完整备份；原 APK 会阻止已有本地资料库直接绑定另一服务器。
2. 两端先同步一条测试订阅，记下原日期。让 App 进入后台，电脑选择「从原到期日」续费一次，并确认同步成功。手机允许系统通知并开启「后台变更提醒」，稍后应出现变更提示，打开 App 同步后能看到新日期。原 APK 约每 15 分钟后台检查，系统省电可能延后；它会提示变更，打开后才拉取内容。
3. 手机断网后编辑同一条订阅的备注，恢复联网并同步。电脑同步后核对备注。再点两次同步，订阅总数和到期日应保持一致。双方离线修改同一条记录时，App 会保留冲突供选择。
4. 本地回归测试通过项目原版客户端的存储模型、同步引擎和 HTTP 客户端，连接独立的 workerd + D1 测试库。测试模拟了写入成功后回包丢失、重复发送同一操作，并验证提醒渠道失败重试。系统通知栏与真实渠道收件需在部署后验收。

网页使用本地加密资料库，适合在个人电脑使用。首次连接会合并两端已有资料，建议让首批数据从单一设备进入。测试通知、SMTP 和上游多用户管理界面不属于首版 Worker 接口。恢复旧 D1 快照时，先在恢复的数据库将 installation.epoch 换为新 UUID，再让设备按原版流程重新确认资料，防止旧游标被复用。
