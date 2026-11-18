# 第六步：Linux 中继与远程配对

## 目标

让手机通过一台公网 Linux 服务器连接自己的 Windows 电脑，同时满足：

- 手机不直接暴露电脑端口。
- 电脑端只需主动连接中继。
- 手机使用一次性配对码换取长期令牌。
- 中继只转发白名单 RPC，不保存对话内容。
- 电脑端可以查看并撤销手机授权。

## 组件

```text
Android App  ──HTTPS/WSS──▶  Linux Relay  ◀──WSS──  Windows Desktop
                                                   │
                                                   ├── Codex app-server
                                                   └── Magpie gateway
```

中继入口位于 `cmd/codexlink-relay`，协议和存储在 `internal/relay`。

## 配对流程

1. 电脑端用 `CODEXLINK_RELAY_DESKTOP_TOKEN` 连接 `/v1/desktop/connect`。
2. 电脑端发送 `pair.create`，中继生成 8 位一次性配对码，默认 10 分钟有效。
3. 手机向 `/v1/pair/claim` 提交配对码和手机名称。
4. 中继确认电脑在线后生成 32 字节随机令牌，只保存 SHA-256 哈希。
5. 手机把令牌保存在系统安全存储，后续通过 HTTP 或 WebSocket RPC 访问。

配对码只允许成功领取一次；同一 IP 在 10 分钟内最多尝试 10 次。

## RPC 白名单

手机请求先到中继，再由电脑端连接下发。中继只接受以下方法：

```text
ping
node.status
threads.list
threads.read
threads.send
files.begin
files.chunk
files.finish
files.cancel
magpie.status
magpie.admin.status
magpie.admin.initialize
magpie.keys.create
magpie.keys.rotate
magpie.keys.toggle
magpie.keys.delete
```

新增能力时必须同时修改中继白名单和电脑端分发逻辑，避免手机获得任意方法调用能力。

文件上传使用四个方法完成：`files.begin` 声明文件名和大小，`files.chunk` 按顺序发送
Base64 分块（每块最多 4 MB），`files.finish` 校验完整性并落盘，`files.cancel` 清理
未完成的上传。单文件上限 100 MB。中继只转发分块，不在服务器持久化文件；电脑端保存到
用户下载目录下的 `CodexLink` 文件夹，并清洗客户端提供的文件名。

### 手机令牌权限

手机令牌按最小权限分级，服务端在 WebSocket 和 HTTP RPC 两条通道上都会校验：

| 权限 | 方法 |
| --- | --- |
| `read` | `ping`、`node.status`、`threads.list`、`threads.read`、`magpie.status`、`magpie.admin.status` |
| `chat` | `threads.send` |
| `files` | `files.begin`、`files.chunk`、`files.finish`、`files.cancel` |
| `magpie-admin` | `magpie.admin.initialize`、`magpie.keys.create`、`magpie.keys.rotate`、`magpie.keys.toggle`、`magpie.keys.delete` |

`read` 会始终包含在令牌中。新配对默认只授予 `read`，电脑端配对页必须显式勾选写权限。
旧版本创建的手机令牌在升级后自动迁移为只读，避免历史令牌保留过大的权限。

### 电脑端令牌与设备绑定

电脑端令牌首次成功连接时会原子绑定设备 ID。之后其他设备使用同一令牌会收到
`403 device_mismatch`，必须由管理后台解除绑定或重新签发令牌。更换
`CODEXLINK_RELAY_DESKTOP_TOKEN` 时，中继会自动替换安装令牌并清除旧绑定，
旧密钥立即失效。

### 传输层加固

- 域名 HTTPS 模式下，TCP 80 只处理 ACME HTTP-01 验证和 308 跳转到 HTTPS，
  其他请求不会回落到明文 RPC。
- HTTPS 响应设置 HSTS。只有显式设置 `CODEXLINK_RELAY_TRUST_PROXY=true` 时才信任
  `X-Forwarded-Proto`，避免伪造协议头绕过安全 Cookie 判断。该选项只应在反向代理
  会覆盖客户端请求头的部署中启用；中继直接暴露时保持默认 `false`。
- `/healthz` 只返回健康状态，不暴露在线设备数量。
- 管理后台的 Cookie、安全警告和跳转地址统一使用同一套 HTTPS 判断。

## 会话存储

中继数据目录默认是 `/var/lib/codexlink-relay`：

```text
sessions.json   手机令牌哈希、设备 ID、授权时间和到期时间
autocert/       Let's Encrypt 证书缓存（HTTPS 模式）
```

`sessions.json` 权限为 `0600`，不包含令牌原文。旧版本没有 `sessionId` 或 `createdAt` 的记录会自动迁移。

## 手机授权管理

电脑端通过电脑端密钥调用：

```text
GET  /v1/desktop/sessions?device=<device-id>
POST /v1/desktop/sessions/revoke
```

撤销请求必须带当前电脑的 `deviceId`，不能操作其他电脑的手机授权。撤销后中继会立即关闭对应 WebSocket，并把新的授权数量推送给电脑端。

## 部署模式

### 自动 HTTPS（推荐）

```bash
sudo bash ./install.sh --domain relay.example.com --email you@example.com
```

需要域名已解析到服务器，并放行 TCP 80/443。中继使用 ACME 自动申请和续期证书，最低 TLS 1.2。
交互安装会分别询问 Web 管理面板端口和中转服务端口，常见配置是管理面板 `8443`、
中转服务 `443`。两个端口都会使用同一张自动申请的域名证书；TCP 80 仍只用于证书验证和跳转。

### 公网 IP 明文（仅测试）

```bash
sudo bash ./install.sh --http-public YOUR_SERVER_IP
```

该模式默认在中转服务端口 TCP 80 和 Web 管理面板端口 TCP 8080 上提供明文 HTTP，
不提供加密。电脑端密钥、管理密码、会话内容、指令和 Magpie 管理结果都可能被中间人截获。
不要在生产环境或公共 Wi-Fi 下使用。

### 本机反向代理

```bash
sudo bash ./install.sh --http-only
```

中继默认监听 `127.0.0.1:8787`，管理面板默认监听 `127.0.0.1:8080`，
由 Nginx/Caddy 或 SSH 隧道对外提供 HTTPS。参考 `deploy/Caddyfile.example`。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODEXLINK_RELAY_DESKTOP_TOKEN` | 无 | 电脑端密钥，至少 32 字符 |
| `CODEXLINK_RELAY_DATA_DIR` | `./data` | 数据目录 |
| `CODEXLINK_RELAY_LISTEN` | `127.0.0.1:8787` | 电脑/手机中转服务监听地址 |
| `CODEXLINK_RELAY_ADMIN_LISTEN` | 空 | Web 管理面板独立监听地址；留空时与中转共用端口 |
| `CODEXLINK_RELAY_PAIR_TTL` | `10m` | 配对码有效期 |
| `CODEXLINK_RELAY_SESSION_TTL` | `2160h` | 手机令牌有效期 |
| `CODEXLINK_RELAY_TRUST_PROXY` | `false` | 是否信任反向代理写入的客户端 IP 和协议头；仅限受信任代理 |
| `CODEXLINK_RELAY_ORIGINS` | 空 | 允许的 WebSocket Origin |
| `CODEXLINK_RELAY_TLS_DOMAIN` | 空 | 自动 HTTPS 域名 |
| `CODEXLINK_RELAY_TLS_EMAIL` | 空 | ACME 邮箱 |
| `CODEXLINK_RELAY_HTTP_ADDR` | `:80` | HTTP 监听地址 |

敏感配置位于 `/etc/codexlink-relay.env`，权限 `0600`。不要提交到仓库、写入日志或发送到聊天中。

## 验证

```bash
curl -fsS https://relay.example.com/healthz
systemctl status codexlink-relay
journalctl -u codexlink-relay -n 50 --no-pager
```

健康检查返回 `ok=true`、`service=codexlink-relay`、当前在线电脑数和手机数。

## 测试覆盖

中继测试覆盖：

- 健康检查和错误电脑端密钥拒绝。
- 配对成功、重复领取失败、过期失败和限流。
- 电脑离线时返回 `desktop_offline`。
- 手机 RPC 白名单和请求/响应关联。
- WebSocket 与 HTTP 两种手机通道。
- 手机授权列表、撤销和旧数据迁移。
- 压缩响应和 Windows 配置落盘回退。

桌面端端到端测试覆盖电脑连接本机中继、生成配对码、手机领取令牌、发送 `ping` 并收到 `pong`。

## 运维

```bash
systemctl restart codexlink-relay
journalctl -u codexlink-relay -f
```

升级时重新解压安装包并执行 `install.sh`。脚本会保留现有 `/etc/codexlink-relay.env` 中的电脑端密钥，并强制重启服务，避免旧进程继续运行。
升级后安装脚本会提示两个端口；直接回车会优先沿用当前环境文件中的端口。中转端口和管理面板端口不能相同。
