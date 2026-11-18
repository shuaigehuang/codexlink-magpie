# CodexLink Mobile

Android 手机端，使用 Flutter 构建。

## 功能

- 扫描电脑端二维码或手动输入中继地址和配对码。
- 查看 Codex 历史会话与消息。
- 在已有会话中发送指令。
- 从系统文件选择器选择文件，经中继分块上传到电脑 `下载\CodexLink`，并可在当前会话中引用保存路径。
- 查看 Magpie 状态、Provider、余额和网关密钥。
- 创建、轮换、启停和删除 Magpie 网关密钥。
- 命令输出默认折叠，打开会话自动定位最新消息，支持快速回到底部。

## 开发

```bash
cd apps/mobile
flutter pub get
flutter analyze
flutter test
flutter run
```

## 构建 APK

```bash
flutter build apk --release
```

产物位于 `build/app/outputs/flutter-apk/app-release.apk`。

## 配置

手机端不内置任何服务器地址。首次使用时必须扫码或手动填写自己的中继地址。

手机令牌使用 `flutter_secure_storage` 保存在系统安全存储中，默认 90 天有效。解除配对只清除本机令牌，不会删除服务端记录；需要让令牌立即失效时，请在电脑端“已授权手机”面板撤销。

## 安全

HTTP 明文模式会在配对页和状态页显示警告。正式使用请配置域名和 HTTPS。
为兼容自建服务器，Release 构建仍允许 HTTP 明文连接；明文模式下会话、指令、
上传文件和密钥都可能被中间人截获。

文件上传单文件上限为 `100 MB`，每块 `4 MB`。上传完成后文件已经保存在电脑上；点击“从待发送中移除”只会取消引用，不会删除电脑上的文件。

手机令牌按 `read`、`chat`、`files`、`magpie-admin` 分级授权，新配对默认只有只读权限。
需要在电脑端配对时显式勾选发送指令、上传文件或 Magpie 管理权限。升级后旧令牌会降为只读，
如果无法发送指令，请让电脑端重新生成配对码并重新配对。

应用已关闭 Android 自动备份，避免令牌被备份到云端。发布 APK 必须使用正式签名：

```bash
cp android/key.properties.example android/key.properties
# 填写 keystore 路径、别名和密码后：
flutter build apk --release
```

也可以通过 `CODEXLINK_ANDROID_STORE_FILE`、`CODEXLINK_ANDROID_STORE_PASSWORD`、
`CODEXLINK_ANDROID_KEY_ALIAS`、`CODEXLINK_ANDROID_KEY_PASSWORD` 提供签名信息。
缺少签名时 Release 构建会明确失败，不会生成可被替换的未签名安装包。
