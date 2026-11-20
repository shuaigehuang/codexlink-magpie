# Changelog

所有重要变更记录在此文件。版本号遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased]

## [1.2.2] - 2026-11-20

### Added

- 新增《云服务器中继：电脑小白部署指南（腾讯云 Ubuntu）》，覆盖安全组放行、
  域名与 HTTPS、架构识别、端口选择、密钥保存、升级、卸载和故障排查。
- 项目主页新增“两种部署方案”对比入口，Cloudflare Workers 和自有 Linux
  服务器的小白教程都可在首页直接进入。
- Linux 中继安装包内置 `GUIDE-ZH.md`，解压后即可查看完整中文部署指南。
- Cloudflare 部署包内置同一份中文指南，并提供交互式安装：可粘贴 API Token、
  可选填写自定义域名，不需要手动设置环境变量。

### Changed

- 电脑端、手机端、Windows 安装包和 Cloudflare 包版本号统一为 1.2.2。
- 手机端构建号同步提升到 12。
- 重新构建全部发布产物，Release 同时包含电脑端、手机端、Linux amd64/arm64、
  Cloudflare、完整源码、小白文档、SBOM 和 SHA256 校验和。

## [1.2.1] - 2026-11-20

### Fixed

- 电脑端不再把中继固定显示为“腾讯云中继”，统一改为“云端中继”，
  自建服务器和 Cloudflare Workers 均适用。
- 手机端 HTTP 明文安全提示改为推荐解析到“中继服务器”，不再限定腾讯云。
- 电脑端侧边栏版本号、手机端“关于”页版本号同步到 1.2.1。

### Changed

- 重新构建 Windows 安装包和 Android APK，版本号 1.2.1。

## [1.2.0] - 2026-11-20

### Added

- 新增 Cloudflare Workers 免费版中继，使用 Workers + D1 + Durable Objects，
  不需要维护 Linux 服务器，自动提供 HTTPS/WSS。
- 新增 `deploy/cloudflare` 一键部署脚本：自动创建 D1、应用迁移、生成配置、
  上传密钥、部署 Worker，并输出管理面板地址和管理密码。
- 新增 Cloudflare 管理面板，支持创建、解绑、删除电脑令牌，查看在线电脑，
  查看并撤销手机授权，复制服务器地址。
- 新增 `--custom-domain`，可在同一个 Cloudflare 账号内自动创建 DNS 记录并
  绑定自定义域名，规避 `workers.dev` 在中国大陆的 DNS 污染。
- 新增 Cloudflare 端到端测试脚本，覆盖配对、手机 WebSocket/HTTP 指令、
  4 MB 文件分片和手机令牌管理。
- 新增旧 Go 中继数据导入脚本，可迁移电脑令牌哈希和手机授权。
- 新增 `deploy/build-cloudflare-package.ps1`，生成可随 Release 发布的
  Cloudflare 一键部署压缩包。

### Changed

- Cloudflare WebSocket 使用 Hibernation，RPC 等待队列持久化到 Durable Object
  存储，并通过 alarm 清理超时请求，避免休眠后丢失指令。
- 部署脚本在健康检查失败时仍保留部署结果，明确提示可能是本地 DNS 无法解析，
  而不是 Worker 部署失败。

### Security

- Cloudflare 中继只保存电脑令牌和手机令牌的 SHA-256 哈希。
- 删除或解绑电脑令牌时同步撤销该电脑关联的手机授权并断开连接。
- 手机只能调用权限白名单内的 Codex 与 Magpie 方法。
- 管理面板使用 HMAC 签名 HttpOnly Cookie 和 CSRF 校验。
- API Token、管理密码、Cookie 密钥和安装状态均不进入 Git。

## [1.1.0] - 2026-11-18

### Added

- Windows 电脑端新增标准 NSIS 安装包，安装时可选择目录，自动创建开始菜单和桌面快捷方式，并注册到 Windows“设置 → 应用”卸载列表。
- 新增 `deploy/build-windows-installer.ps1`，统一生成版本化 Windows 安装包和 SHA256 校验值。
- 手机端会话输入框新增系统文件选择与分块上传，文件经中继传到电脑 `下载\CodexLink`，支持把保存路径带入当前会话。
- Linux 交互式安装会分别询问 Web 管理面板端口和电脑/手机中转服务端口，并检查无效端口、重复端口和已占用端口。
- 中继新增 `CODEXLINK_RELAY_ADMIN_LISTEN`，管理后台可以使用独立监听端口。
- 安装脚本新增 `--admin-port`、`--relay-port` 参数，支持非交互指定两个端口。

### Changed

- 管理后台路由与中转路由完全分离；中转端口不再暴露 `/admin` 登录页。
- 域名 HTTPS 模式下两个端口共用自动申请的证书；HTTP 模式继续明确提示明文风险并推荐域名登录。
- 安装脚本会自动为新端口写入 UFW/firewalld 规则，并分别做中转与管理面板健康检查。

### Security

- 文件上传按 `4 MB` 分块，单文件上限 `100 MB`；电脑端校验分块顺序、完整大小并清洗文件名，服务器不持久化文件内容。
- 管理密码和令牌管理接口只监听管理面板端口，减少中转端口的暴露面。
- 域名 HTTPS 模式下 80 端口只处理 ACME 验证并 308 跳转 HTTPS，不再回落到明文 RPC；HTTPS 响应增加 HSTS。
- 只有显式设置 `CODEXLINK_RELAY_TRUST_PROXY=true` 时才信任 `X-Forwarded-Proto`；`/healthz` 不再暴露在线设备数量。
- 手机令牌新增 `read`、`chat`、`files`、`magpie-admin` 权限分级，配对时默认只读；旧令牌自动降为只读。
- 电脑端令牌首次连接绑定设备 ID，其他设备复用会返回 `403 device_mismatch`；管理后台支持解除绑定。
- 更换 `CODEXLINK_RELAY_DESKTOP_TOKEN` 时自动替换安装令牌并清除旧绑定。
- Magpie 管理 API 只允许本机地址，禁用 HTTP 代理和重定向。
- 文件上传目录增加 `1 GiB` 总计配额，同时最多 4 个上传任务。
- Android 关闭自动备份；Release 构建必须配置签名。HTTP 明文模式继续兼容，但 App 会持续显示未加密风险提示。
- Windows 安装包支持 Authenticode 签名，`CODEXLINK_REQUIRE_SIGNATURE=1` 时缺少证书会构建失败；卸载时清理本地加密配置。

## [1.0.8] - 2026-11-14

### Added

- 手机端会话详情显示 Codex 的“思考过程”，思考块会随电脑端生成约每 0.5 秒更新。
- 正在进行的思考默认展开，完成后自动折叠；点击“思考过程”可随时展开或收起。

### Changed

- 电脑端只对最近轮次读取完整条目，历史会话仍使用轻量摘要，避免拖慢长会话打开速度。
- 同步只返回新增、未完成或刚完成的内容，不再重复传输整轮历史。

## [1.0.7] - 2026-11-14

### Fixed

- 手机端会话详情改为增量实时同步，电脑端回复生成过程中即可持续显示，无需退出后重新进入。
- 正在生成的轮次会整轮同步，避免较早创建的消息条目被时间过滤而停留在半截内容。
- 网络重连或 App 回到前台时自动完整刷新一次，防止离线期间的增量遗漏。

### Changed

- 手机端同步间隔缩短到约 0.5 秒，并在 App 进入后台时暂停同步以节省电量。
- 同步时只读取最近轮次的变化内容，并按消息 ID 合并更新同一条回复。

## [1.0.6] - 2026-11-13

### Added

- 服务器管理后台：查看在线设备与公开连接地址，生成和删除电脑端接入令牌。
- 中继支持同时监听 80 和 443 的明文 HTTP 模式，并在界面中明确标注未加密风险。
- 电脑端令牌哈希持久化、在线令牌即时断开、管理会话 CSRF 防护和登录限速。

### Fixed

- 手机指令改为加入 Codex 官方会话队列；电脑正在执行任务时不再触发 `active writer` 错误，也不会新开会话。
- 队列中的指令会在当前任务结束后自动使用原会话继续执行。
- 修复超大 Codex RPC 响应读取失败的问题。

### Changed

- 优化会话读取和长命令输出加载速度，手机端默认折叠命令详情。
- 手机端明确提示指令已加入队列以及预计的执行时机。

### Security

- 管理后台和电脑端令牌只保存 SHA-256 哈希，完整令牌仅在创建时显示一次。
- 文档明确说明 `--http-dual` 的 443 端口仍是明文 HTTP，不是 HTTPS。

## [1.0.5] - 2026-11-13

### Added

- Windows 电脑端（Wails 3）：Codex 状态、历史会话、Magpie 管理、设备配对、手机令牌管理。
- Android 手机端（Flutter）：扫码配对、会话列表、会话详情、发送指令、Magpie 密钥管理。
- Linux 中继：一次性配对码、HTTP/WS 双通道、RPC 白名单、手机授权撤销、自动 HTTPS。
- Linux 一体化安装包：systemd 服务、amd64/arm64 构建、HTTP/HTTPS/反向代理三种模式。
- 电脑端关闭窗口后隐藏到系统托盘并保持中继连接。
- 手机端默认折叠命令输出、打开会话定位最新消息、快速回到底部。
- 公开仓库配套：MIT License、CI、Issue/PR 模板、安全策略、贡献指南。

### Security

- 中继只保存手机令牌哈希，电脑端配置使用 Windows DPAPI 加密。
- 撤销手机授权后立即断开对应 WebSocket。
- 日志脱敏，不记录完整 Magpie Provider Key 或网关密钥。
- 文档明确标注 HTTP 明文模式风险，推荐域名 + HTTPS。

### Changed

- Go 模块路径统一为 `github.com/shuaigehuang/codexlink`。
- 手机端不再内置任何服务器地址，必须扫码或手动填写。
- 文档和测试中的真实服务器地址替换为 RFC 5737 示例地址。

## [1.0.0] - 2026-11-12

- 首个可运行版本，完成 Codex app-server、Magpie、Wails 桌面端和 Linux 中继的端到端验证。
