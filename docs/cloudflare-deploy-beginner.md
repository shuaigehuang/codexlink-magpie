# Cloudflare Workers 中继：电脑小白部署指南

这份文档只做一件事：**让你用自己的 Cloudflare 账号，免费部署一个 CodexLink 中继**，让手机可以远程查看和继续电脑上的 Codex 会话。

不需要买服务器，不需要会编程；域名备案请按当地法规办理。照着做，大约 15–30 分钟。

> 本文以 Windows 10/11 为例。Linux 和 macOS 的差异会在对应步骤单独说明。

---

## 最短路径

如果你不想看长文，先按这 9 步做：

1. 注册 Cloudflare 账号。
2. 创建一个 API Token，复制下来。
3. 安装 Node.js（LTS 版本）。
4. 从 Releases 下载 `codexlink-cloudflare-*.zip` 并解压。
5. 双击 `install.cmd`，粘贴 Token，按回车。
6. 保存屏幕上显示的**服务器地址、管理面板、管理密码**。
7. 打开管理面板，创建一个“电脑令牌”。
8. 在电脑端 CodexLink 填写服务器地址和电脑令牌。
9. 电脑端生成配对码，手机扫码。

没有域名时，第 5 步的域名提示直接按回车即可。但中国大陆网络强烈建议使用自己的域名，原因见第 3 节。

---

## 1. 先弄清楚几个词

| 名词 | 用大白话解释 |
| --- | --- |
| 中继服务器 | 手机和电脑之间的中转站。手机不直接连你家网络，而是连中继，中继再把指令转给电脑。 |
| Cloudflare Worker | Cloudflare 提供的一段免费小程序，我们用它当中继服务器。 |
| D1 | Cloudflare 提供的免费数据库，用来存电脑令牌、手机授权和配对码。 |
| API Token | 你给部署脚本的一次性授权，让它能替你创建 Worker 和数据库。 |
| 电脑令牌 | 电脑连接中继时用的密码。 |
| 配对码 | 手机连接电脑时用的一次性 8 位码，10 分钟内有效。 |

部署完成后，数据流是这样的：

```text
手机  ──HTTPS/WSS──┐
                    ├── Cloudflare Worker ── 你的电脑
电脑  ──WSS────────┘          │
                               ├── D1：令牌和授权
                               └── Durable Object：转发指令
```

Cloudflare 只负责转发，真正执行 Codex 的还是你的电脑。电脑关机或 CodexLink 没开，手机就连不上。

---

## 2. 注册 Cloudflare 账号

1. 打开 <https://dash.cloudflare.com/sign-up>
2. 输入邮箱和密码，点击注册。
3. 去邮箱点验证链接。
4. 登录后如果让你选套餐，选择 **Free（免费）**。

不需要绑定信用卡，不要升级到付费套餐。

---

## 3. 准备一个域名（强烈建议）

### 3.1 为什么需要域名

Cloudflare 默认给你一个 `*.workers.dev` 地址。这个地址在中国大陆经常被 DNS 污染，表现为：

- 电脑一会儿能连、一会儿不能连；
- 手机一直显示“连接中”；
- 同一台设备两次解析到不同 IP。

绑定自己的域名后，稳定性会好很多。域名只用于 API 和 WebSocket 中转，不需要额外买服务器。

### 3.2 已经有域名

1. 登录 Cloudflare，点击 **Add a site / 添加站点**。
2. 输入你的域名，例如 `example.com`，选择 **Free**。
3. Cloudflare 会给你两个 Nameserver（名称服务器），例如：

   ```text
   xxx.ns.cloudflare.com
   yyy.ns.cloudflare.com
   ```

4. 去你买域名的地方（阿里云、腾讯云、Namecheap、Spaceship 等），把域名的 DNS 服务器改成这两个。
5. 回到 Cloudflare，等待状态变成 **Active / 已激活**。通常几分钟到 24 小时。

### 3.3 没有域名

可以先用 `workers.dev` 测试。部署时域名提示直接按回车。

如果手机始终连不上，再回来买一个便宜域名并绑定。不要因为 `workers.dev` 不稳定就认为整个方案不能用。

> 域名是否需要备案、能否长期使用，请遵守你所在地区的法律法规和 Cloudflare 服务条款。本文只讨论技术部署。

---

## 4. 创建 Cloudflare API Token

这一步只做一次。Token 相当于部署脚本的临时钥匙。

1. 打开 <https://dash.cloudflare.com/profile/api-tokens>
2. 点击 **Create Token / 创建令牌**。
3. 选择 **Create Custom Token / 创建自定义令牌**。
4. 名称填：`codexlink-deploy`
5. 在 **Permissions / 权限** 里添加三条：

   | 类型 | 资源 | 权限 |
   | --- | --- | --- |
   | Account / 账户 | Workers Scripts | Edit / 编辑 |
   | Account / 账户 | D1 | Edit / 编辑 |
   | Zone / 区域 | Zone | Read / 读取 |

   第三条只有在你需要自动绑定自定义域名时才必须。没有域名可以不加。

6. **Account Resources / 账户资源**：选择 `Include / 包括`，再选你的账号。
7. 如果你加了 Zone 权限，**Zone Resources / 区域资源** 选择 `Include / 包括` → `Specific zone / 特定区域` → 你的域名。
8. TTL 留空。
9. 点击 **Continue to summary / 继续** → **Create Token / 创建令牌**。
10. 复制生成的 Token。

> Token 只显示一次。不要发到群里，不要截图，不要提交到 GitHub。丢了就重新创建一个。

Token 长这样（只是示例，不是真实 Token）：

```text
AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-Ab
```

---

## 5. 安装 Node.js

部署脚本需要 Node.js 才能运行 Wrangler。

1. 打开 <https://nodejs.org/en/download>
2. 选择 **LTS** 版本的 **Windows Installer (.msi)**。
3. 双击安装，全部点“下一步”。
4. 确认安装选项里勾选了 **Add to PATH**（默认就是勾选的）。
5. 安装完成后，按 `Win + R`，输入 `cmd`，回车。
6. 在黑色窗口里输入：

   ```bat
   node -v
   ```

   应该显示 `v20.x.x` 或更高版本，例如：

   ```text
   v22.14.0
   ```

如果提示 `'node' 不是内部或外部命令`：

- 先重启电脑再试；
- 还不行就卸载 Node.js，重新安装并确认勾选 Add to PATH。

Linux / macOS 用户可以用包管理器安装 Node.js 20+，例如 `brew install node` 或 `sudo apt install nodejs npm`。

---

## 6. 下载并解压 Cloudflare 部署包

1. 打开项目的 Releases 页面：

   <https://github.com/shuaigehuang/codexlink-magpie/releases>

2. 找到最新版本，例如 `v1.2.2`。
3. 下载 **Cloudflare 专用包**，文件名类似：

   ```text
   codexlink-cloudflare-1.2.2.zip
   ```

   不要下载 Linux 服务器的 `codexlink-relay-linux-*.tar.gz`，那是另一种方案。

4. 右键压缩包 → **全部解压缩 / Extract All**。
5. 解压到一个简单路径，例如：

   ```text
   D:\CodexLink-Cloudflare
   ```

   不要放在 `C:\Program Files`，也不要直接在压缩包里双击运行。

6. 打开文件夹，应该能看到：

   ```text
   install.cmd
   install.sh
   scripts\
   src\
   migrations\
   README.md
   ```

---

## 7. 一键部署

### 7.1 双击运行

双击 `install.cmd`。如果 Windows 弹出 SmartScreen：

1. 点击 **更多信息 / More info**。
2. 点击 **仍要运行 / Run anyway**。

### 7.2 粘贴 Token

窗口会显示：

```text
第一次部署需要 Cloudflare API Token。
请粘贴 Cloudflare API Token（输入时不会显示）:
```

在窗口里点鼠标右键即可粘贴（Windows 控制台支持右键粘贴）。输入时不会显示字符，只会显示 `*`，这是正常的。

粘贴后按回车。

### 7.3 填写域名（可选）

接着会显示：

```text
可选：输入已接入 Cloudflare 的域名（如 relay.example.com），直接回车跳过:
```

- 有域名：输入一个子域名，例如 `relay.example.com`，回车。脚本会自动创建 DNS 记录并绑定 Worker。
- 没域名：直接回车，使用 `workers.dev` 地址。

> 域名必须已经接入**同一个 Cloudflare 账号**并处于 Active 状态。否则绑定会失败，脚本会提示并继续使用 `workers.dev`。

### 7.4 等待完成

脚本会自动：

1. 创建或复用 D1 数据库 `codexlink-relay`；
2. 应用数据库表结构；
3. 上传管理密码和 Cookie 密钥；
4. 部署 Worker；
5. 检查 `/healthz` 和管理面板。

通常 1–3 分钟。成功后会显示：

```text
============================================================
 CodexLink Cloudflare 中继部署完成
============================================================
 服务器地址: https://relay.example.com
 管理面板:   https://relay.example.com/admin
 管理密码:   xxxxxxxxxxxxxxxxxxxxxxxx
 密码文件:   D:\CodexLink-Cloudflare\.admin-password
============================================================
```

**立刻做三件事：**

1. 把“服务器地址”复制到记事本。
2. 把“管理面板”复制到记事本。
3. 把“管理密码”复制到记事本。

不要把这三个东西发到公开聊天。密码也会保存在文件夹里的 `.admin-password`，但文件夹删了就没了。

### 7.5 如果窗口一闪而过

不要双击，改用：

1. 在文件夹空白处按住 `Shift` + 鼠标右键。
2. 选择 **在此处打开 PowerShell 窗口 / 在终端中打开**。
3. 输入：

   ```powershell
   .\install.cmd
   ```

这样出错时窗口不会立刻关闭，可以看到完整错误。

---

## 8. 登录管理面板，创建电脑令牌

1. 浏览器打开第 7 步显示的**管理面板**地址，例如：

   ```text
   https://relay.example.com/admin
   ```

2. 输入管理密码，点击登录。
3. 在“电脑令牌”区域，名称填 `我的电脑`，点击 **创建令牌**。
4. 页面会显示一串新令牌，例如：

   ```text
   新令牌（只显示一次，请立即保存）：
   xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

5. 立刻复制这串令牌。

如果没复制就关掉了页面，不用慌：删除这个令牌，重新创建一个即可。

管理面板还能看到：

- 哪台电脑在线；
- 哪些手机已授权；
- 每台手机的权限和到期时间；
- 撤销某台手机、解绑或删除电脑令牌。

---

## 9. 配置电脑端 CodexLink

1. 安装 Windows 安装包 `CodexLink-Setup-*.exe`。
2. 先打开 Codex 桌面版和 Magpie。
3. 打开 CodexLink，进入 **设备配对**。
4. 在“云端中继”区域填写：

   | 字段 | 填写内容 |
   | --- | --- |
   | 中继地址 | 第 7 步的服务器地址，必须 `https://` 开头 |
   | 电脑端密钥 | 第 8 步复制的电脑令牌 |
   | 设备名称 | `我的电脑` |

5. 点击 **保存并连接**。
6. 看到 **“云端中继 · 已连接”** 就成功了。

如果显示“重连中”：

- 先等 10–30 秒；
- 检查服务器地址有没有写错；
- 打开 `https://你的地址/healthz`，应返回 `{"ok":true,...}`；
- 如果 `/healthz` 打不开，回到第 12 节排查。

### 设置手机权限

在“设备配对”页勾选手机需要的权限：

- **查看会话**：读取历史会话和 Magpie 状态（默认）。
- **发送指令**：在现有 Codex 会话里继续发消息。
- **上传文件**：手机选择文件，经中继传到电脑。
- **管理 Magpie**：创建、轮换、停用 Magpie 密钥。

不确定就至少勾选“查看会话”和“发送指令”。

然后点击 **生成配对码**。二维码和 8 位配对码会在 10 分钟后失效。

---

## 10. 配置手机端

1. 下载并安装 `codexlink-mobile.apk`。
2. 允许“安装未知应用”。
3. 打开 App。
4. 扫描电脑端的二维码，或手动填写：
   - 服务器地址：`https://你的地址`
   - 配对码：电脑端显示的 8 位码
5. 连接成功后，打开一个会话，发送一条测试消息，例如：

   ```text
   你好，测试一下
   ```

6. 电脑端应该在原会话里继续执行，而不是新建对话。

手机和电脑不需要连同一个 Wi-Fi。手机用 4G/5G 也可以，只要两边都能访问 Cloudflare。

---

## 11. 日常使用

- 电脑必须开机，CodexLink 必须运行，Codex 和 Magpie 要在运行状态。
- 关闭 CodexLink 会让手机断开；重新打开后会自动重连。
- 手机端可以把常用电脑保存为默认连接。
- 管理面板里的“撤销”会让对应手机立刻失去权限，需要重新扫码。
- 电脑令牌第一次连接后会绑定当前设备；换电脑要新建令牌或在管理面板解绑。

### 更新版本

1. 下载新的 Cloudflare 包。
2. 解压覆盖到原文件夹，保留 `.install-state.json` 和 `.admin-password`。
3. 再次双击 `install.cmd`。

脚本会复用原来的 D1 数据库和电脑令牌。如果解压到全新文件夹，数据仍在同一个 D1 里，但会生成新的管理密码，记得保存。

### 删除部署

如果不再使用：

1. Cloudflare 控制台 → **Workers & Pages** → `codexlink-relay` → **Settings** → **Delete**。
2. **Storage & Databases / D1** → `codexlink-relay` → **Delete**。

删除 D1 会丢失所有电脑令牌和手机授权，手机需要重新配对。

---

## 12. 常见问题

| 现象 | 可能原因 | 解决办法 |
| --- | --- | --- |
| `'node' 不是内部或外部命令` | 没装 Node.js，或没加到 PATH | 重装 Node.js LTS，勾选 Add to PATH，重启电脑 |
| `Authentication error` / `401` / `403` | Token 错误或权限不足 | 重新创建 Token，确认 Workers Scripts:Edit、D1:Edit |
| `A database with that name already exists` | 之前部署过 | 正常，脚本会复用；如果继续报错，检查 D1 权限 |
| 域名绑定失败 | 域名不在同一账号，或 Token 没有 Zone:Read | 先把域名接入 Cloudflare，或重新创建带 Zone:Read 的 Token；也可以先用 workers.dev |
| `health check failed` | 域名未激活、DNS 被污染、证书未签发 | 等 1–3 分钟；打开 `/healthz`；换自定义域名 |
| 手机一直显示“连接中” | 电脑离线、地址错误、workers.dev 被污染 | 先确认电脑端显示“已连接”；地址必须 https；换自定义域名 |
| 手机能连但发不出指令 | 配对时没勾“发送指令” | 电脑端重新生成配对码，勾选“发送指令”后重新配对 |
| `thread ... already has an active writer` | 电脑端正在写同一个会话 | 等电脑端当前回复结束，或关闭电脑端输入框后重试 |
| `522` / `1016` | 域名没有正确绑定 Worker | 重新运行安装并填写 `--custom-domain`，检查 DNS 记录 |
| 管理密码忘了 | 没保存 | 打开文件夹里的 `.admin-password`；或重新运行并加 `--reset-admin-password` |
| 免费额度用完 | 请求太多 | 等 UTC 0 点恢复；个人自用通常不会碰到 |

### 还是不行怎么办

按顺序检查：

1. 浏览器打开 `https://你的地址/healthz`，是否返回 `ok`。
2. 打开 `https://你的地址/admin`，管理密码能否登录。
3. 管理面板里“在线电脑”是否为 1。
4. 电脑端是否显示“云端中继 · 已连接”。
5. 手机端服务器地址是否和电脑端完全一致。

把这四步的结果发给维护者，基本就能定位问题。

---

## 13. 免费额度和安全

### 免费额度

Cloudflare 免费版大致提供：

- Workers：每天 100,000 个请求；
- D1：5 GB 存储和每日读写额度；
- Durable Objects：每日免费额度；
- HTTPS/WSS 证书：自动提供。

个人自用通常远低于这些额度。额度用完会暂时报错，次日恢复，不会自动扣费。

### 安全提醒

- 必须使用 `https://` / `wss://`。HTTP 明文会让令牌、对话内容和 Magpie 密钥暴露在网络上。
- 不要公开电脑令牌、管理密码、API Token。
- 不要截图管理面板里的令牌。
- 不用的手机及时在管理面板撤销。
- Cloudflare 会终止 TLS，技术上能看到经过它的流量；Worker 代码不保存对话正文，但 Cloudflare 是第三方服务。如果内容非常敏感，请使用自建 Linux 中继。
- 部署完成后可以删除 API Token；以后更新版本时再创建新的。

---

## 14. 进阶：命令行部署

如果你不想用交互提示，可以在 PowerShell 里执行：

```powershell
cd D:\CodexLink-Cloudflare
$env:CLOUDFLARE_API_TOKEN = "你的Token"
node scripts/install.mjs --custom-domain relay.example.com
```

部署完成后可以跑一次端到端测试：

```powershell
node scripts/smoke.mjs --url https://relay.example.com
```

测试会创建临时电脑令牌、模拟手机配对和指令转发，结束后自动删除测试数据。

其他常用参数：

```text
--public-url <url>       已经绑定好的域名
--custom-domain <host>   自动创建 DNS 并绑定域名
--admin-password <值>    指定管理密码
--reset-admin-password   重新生成管理密码
--skip-check             跳过部署后的健康检查
--no-prompt              不显示交互提示
```

---

## 15. 最后检查清单

部署完成后，确认以下每一项：

- [ ] `https://你的地址/healthz` 返回 `{"ok":true,...}`
- [ ] 管理面板能登录
- [ ] 管理面板里有一台在线电脑
- [ ] 电脑端显示“云端中继 · 已连接”
- [ ] 手机端能看到历史会话
- [ ] 手机发送的消息出现在电脑端原会话里
- [ ] 管理密码和电脑令牌已保存到安全位置

全部通过，就可以正常使用了。
