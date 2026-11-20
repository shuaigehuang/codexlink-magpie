# CodexLink Cloudflare Workers 中继

把 CodexLink 的 Go 中继迁移到 Cloudflare Workers + D1，使用 Workers 免费版。
电脑端和手机端仍使用原有协议，只需把中继地址改成 Worker 地址。

## 免费版资源

- Workers：每天 100,000 个请求
- Durable Objects：有每日免费额度，使用 SQLite 存储后端
- D1：5 GB 总存储，按日限量读取/写入
- WebSocket：Cloudflare 自动提供 WSS，无需自备证书
- 不创建付费套餐、不绑定付费域名、不产生 Cloudflare 费用

免费额度耗尽后服务会暂时返回错误，次日 UTC 0 点恢复。个人自用通常远低于这些额度。

## 架构

```text
Android 手机  ──HTTPS / WSS──┐
                             ├── Cloudflare Worker
Windows 电脑 ──WSS───────────┘        │
                                      ├── D1：电脑令牌、手机授权、配对码
                                      └── Durable Object：在线连接与 RPC 转发
```

Worker 只转发白名单方法，不读取 Codex 对话内容。电脑端始终是实际执行边界。

## 一键部署

### 准备

1. Node.js 20 或更高版本。
2. Cloudflare 账号，使用 **Workers Free** 套餐。
3. Cloudflare API Token，权限只需要：
   - `Workers Scripts:Edit`
   - `D1:Edit`

在 Cloudflare 控制台创建 Token：

```text
My Profile → API Tokens → Create Token → Custom token
```

### Windows

```powershell
$env:CLOUDFLARE_API_TOKEN = "你的 API Token"
cd D:\codex\codexlink\deploy\cloudflare
.\install.cmd
```

也可以直接双击 `install.cmd`，脚本会读取环境变量，或尝试读取
`environment/cloudflare/api-token.txt`。

### Linux / macOS

```bash
export CLOUDFLARE_API_TOKEN="你的 API Token"
cd codexlink/deploy/cloudflare
node scripts/install.mjs
```

### 自定义参数

```bash
node scripts/install.mjs \
  --worker-name codexlink-relay \
  --db-name codexlink-relay \
  --admin-password "至少12位的管理密码"
```

已绑定自定义域名后：

```bash
node scripts/install.mjs --public-url https://relay.example.com
```

如果域名已经接入同一个 Cloudflare 账号，可以让脚本自动创建 DNS 记录并绑定：

```bash
node scripts/install.mjs --custom-domain relay.example.com
```

自动绑定需要 Token 额外拥有 `Zone → Zone:Read`。脚本只会操作你传入的
这个主机名，不会修改其他 DNS 记录。

脚本会自动：

1. 读取或创建 D1 数据库（不会修改账号中的其他数据库）。
2. 生成 `wrangler.toml`。
3. 应用数据库迁移。
4. 上传 `ADMIN_TOKEN` 与 `COOKIE_SECRET` 两个 Worker Secret。
5. 部署 Worker。
6. 检查 `/healthz` 和 `/admin`。
7. 将管理密码写入本目录的 `.admin-password`。

如果部署成功但本机健康检查失败，脚本仍会保留部署结果并给出提示，
不会把已经创建好的 D1 或 Worker 回滚。可以稍后重新运行，或加上
`--skip-check` 跳过检查。

部署完成后终端会打印：

```text
服务器地址: https://codexlink-relay.<子域>.workers.dev
管理面板:   https://codexlink-relay.<子域>.workers.dev/admin
```

`.admin-password`、`.install-state.json`、`wrangler.toml`、`.secrets.json`
都已在 `.gitignore` 中排除，不会进入 Git。

## 配置电脑端

1. 打开管理面板，登录后创建一个“电脑令牌”。
2. 令牌只显示一次，立即复制。
3. 在电脑端 CodexLink 的“云端中继”中填写：
   - 中继地址：`https://codexlink-relay.<子域>.workers.dev`
   - 电脑端密钥：刚才创建的令牌
4. 保存后等待显示“已连接”。
5. 点击“生成配对码”，手机扫码或输入 8 位配对码。

Cloudflare Worker 会自动使用 HTTPS/WSS。请不要把地址改成 `http://`，
也不要在第三方页面或聊天工具中公开令牌。

## 管理面板

管理面板支持：

- 创建、解绑、删除电脑令牌
- 查看电脑在线状态与最近使用时间
- 查看所有手机授权及在线状态
- 单个撤销或全部撤销手机授权
- 复制服务器地址

删除或解绑电脑令牌时，服务器会同时撤销该电脑关联的手机授权并断开连接。

## 自定义域名

Workers 默认域名 `*.workers.dev` 在中国大陆网络下经常出现 DNS 污染，
同一台电脑可能解析到不同 IP，表现为“有时能连、有时一直连接中”。
正式长期使用建议：

1. 将一个已接入 Cloudflare 的域名绑定到 Worker：

   ```bash
   node scripts/install.mjs --custom-domain relay.example.com
   ```

2. 等待 Cloudflare 自动签发证书（通常 1–3 分钟）。
3. 打开 `https://relay.example.com/healthz` 确认返回 `ok`。
4. 电脑端和手机端都改用这个自定义域名，不要继续使用 `workers.dev`。

自定义域名同样走 Cloudflare 免费代理，不需要购买证书或付费套餐。
如果域名本身没有备案，仅用于 API/WebSocket 中转通常可以工作，但请遵守
当地法规和 Cloudflare 服务条款。

## 中国大陆网络建议

- 优先使用自定义域名，不要依赖 `workers.dev`。
- 如果自定义域名仍然不稳定，可在电脑端和手机端配置同一个可用的
  Cloudflare 优选 IP 的 hosts 记录；不建议在公开文档中写死 IP。
- 电脑端必须保持在线，手机才能转发指令；Cloudflare 只负责中转，不执行 Codex。

## 安全说明

- Cloudflare Worker 不接受明文生产部署；浏览器和客户端均使用 HTTPS/WSS。
- 电脑令牌只保存 SHA-256 哈希，服务器不保存明文令牌。
- 手机令牌也以哈希形式存放在 D1。
- 管理登录使用 HMAC 签名的 HttpOnly Cookie，并校验 CSRF Token。
- 配对码 10 分钟有效，只能领取一次；同一 IP 10 分钟内最多尝试 10 次。
- 手机只能调用 `read`、`chat`、`files`、`magpie-admin` 权限范围内的白名单方法。
- 电脑端令牌首次连接后会绑定设备 ID，防止同一令牌在另一台设备上冒用。
- Worker 不保存 Codex 对话正文；消息只在在线连接中转发。

## 从旧 Go 中继迁移

复制旧服务器的 `sessions.json` 与 `desktop_tokens.json` 到
`deploy/cloudflare/import-data/`，然后执行：

```bash
npm run import-go-data -- --dry-run
npm run import-go-data
```

脚本会保留原有电脑令牌哈希和手机授权，不需要让手机重新扫码。
Token 文件本身无法迁移，因为 Go 中继只保存哈希；如果旧令牌仍可用，
迁移后可直接继续使用原令牌。

## 验证

```bash
cd deploy/cloudflare
npm install
npm run typecheck
npm run smoke
```

`smoke` 会真实走一遍：

1. 健康检查
2. 管理面板登录
3. 创建电脑令牌
4. 电脑端 WebSocket
5. 生成并领取配对码
6. 手机 WebSocket 指令
7. 手机 HTTP 指令
8. 4 MB 文件分片转发
9. 手机令牌管理

测试结束后会自动删除测试令牌。

## 常见问题

### 手机一直显示连接中

先打开 `https://你的地址/healthz`，应返回：

```json
{"ok":true,"service":"codexlink-relay","runtime":"cloudflare-workers"}
```

然后检查电脑端是否显示“已连接”。电脑离线时手机可以连接服务器，
但不能发送指令。

如果 `/healthz` 在浏览器能打开、但 Node 或手机打不开，通常是
`workers.dev` 的 DNS 被污染。绑定自定义域名后重新部署即可。

### 手机发送指令失败

确认手机配对时授予了 `chat` 权限；旧配对码权限不足时，需要电脑端重新生成配对码。

### 更新代码后重新部署

```bash
cd deploy/cloudflare
npm run install-relay
```

脚本会复用原有 D1 数据库、管理密码和 Cookie 密钥。

### 查看当前部署信息

```bash
cat .install-state.json
```

该文件只保存在本机，包含账号 ID、D1 ID 和当前访问地址，不会进入 Git。

### 重新生成管理密码

```bash
node scripts/install.mjs --reset-admin-password
```

## 目录

```text
deploy/cloudflare/
├── migrations/            D1 表结构
├── scripts/
│   ├── install.mjs        一键部署
│   ├── smoke.mjs          端到端测试
│   └── import-go-data.mjs 旧数据迁移
├── src/
│   ├── index.ts           HTTP 路由、鉴权、管理 API
│   ├── device-room.ts     Durable Object 与 RPC 转发
│   ├── protocol.ts        协议常量与白名单
│   ├── rate-limiter.ts    配对/登录限流
│   └── admin-page.ts      管理面板
├── install.cmd
├── install.sh
└── wrangler.toml.template
```
