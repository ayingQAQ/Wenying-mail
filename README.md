# Wenying mail

面向个人域名的只收邮件项目。基于 [ayingQAQ/cloud-mail](https://github.com/ayingQAQ/cloud-mail) 和原项目 [maillab/cloud-mail](https://github.com/maillab/cloud-mail) 改造，保留 Vue、Hono、Drizzle 与 Cloudflare 存储体系。

邮件进入时先将原始字节与投递信息保存到私有 R2，再异步解析并发布到收件箱。应用支持多个明确创建的收件地址、邮箱切换、搜索、已读与星标、回收站、验证码识别和复制、移动端页面，以及轻量 Android WebView 客户端。Telegram 机器人可按邮箱选择通知范围。邮件发送与公开注册已关闭。

## 架构

- Cloudflare Email Routing 接收入站邮件；独立入口负责精确地址准入和原件持久化。
- 队列与 VPS 处理器执行解析、幂等发布、失败重试和通知；D1 存储索引，R2 存储原件、正文与附件。
- Cloudflare Worker 提供页面入口；受保护的 API 使用应用会话。验证码登录可由 Cloudflare Access 保护回调，亦可使用独立邮局密码。
- 私有正文、附件和原始 EML 仅通过经过授权的接口读取。
- 加密备份与隔离恢复工具包含在 `ops/backup`。它们需要单独配置、演练和启用；本仓库不附带任何生产凭据或备份数据。

## 本地构建

需要 Node.js 24 和 pnpm 11。先进入 `mail-worker` 执行 `pnpm install --frozen-lockfile`，再执行 `pnpm build:vps`；前端在 `mail-vue` 目录执行 `pnpm install --frozen-lockfile` 和 `pnpm build`。Android 客户端源码位于 `android`，需自行配置 Android SDK 与发布签名。

部署前必须创建自己的 Cloudflare 资源、域名、Access 策略、VPS 运行配置和最小权限凭据。不要直接复用示例配置中的域名或资源身份。实际生产环境还需要验证队列、收信故障行为、恢复与备份流程；代码和构建成功本身不代表这些能力已完成验收。

## 来源与许可

此仓库保留上游 Git 历史，遵循原项目的 [MIT License](LICENSE)。感谢上游维护者。
