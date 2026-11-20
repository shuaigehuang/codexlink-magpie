# 云服务器中继：电脑小白部署指南（腾讯云 Ubuntu）

这份文档只做一件事：**在你自己的 Linux 云服务器上装好 CodexLink 中继**，让手机可以远程查看和继续电脑上的 Codex 会话。

不需要会编程，也不需要懂 Linux。照着复制命令、按回车，大约 20–40 分钟。

> 本文以**腾讯云 Ubuntu 22.04 / 24.04** 为例。其他云厂商（阿里云、华为云、AWS、Oracle 等）操作几乎一样，只是“安全组”入口的位置不同。
>
> 不想维护服务器，也可以改用免费方案：[Cloudflare Workers 中继：电脑小白部署指南](cloudflare-deploy-beginner.md)。

---

## 最短路径

如果不想看长文，先按这 10 步做：

1. 准备一台 Ubuntu 云服务器，记下**公网 IP**和登录密码。
2. 在云控制台“安全组 / 防火墙”里放行 TCP `22`、`80`、`443`、`8080`、`8443`。
3. 用腾讯云网页终端，或用 PowerShell 执行 `ssh ubuntu@你的公网IP` 登录。
4. 执行 `uname -m`，确认是 `x86_64` 还是 `aarch64`。
5. 在服务器上下载对应架构的 `codexlink-relay-linux-*.tar.gz`。
6. 解压：`tar -xzf codexlink-relay-linux-amd64.tar.gz`。
7. 进入目录，执行 `sudo bash ./install.sh --http-public 你的公网IP`。
8. 两个端口提示直接按回车（管理面板 `8080`，中转 `80`）。
9. 保存屏幕上显示的**中继地址、管理面板地址、电脑端密钥**。
10. 电脑端填地址和密钥；手机端扫码配对。

有域名时，把第 7 步换成 `--domain` 模式即可启用 HTTPS，见第 7 节。**正式使用强烈建议用域名 + HTTPS**。

---

## 1. 先弄清楚几个词

| 名词 | 用大白话解释 |
| --- | --- |
| 中继服务器 | 手机和电脑之间的中转站。手机不直接连你家网络，而是连中继，中继再把指令转给电脑。 |
| 公网 IP | 云服务器对外的门牌号，例如 `203.0.113.10`。本文里的 `YOUR_SERVER_IP` 都要换成它。 |
| 安全组 / 防火墙 | 云厂商在服务器外面加的一道门。端口没放行，外面就完全连不进来。 |
| SSH | 远程登录 Linux 的命令行方式。Windows 10/11 自带 `ssh` 命令。 |
| systemd | Linux 的“服务管家”。安装脚本会把中继注册成开机自启的后台服务。 |
| 电脑端密钥 | 电脑连接中继时用的密码。安装时生成，只完整显示一次。 |
| 管理面板 | 服务器上的网页后台，用来增删电脑端令牌、看在线设备。 |
| 配对码 | 手机连接电脑时用的一次性 8 位码，10 分钟内有效。 |

部署完成后的数据流：

```text
手机  ──HTTPS/WSS──┐
                    ├── 你的 Linux 中继 ── 你的电脑
电脑  ──WSS────────┘          │
                               ├── 电脑令牌（只存哈希）
                               └── 手机授权（只存哈希）
```

中继只负责鉴权、配对和转发，真正执行 Codex 的还是你的电脑。**电脑关机、CodexLink 没开、Codex 没开，手机就连不上。**

---

## 2. 准备一台服务器

### 2.1 选什么配置

个人自用，最低配就够：

| 项目 | 建议 |
| --- | --- |
| CPU / 内存 | 1 核 1 GB 起步，2 核 2 GB 更稳 |
| 硬盘 | 20 GB 以上 |
| 带宽 | 1–3 Mbps 足够，中继只转发文本和少量文件分块 |
| 系统 | Ubuntu 22.04 LTS 或 24.04 LTS，**64 位** |
| 地域 | 大陆服务器需要域名备案；不想备案可选中国香港或境外地域 |

> 中继本身几乎不吃资源。真正跑 Codex 的是你自己的电脑，不是这台服务器。

### 2.2 安装系统

在腾讯云控制台重装系统时：

1. 选择 **Ubuntu Server 22.04 LTS 64bit** 或 **24.04 LTS 64bit**。
2. 不要选 CentOS、Debian、Windows。本文的安装脚本按 Ubuntu 的 `apt` 和 `systemd` 编写。
3. 设置一个你能记住的登录密码，或绑定 SSH 密钥。

### 2.3 记下三样东西

- **公网 IP**：控制台实例列表里“公网 IP”那一列。
- **登录用户名**：Ubuntu 镜像默认是 `ubuntu`，不是 `root`。
- **登录密码**：购买时设置的，或控制台“重置密码”重设的。

腾讯云的 `ubuntu` 用户默认有 `sudo` 权限，安装时用 `sudo` 提权即可，不需要直接登录 root。

---

## 3. 放行端口（最容易卡住的一步）

云服务器有**两层**防火墙，两层都要通：

1. **云厂商安全组**：在腾讯云网页控制台设置。
2. **服务器本机防火墙**：Ubuntu 的 `ufw`。安装脚本会自动处理这一层。

安全组必须在网页控制台手动放行，安装脚本改不了。

### 3.1 先决定用哪种模式

| 模式 | 适用场景 | 默认端口（TCP） |
| --- | --- | --- |
| 域名 HTTPS（推荐） | 有已备案域名，正式长期使用 | 中转 `443`、面板 `8443`、证书验证 `80` |
| 公网 IP 明文 HTTP | 没有域名，临时测试 | 中转 `80`、面板 `8080` |
| 双端口明文 HTTP | 必须同时占用 80 和 443，但不签证书 | 中转 `80` + 额外 `443`、面板 `8080` |

### 3.2 腾讯云安全组怎么加

**轻量应用服务器（Lighthouse）：**

1. 控制台 → 轻量应用服务器 → 点进实例。
2. 上方标签选 **防火墙**。
3. 点 **添加规则**。
4. 应用类型选 **自定义**，协议选 **TCP**，端口填一个端口，例如 `8080`。
5. 来源填 `0.0.0.0/0`（允许所有 IPv4），备注写 `CodexLink 管理面板`。
6. 保存。其余端口重复添加。

**云服务器 CVM：**

1. 控制台 → 云服务器 → 实例 → 点实例 ID。
2. 标签选 **安全组** → **编辑规则** → **入站规则** → **添加规则**。
3. 类型选 **自定义**，协议端口填 `TCP:8080`，来源 `0.0.0.0/0`，策略 **允许**。
4. 保存。其余端口重复添加。

### 3.3 最少要放行哪些端口

不管哪种模式，`22` 必须放行，否则你连不上服务器：

| 端口 | 用途 | 是否必须 |
| --- | --- | --- |
| `22` | SSH 登录 | 必须 |
| `80` | 明文中转，或 HTTPS 模式的证书验证 | 按模式 |
| `443` | HTTPS 中转，或双端口明文 | 按模式 |
| `8080` | 默认管理面板（HTTP 模式） | 按模式 |
| `8443` | 默认管理面板（HTTPS 模式） | 按模式 |

> 拿不准就先把 `22`、`80`、`443`、`8080`、`8443` 全部放行，装完再按实际使用的端口删掉多余的。
>
> **不要**把 `0.0.0.0/0` 开放到数据库端口（3306、6379 等）。本项目不需要这些端口。

### 3.4 本机防火墙

Ubuntu 默认的 `ufw` 可能是关闭状态。安装脚本会检测：

- `ufw` 已启用 → 自动执行 `ufw allow` 放行所选端口；
- `ufw` 未启用 → 不会强行打开，避免把你锁在外面。

不需要手动操作。若你之前自己开过 `ufw`，装完可以用下面命令确认：

```bash
sudo ufw status
```

---

## 4. 域名与 HTTPS（可选，但强烈建议）

### 4.1 为什么建议用域名

不用域名就只能走 `http://` 明文。明文模式下：

- 电脑端密钥在公网上裸奔；
- 对话内容、远程指令可被中间人看到；
- 管理密码同样不加密；
- 部分网络会拦截非标准端口的 HTTP/WebSocket。

用域名 + Let's Encrypt 证书后，电脑和手机走 `https://` / `wss://`，以上问题基本解决。证书由安装脚本自动申请和续期，不花钱。

### 4.2 添加 DNS 解析

在买域名的地方（腾讯云 DNSPod、阿里云、Cloudflare 等）添加一条 **A 记录**：

| 字段 | 填写 |
| --- | --- |
| 主机记录 | `relay`（最终域名就是 `relay.example.com`） |
| 记录类型 | `A` |
| 记录值 | 你的服务器公网 IP |
| TTL | 默认 600 秒 |

保存后等 1–10 分钟，在本地 PowerShell 验证：

```powershell
nslookup relay.example.com
```

返回的地址必须等于你的服务器公网 IP。

### 4.3 备案提醒

如果服务器在**中国大陆地域**，域名解析到这台服务器并提供网页服务，通常需要完成 ICP 备案。

未备案时，腾讯云可能拦截 `80` / `443` 的 HTTP 访问，表现为：

- 浏览器打开域名显示拦截页；
- 安装脚本申请证书失败；
- 健康检查一直不通过。

遇到这种情况：

1. 先完成备案；或
2. 把服务器换成**中国香港 / 境外地域**；或
3. 临时改用第 7 节的 `--http-public` 明文模式测试。

> 备案要求请以你所在地区和云厂商的最新规定为准。本文只讨论技术部署。

---

## 5. 登录服务器

### 5.1 方法一：腾讯云网页终端（最简单）

1. 控制台点进实例。
2. 点右上角 **登录**。
3. 选择 **标准登录 / OrcaTerm 网页终端**。
4. 输入用户名 `ubuntu` 和密码。

登录成功后会出现类似提示：

```text
ubuntu@VM-0-1-ubuntu:~$
```

这个黑色窗口就是服务器命令行。下面的命令都粘贴到这里执行。

> 网页终端支持 `Ctrl + V` 粘贴。如果粘贴没反应，试试鼠标右键。

### 5.2 方法二：Windows PowerShell

Windows 10/11 自带 SSH 客户端。按 `Win + X` → 打开 **终端** 或 **PowerShell**，执行：

```powershell
ssh ubuntu@YOUR_SERVER_IP
```

把 `YOUR_SERVER_IP` 换成你的公网 IP，例如：

```powershell
ssh ubuntu@203.0.113.10
```

第一次连接会提示：

```text
Are you sure you want to continue connecting (yes/no)?
```

输入 `yes` 回车，再输入密码。输入密码时屏幕不会显示任何字符，这是正常的，输完直接回车。

### 5.3 登录后先做三个检查

```bash
cat /etc/os-release
```

应看到 `VERSION="22.04` 或 `VERSION="24.04` 之类的行。

```bash
uname -m
```

结果只有两种可能：

- `x86_64` → 下载 **amd64** 包；
- `aarch64` → 下载 **arm64** 包。

```bash
curl --version
```

有输出就说明 `curl` 已安装。若提示 `command not found`：

```bash
sudo apt update && sudo apt install -y curl
```

---

## 6. 下载并解压安装包

### 6.1 选对架构

| `uname -m` 结果 | 下载文件 |
| --- | --- |
| `x86_64` | `codexlink-relay-linux-amd64.tar.gz` |
| `aarch64` | `codexlink-relay-linux-arm64.tar.gz` |

绝大多数腾讯云实例是 `x86_64`。只有部分 ARM 机型（如某些轻量 ARM 实例）是 `aarch64`。

### 6.2 方法一：直接在服务器下载（推荐）

先进入用户主目录：

```bash
cd ~
```

下载最新版（`latest` 会自动指向最新 Release）：

```bash
curl -fL -O https://github.com/shuaigehuang/codexlink-magpie/releases/latest/download/codexlink-relay-linux-amd64.tar.gz
```

ARM 服务器把文件名换成：

```bash
curl -fL -O https://github.com/shuaigehuang/codexlink-magpie/releases/latest/download/codexlink-relay-linux-arm64.tar.gz
```

如果下载很慢或失败（大陆访问 GitHub 偶尔不稳定），改用 6.3 的方法二。

### 6.3 方法二：本地下载后上传

1. 在电脑浏览器打开 Releases 页面：

   <https://github.com/shuaigehuang/codexlink-magpie/releases>

2. 找到最新版本，下载 `codexlink-relay-linux-amd64.tar.gz`。
3. 在 Windows PowerShell 里进入下载目录，执行：

   ```powershell
   scp .\codexlink-relay-linux-amd64.tar.gz ubuntu@YOUR_SERVER_IP:/home/ubuntu/
   ```

4. 输入服务器密码，等待进度到 100%。

> `scp` 和 `ssh` 是同一个 Windows 自带组件，能 `ssh` 就能 `scp`。
>
> 也可以在腾讯云网页终端右上角找“文件上传”，直接传压缩包。

### 6.4 校验文件（可选但推荐）

在 Releases 页面下载 `SHA256SUMS-<版本>.txt`，或在服务器上执行：

```bash
sha256sum codexlink-relay-linux-amd64.tar.gz
```

把输出的 64 位字符串和发布页里的校验值对比，一致就说明文件完整。

### 6.5 解压

```bash
tar -xzf codexlink-relay-linux-amd64.tar.gz
cd codexlink-relay-linux-amd64
ls -l
```

应该看到：

```text
codexlink-relay
install.sh
Caddyfile.example
README.txt
GUIDE-ZH.md
```

- `codexlink-relay`：中继主程序，不要手动运行。
- `install.sh`：一键安装脚本。
- `README.txt`：英文速查。
- `GUIDE-ZH.md`：就是本文。

---

## 7. 选择安装模式

### 7.1 三种常用模式

| 模式 | 命令 | 加密 | 适用 |
| --- | --- | --- | --- |
| 域名 HTTPS | `--domain relay.example.com` | ✅ HTTPS/WSS | **正式使用，推荐** |
| 公网 IP 明文 | `--http-public YOUR_SERVER_IP` | ❌ 明文 | 临时测试 |
| 双端口明文 | `--http-dual YOUR_SERVER_IP` | ❌ 明文 | 必须占 80 和 443 的特殊场景 |

还有一种是本机反代模式 `--http-only`，只监听 `127.0.0.1`，适合你已经有 Nginx/Caddy 的场景。新手不要用。

### 7.2 明确的风险提示

`--http-public` 和 `--http-dual` 都是**明文 HTTP**：

- 电脑端密钥、管理密码、对话内容、远程指令全部不加密；
- 同一网络里的其他人、公共 Wi-Fi 提供方、上游网络设备都可能看到；
- `--http-dual` 的 `443` 端口**不是 HTTPS**，只是因为端口号是 443，没有任何加密。

项目保留明文模式只是为了让你在没有域名时也能先跑通。**跑通后请尽快换成域名 + HTTPS。**

### 7.3 端口规划

安装脚本会依次问你两个端口：

1. **Web 管理面板登录端口**：只用于网页后台。
2. **电脑/手机中转服务端口**：只用于电脑和手机连接。

两个端口必须不同。默认值：

| 模式 | 管理面板 | 中转服务 |
| --- | --- | --- |
| 域名 HTTPS | `8443` | `443` |
| 公网 IP 明文 | `8080` | `80` |
| 双端口明文 | `8080` | `80`（额外再开 `443`） |

建议新手直接用默认值，然后回第 3 节把对应端口放行。想自定义也可以，但记得安全组要同步放行。

---

## 8. 运行安装脚本（核心步骤）

### 8.1 域名 HTTPS 模式（推荐）

```bash
sudo bash ./install.sh --domain relay.example.com --email you@example.com
```

把域名和邮箱换成你自己的：

- `relay.example.com` 必须已经解析到这台服务器；
- `you@example.com` 只用于证书到期通知，可以留空不写 `--email`；
- `80` 端口必须能被公网访问，Let's Encrypt 要用它验证域名归属。

### 8.2 公网 IP 明文模式（临时测试）

```bash
sudo bash ./install.sh --http-public YOUR_SERVER_IP
```

例如：

```bash
sudo bash ./install.sh --http-public 203.0.113.10
```

### 8.3 双端口明文模式

```bash
sudo bash ./install.sh --http-dual YOUR_SERVER_IP
```

中继会同时监听 `80` 和 `443`，两个都是明文 HTTP。管理面板仍默认 `8080`。

### 8.4 两个端口提示怎么答

脚本会显示：

```text
请设置两个服务端口。端口可在腾讯云安全组和本机防火墙中单独放行。
Web 管理面板登录端口 [8080]:
电脑/手机中转服务端口 [80]:
```

（HTTPS 模式下默认值会是 `8443` 和 `443`。）

操作方式：

- **直接按回车**：使用方括号里的默认值。新手推荐这样。
- **输入数字再回车**：使用自定义端口，例如 `9000`。
- 第二个端口如果和第一个相同，脚本会提示并让你重输。

如果端口被其他程序占用，脚本会直接报错并退出，例如：

```text
Web 管理面板端口 8080 已被其他程序占用，请更换端口或先停止占用程序。
```

查看谁占用了端口：

```bash
sudo ss -ltnp | grep :8080
```

### 8.5 脚本会自动做什么

按顺序：

1. 检查是否用 `sudo` 运行；
2. 检查 `systemctl`、`install`、`curl` 是否存在；
3. 识别 CPU 架构；
4. 检查端口是否被占用；
5. 生成电脑端密钥和管理密码（都是 64 位十六进制随机串）；
6. 把程序安装到 `/opt/codexlink-relay/`；
7. 创建专用系统用户 `codexlink`；
8. 创建数据目录 `/var/lib/codexlink-relay/`；
9. 写入配置 `/etc/codexlink-relay.env`（权限 `0600`，仅 root 可读）；
10. 注册并启动 systemd 服务 `codexlink-relay`；
11. 自动放行本机 `ufw` / `firewalld` 端口；
12. 对中转和管理面板做健康检查。

整个过程不会安装数据库，不会占用 3306/6379，也不会改动你已有的网站。

### 8.6 成功时应该看到什么

```text
中继服务已启动。
端口配置:
  Web 管理面板: 8080
  电脑/手机中转: 80

中转服务健康检查: 通过
Web 管理面板健康检查: 通过

公网中转地址: http://203.0.113.10
管理面板地址: http://203.0.113.10:8080/admin
模式: HTTP 明文直连（未启用 TLS）
...
电脑端设备配对页面填写：
  中继地址: http://203.0.113.10
  电脑端密钥: 3f2a...（64 位）
  该密钥只在本次安装时显示，请立即保存到密码管理器。

服务器 Web 管理后台:
  http://203.0.113.10:8080/admin
  管理密码保存在 /etc/codexlink-relay.env
```

> 如果健康检查显示“未通过”，但服务本身是 `active`，通常只是安全组没放行。先回第 3 节检查，再执行第 10 节的手动验证。**不要急着重装。**

---

## 9. 立刻保存四样东西

安装成功后，马上把这四项复制到记事本或密码管理器：

| 项目 | 示例 | 用途 |
| --- | --- | --- |
| 中继地址 | `http://203.0.113.10` 或 `https://relay.example.com` | 电脑端和手机端都填这个 |
| 管理面板地址 | `http://203.0.113.10:8080/admin` | 浏览器登录服务器后台 |
| 电脑端密钥 | 64 位十六进制字符串 | 电脑端“云端中继”里填 |
| 管理密码 | 另一串 64 位字符串 | 登录管理面板 |

电脑端密钥**只在第一次安装时完整显示**。以后重装会沿用，但不会再打印出来。

### 9.1 以后怎么找回

在服务器上执行：

```bash
sudo grep '^CODEXLINK_RELAY_DESKTOP_TOKEN=' /etc/codexlink-relay.env
sudo grep '^CODEXLINK_RELAY_ADMIN_TOKEN=' /etc/codexlink-relay.env
```

输出格式是 `变量名=值`，等号后面的部分就是密钥/密码。

> 这两个值在服务器上是明文保存的，只有 root 能读。任何拿到 root 权限的人都能看到，所以服务器密码和 SSH 密钥同样要保管好。

### 9.2 密钥丢了怎么办

- **电脑端密钥丢了**：登录管理面板，新建一个电脑令牌，在电脑端换用新令牌；旧令牌可以在面板里删除。
- **管理密码丢了**：用上面的 `grep` 命令找回。
- **两者都丢了且进不去面板**：重新运行安装脚本即可，会沿用原配置；或在服务器上手动修改 `/etc/codexlink-relay.env` 后重启服务。

---

## 10. 验证服务

### 10.1 看服务状态

```bash
systemctl status codexlink-relay
```

看到 `active (running)` 就是正常运行。按 `q` 退出。

### 10.2 健康检查

HTTP 明文模式：

```bash
curl http://YOUR_SERVER_IP/healthz
curl http://YOUR_SERVER_IP:8080/healthz
```

HTTPS 模式：

```bash
curl https://relay.example.com/healthz
curl https://relay.example.com:8443/healthz
```

两个地址都应返回类似：

```json
{"ok":true,"service":"codexlink-relay"}
```

> 注意：`/admin` 只存在于**管理面板端口**。访问中转端口的 `/admin` 会返回 404，这是故意的安全设计。

### 10.3 登录管理面板

浏览器打开安装结束输出的地址，例如：

```text
http://203.0.113.10:8080/admin
```

输入管理密码。登录后应该能看到：

- 中继在线状态；
- 当前在线电脑数和手机数；
- 可用的服务器连接地址（会标注是否加密）；
- 电脑令牌列表；
- 新建 / 删除电脑令牌。

如果页面能打开但登录失败，先确认密码复制完整（64 位，没有多余空格）。

### 10.4 看日志

```bash
journalctl -u codexlink-relay -f
```

实时滚动日志。按 `Ctrl + C` 退出。启动失败时先看这里。

---

## 11. 配置电脑端 CodexLink

1. 安装 `CodexLink-Setup-<版本>.exe`。
2. 先启动 **Codex 桌面版**，确认能正常对话。
3. 如果使用 Magpie，也先启动 Magpie。
4. 打开 CodexLink，进入 **设备配对**。
5. 在“云端中继”区域填写：

   | 字段 | 填写内容 |
   | --- | --- |
   | 中继地址 | 第 9 节保存的中继地址，必须带 `http://` 或 `https://` |
   | 电脑端密钥 | 第 9 节保存的 64 位密钥 |
   | 设备名称 | 例如 `我的电脑` |

6. 点击 **保存并连接**。
7. 看到 **“云端中继 · 已连接”** 即成功。

### 11.1 设置手机权限

在同一页面勾选手机需要的权限：

- **查看会话**：读取历史会话和 Magpie 状态（默认）。
- **发送指令**：在现有 Codex 会话里继续发消息。
- **上传文件**：手机选择文件，经中继传到电脑。
- **管理 Magpie**：创建、轮换、停用 Magpie 密钥。

不确定就至少勾选“查看会话”和“发送指令”。

### 11.2 生成配对码

点击 **生成配对码**。二维码和 8 位配对码 **10 分钟内有效，只能使用一次**。

---

## 12. 配置手机端

1. 安装 `codexlink-mobile.apk`。
2. 允许“安装未知应用”。
3. 打开 App。
4. 扫描电脑端二维码；或手动填写：
   - 服务器地址：和中继地址完全一致；
   - 配对码：电脑端显示的 8 位码。
5. 连接成功后打开一个会话，发送测试消息：

   ```text
   你好，测试一下
   ```

6. 电脑端应该**在原会话里继续执行**，不会新建对话。

手机和电脑不需要连同一个 Wi-Fi。手机用 4G/5G 也可以，只要两边都能访问中继。

---

## 13. 日常使用与维护

### 13.1 常用命令

```bash
systemctl status codexlink-relay     # 查看状态
systemctl restart codexlink-relay    # 重启
systemctl stop codexlink-relay       # 停止
systemctl start codexlink-relay      # 启动
journalctl -u codexlink-relay -f     # 实时日志
journalctl -u codexlink-relay -n 100 --no-pager   # 最近 100 行
```

服务已设置为**开机自启**，服务器重启后会自动恢复，不需要手动操作。

### 13.2 管理面板能做什么

- **查看连接地址**：面板会列出所有可用地址，并标注是 HTTPS 还是明文。
- **新建电脑令牌**：完整令牌只显示一次，服务器只保存哈希。
- **删除电脑令牌**：删除在线令牌会立即断开对应电脑；系统会阻止删掉最后一个令牌，避免你把自己锁在外面。
- **查看在线设备**：哪台电脑在线、有多少手机已授权。
- **解绑设备**：电脑换机时可以解除旧绑定。

> 管理面板管理的是**电脑端接入令牌**。手机授权仍由电脑端“已授权手机”面板管理。

### 13.3 备份配置

升级或迁移前建议备份：

```bash
sudo install -m 600 /etc/codexlink-relay.env /root/codexlink-relay.env.backup
```

这个文件包含电脑端密钥和管理密码，**不要上传到网盘或 Git**。

### 13.4 数据目录

```text
/var/lib/codexlink-relay/
```

存放运行期数据（令牌哈希、设备绑定等）。不要手动删里面的文件，删了手机和电脑都要重新配对。

---

## 14. 升级到新版本

升级不会丢令牌，也不会改变端口。步骤：

1. 备份配置（见 13.3）。
2. 下载新版本压缩包。
3. 解压到新目录：

   ```bash
   tar -xzf codexlink-relay-linux-amd64.tar.gz
   cd codexlink-relay-linux-amd64
   ```

4. **用和上次完全相同的模式**重新执行安装命令，例如：

   ```bash
   sudo bash ./install.sh --http-public YOUR_SERVER_IP
   ```

5. 端口提示会**自动带出旧端口**，直接按回车即可。
6. 脚本会复用 `/etc/codexlink-relay.env` 里的电脑端密钥和管理密码，不会重新生成。
7. 最后仍会做健康检查。

升级时脚本会先检查旧服务是否占着端口；如果是 CodexLink 自己占用的，会自动释放并重启，不会报“端口被占用”。

> 不要删除 `/etc/codexlink-relay.env` 和 `/var/lib/codexlink-relay/`，否则等于全新安装，所有设备都要重新配对。

---

## 15. 卸载

### 15.1 停止并删除服务

逐行执行：

```bash
sudo systemctl stop codexlink-relay
sudo systemctl disable codexlink-relay
sudo rm -f /etc/systemd/system/codexlink-relay.service
sudo systemctl daemon-reload
sudo rm -rf /opt/codexlink-relay
sudo rm -rf /var/lib/codexlink-relay
sudo rm -f /etc/codexlink-relay.env
sudo userdel codexlink
```

说明：

- `/opt/codexlink-relay`：程序文件；
- `/var/lib/codexlink-relay`：令牌哈希和设备绑定；
- `/etc/codexlink-relay.env`：密钥和密码；
- `codexlink`：专用系统用户。

`userdel` 可能提示 `mail spool` 之类的警告，可以忽略。

### 15.2 清理本机防火墙

如果之前启用了 `ufw`，删掉对应规则（端口换成你实际用的）：

```bash
sudo ufw delete allow 8080/tcp
sudo ufw delete allow 80/tcp
```

### 15.3 清理云安全组

回腾讯云控制台，把之前为 CodexLink 添加的入站规则删掉。**这一步脚本不会替你做。**

### 15.4 保留数据的“软卸载”

只想暂时停用、以后还能恢复：

```bash
sudo systemctl stop codexlink-relay
sudo systemctl disable codexlink-relay
```

配置和数据都还在。以后执行 `sudo systemctl enable --now codexlink-relay` 就能恢复。

---

## 16. 常见问题

| 现象 | 可能原因 | 解决办法 |
| --- | --- | --- |
| `请使用 sudo 运行安装脚本` | 忘了加 `sudo` | 命令前加 `sudo` |
| `缺少命令: curl` | 系统太精简 | `sudo apt update && sudo apt install -y curl` |
| `不支持的 CPU 架构` | 不是 x86_64 / aarch64 | 换支持的实例，或自行编译 |
| `未找到中继二进制` | 没解压完整，或在错误目录运行 | `cd` 进解压目录，确认能看到 `codexlink-relay` |
| 端口被占用 | 8080/80 被 Nginx 等占用 | `sudo ss -ltnp \| grep :8080`，换端口或停掉占用程序 |
| 健康检查未通过 | 安全组没放行 / 本机防火墙拦截 | 回第 3 节检查安全组，`sudo ufw status` |
| 浏览器打不开面板 | 用了 `https://` 打开 HTTP 端口，或端口写错 | 明文模式必须用 `http://IP:端口/admin` |
| 中转端口打开 `/admin` 是 404 | 设计如此 | 管理面板在独立端口，用安装输出的面板地址 |
| 域名 HTTPS 证书申请失败 | DNS 没生效 / 80 被拦 / 域名未备案 | `nslookup` 确认解析；放行 80；完成备案或换香港服务器 |
| 电脑端一直“重连中” | 地址或密钥错误、服务没起 | 先 `curl .../healthz`，再核对地址和 64 位密钥 |
| 手机一直“连接中” | 电脑端未连接、手机地址不一致 | 先确认电脑端显示“已连接”，再核对手机地址 |
| 手机能连但发不出指令 | 配对时没勾“发送指令” | 电脑端重新生成配对码，勾选后重新配对 |
| `thread ... already has an active writer` | 电脑端正在写同一会话 | 等电脑端当前回复结束，手机端会自动重试 |
| 服务启动失败 | 配置或端口问题 | `journalctl -u codexlink-relay -n 100 --no-pager` |
| 忘了管理密码 | 没保存 | `sudo grep '^CODEXLINK_RELAY_ADMIN_TOKEN=' /etc/codexlink-relay.env` |
| 忘了电脑端密钥 | 没保存 | `sudo grep '^CODEXLINK_RELAY_DESKTOP_TOKEN=' /etc/codexlink-relay.env` |
| 改了端口后连不上 | 安全组没同步放行 | 回第 3 节放行新端口，删掉旧规则 |
| 重装后手机全掉线 | 删了数据目录或换了密钥 | 重新在电脑端生成配对码，手机重新扫码 |

### 还是不行怎么办

按顺序检查这五项，基本就能定位：

1. `systemctl status codexlink-relay` 是否 `active`。
2. `curl 中继地址/healthz` 是否返回 `{"ok":true}`。
3. 管理面板能否登录、在线电脑数是否为 1。
4. 电脑端是否显示“云端中继 · 已连接”。
5. 手机端服务器地址是否和电脑端**完全一致**（包括端口和 `http/https`）。

把这五项结果发给维护者，不要附带密钥和密码。

---

## 17. 安全须知

### 17.1 必须做的事

- **正式使用必须上 HTTPS**。明文模式只用于临时测试。
- 不要公开电脑端密钥、管理密码、服务器 root 密码。
- 不要截图管理面板里的令牌。
- 服务器 SSH 密码要足够强；能不用密码登录就改用 SSH 密钥。
- 不用的手机及时在电脑端“已授权手机”里撤销。
- 不用的电脑令牌及时在管理面板删除。
- 定期 `sudo apt update && sudo apt upgrade -y` 打系统补丁。

### 17.2 明文模式的实际风险

使用 `--http-public` 或 `--http-dual` 时：

```text
手机/电脑 ──明文 HTTP/WS──> 公网 ──明文──> 服务器
```

路径上的任何一跳都可能读到：

- 电脑端密钥（可直接接管你的电脑连接）；
- 管理密码（可增删令牌）；
- 对话内容和远程指令；
- Magpie 操作结果。

如果必须在不可信网络使用，请先换域名 + HTTPS。没有域名时，至少不要在公共 Wi-Fi、酒店网络、公司代理网络下长期使用。

### 17.3 服务器被入侵的后果

中继本身不保存对话正文，但服务器上有：

- 电脑端密钥（明文，root 可读）；
- 管理密码（明文，root 可读）；
- 手机令牌哈希和设备绑定。

拿到 root 的人可以冒充管理面板、替换中继程序、劫持连接。因此：

- 不要装来源不明的软件；
- 不要给无关的人服务器账号；
- 不要为了方便把 SSH 密码设成 `123456`；
- 发现异常先 `systemctl stop codexlink-relay`，再排查。

### 17.4 建议的额外加固（可选）

```bash
# 只允许密钥登录 SSH（确认你已经能免密登录后再做）
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh

# 安装 fail2ban，自动封禁暴力破解 IP
sudo apt install -y fail2ban
```

> 改 SSH 配置有把自己锁在外面的风险。不熟悉就先别做，或先在腾讯云控制台确认能用 VNC 登录兜底。

---

## 18. 最后检查清单

部署完成后，逐项确认：

- [ ] `systemctl status codexlink-relay` 显示 `active (running)`
- [ ] `curl 中继地址/healthz` 返回 `{"ok":true,...}`
- [ ] 管理面板能登录
- [ ] 管理面板能看到可用连接地址
- [ ] 管理面板里有一台在线电脑
- [ ] 电脑端显示“云端中继 · 已连接”
- [ ] 手机端能看到历史会话
- [ ] 手机发送的消息出现在电脑端**原会话**里
- [ ] 手机端思考过程和回复能实时同步
- [ ] 电脑端密钥、管理密码已保存到安全位置
- [ ] 云安全组只放行了实际需要的端口

全部通过，就可以正常使用了。

---

## 附录 A：命令速查

```bash
# 登录
ssh ubuntu@YOUR_SERVER_IP

# 看架构
uname -m

# 下载（amd64）
curl -fL -O https://github.com/shuaigehuang/codexlink-magpie/releases/latest/download/codexlink-relay-linux-amd64.tar.gz

# 解压
tar -xzf codexlink-relay-linux-amd64.tar.gz
cd codexlink-relay-linux-amd64

# 安装（三选一）
sudo bash ./install.sh --domain relay.example.com --email you@example.com
sudo bash ./install.sh --http-public YOUR_SERVER_IP
sudo bash ./install.sh --http-dual YOUR_SERVER_IP

# 指定端口（可选）
sudo bash ./install.sh --http-public YOUR_SERVER_IP --relay-port 8787 --admin-port 8080

# 不询问、直接用默认端口（自动化用）
sudo bash ./install.sh --http-public YOUR_SERVER_IP --yes

# 服务管理
systemctl status codexlink-relay
systemctl restart codexlink-relay
journalctl -u codexlink-relay -f

# 找回密钥
sudo grep '^CODEXLINK_RELAY_DESKTOP_TOKEN=' /etc/codexlink-relay.env
sudo grep '^CODEXLINK_RELAY_ADMIN_TOKEN=' /etc/codexlink-relay.env
```

## 附录 B：端口对照表

| 场景 | 管理面板 | 中转服务 | 额外端口 | 安全组要放行 |
| --- | --- | --- | --- | --- |
| 域名 HTTPS（默认） | 8443 | 443 | 80（证书） | 22、80、443、8443 |
| 域名 HTTPS（自定义） | 你填的 | 你填的 | 80（证书） | 22、80、两个自定义端口 |
| 公网 IP 明文（默认） | 8080 | 80 | 无 | 22、80、8080 |
| 公网 IP 明文（自定义） | 你填的 | 你填的 | 无 | 22、两个自定义端口 |
| 双端口明文（默认） | 8080 | 80 | 443 | 22、80、443、8080 |

> 表里的“额外端口”也必须放行，否则对应对接方式不可用。

