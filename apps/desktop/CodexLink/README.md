# CodexLink Desktop

Windows 电脑端，使用 Go + Wails 3 构建。

## 职责

- 启动并连接本机 Codex `app-server`。
- 读取历史会话、轮次和消息。
- 在已有会话中发送指令，处理 Codex 的单写入者限制。
- 读取 Magpie 状态并管理 Provider / 网关密钥。
- 连接云端中继，生成一次性配对码，管理手机授权。
- 使用 Windows DPAPI 加密保存中继地址、电脑端密钥和设备 ID。

## 开发

```powershell
go install github.com/wailsapp/wails/v3/cmd/wails3@latest
cd apps/desktop/CodexLink
wails3 task common:generate:bindings
wails3 dev
```

## 构建

```powershell
wails3 build
```

产物位于 `bin/`。

生成可选择安装目录、注册到 Windows“设置 → 应用”的安装包：

```powershell
pwsh ../../../deploy/build-windows-installer.ps1
```

正式发布需要 Authenticode 签名证书，设置 `CODEXLINK_SIGN_PFX` +
`CODEXLINK_SIGN_PFX_PASSWORD` 或 `CODEXLINK_SIGN_CERT_SHA1`；发布流水线同时设置
`CODEXLINK_REQUIRE_SIGNATURE=1`，缺少证书时构建会失败。

## 测试

```powershell
go test ./... -count=1
go vet ./...
```

## 配置

| 环境变量 | 说明 |
| --- | --- |
| `CODEX_CLI_PATH` | 指定 `codex.exe` 路径；留空时自动搜索 |

应用配置保存在 `%APPDATA%\CodexLink`。中继配置使用 DPAPI 加密，关闭窗口后的运行选项保存在 `settings.json`。

## 安全

- 不要提交 `relay.dat`、`settings.json` 或任何真实密钥。
- HTTP 中继模式为明文传输，界面会显示风险提示。
- 中继地址和电脑端密钥使用 Windows DPAPI 加密，绑定当前 Windows 用户。
- 每个电脑端令牌首次连接后会绑定一台设备；其他设备复用同一令牌会被拒绝。管理后台可解除绑定后重新接入。
- 手机令牌按 `read`、`chat`、`files`、`magpie-admin` 分级；配对时默认只授予只读，写操作需要显式勾选。
- 文件上传保存到 `下载\CodexLink`，单文件最多 `100 MB`，上传目录总计最多 `1 GiB`；超出后需要先清理旧文件。
- Magpie 管理 API 只允许本机回环地址或本机网卡地址，并使用禁用代理和重定向的 HTTP 客户端。
- 撤销手机授权只会删除中继上的手机令牌，不会修改 Codex 历史或 Magpie 配置。
- 卸载程序会删除 `%APPDATA%\CodexLink` 下的 `relay.dat`、`credentials.dat` 和 `settings.json`，不会触碰 Codex 历史或 Magpie 数据。
