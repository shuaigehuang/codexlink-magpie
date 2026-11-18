#!/usr/bin/env bash
set -euo pipefail

APP_NAME="codexlink-relay"
INSTALL_DIR="/opt/codexlink-relay"
DATA_DIR="/var/lib/codexlink-relay"
ENV_FILE="/etc/codexlink-relay.env"
SERVICE_FILE="/etc/systemd/system/codexlink-relay.service"
DOMAIN=""
EMAIL=""
PUBLIC_HOST=""
HTTP_ONLY=0
HTTP_PUBLIC=0
HTTP_PUBLIC_EXPLICIT=0
HTTP_DUAL=0
ASSUME_YES=0
ADMIN_PORT=""
RELAY_PORT=""
EXTRA_PORT=""
TOKEN="${CODEXLINK_DESKTOP_TOKEN:-}"
TOKEN_GENERATED=0
ADMIN_TOKEN="${CODEXLINK_ADMIN_TOKEN:-}"
PUBLIC_URLS=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
    cat <<'EOF'
用法:
  sudo bash ./install.sh --domain relay.example.com --email you@example.com
  sudo bash ./install.sh --http-public 203.0.113.10
  sudo bash ./install.sh --http-only

参数:
  --domain <域名>   自动申请 HTTPS 证书；中继和管理面板使用 HTTPS
  --email <邮箱>    Let's Encrypt 通知邮箱，可选
  --http-public <公网IP或域名>
                    使用 HTTP 明文中继，不加密
  --http-dual <公网IP或域名>
                    额外在 80/443 的另一个端口提供 HTTP 明文中继
  --http-only       仅监听 127.0.0.1，供 Nginx/Caddy/SSH 隧道反代
  --admin-port <端口>
                    Web 管理面板端口；交互安装时会询问
  --relay-port <端口>
                    电脑端和手机端连接的中转服务端口；交互安装时会询问
  --yes             不询问，使用各模式默认端口直接安装
  -h, --help        显示帮助

环境变量:
  CODEXLINK_DESKTOP_TOKEN  指定电脑端密钥；留空则自动生成
  CODEXLINK_ADMIN_TOKEN    指定中继管理密码；留空则自动生成

默认端口:
  域名 HTTPS 模式         管理面板 8443，中转服务 443
  HTTP 公网/双端口模式    管理面板 8080，中转服务 80
  本机反代模式            管理面板 8080，中转服务 8787

安全提示:
  非域名模式为 HTTP 明文，管理密码、电脑端密钥和对话内容可能被截获。
  正式使用强烈建议准备已备案域名并使用 --domain 启用 HTTPS。
EOF
}

require_value() {
    if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "参数 $1 缺少值。" >&2
        usage
        exit 2
    fi
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --domain)
            require_value "$1" "${2:-}"
            DOMAIN="$2"
            shift 2
            ;;
        --email)
            require_value "$1" "${2:-}"
            EMAIL="$2"
            shift 2
            ;;
        --http-public)
            require_value "$1" "${2:-}"
            PUBLIC_HOST="$2"
            HTTP_PUBLIC=1
            HTTP_DUAL=0
            HTTP_PUBLIC_EXPLICIT=1
            shift 2
            ;;
        --http-dual)
            require_value "$1" "${2:-}"
            PUBLIC_HOST="$2"
            HTTP_PUBLIC=0
            HTTP_DUAL=1
            HTTP_PUBLIC_EXPLICIT=1
            shift 2
            ;;
        --http-only)
            HTTP_ONLY=1
            HTTP_PUBLIC=0
            HTTP_DUAL=0
            shift
            ;;
        --admin-port)
            require_value "$1" "${2:-}"
            ADMIN_PORT="$2"
            shift 2
            ;;
        --relay-port)
            require_value "$1" "${2:-}"
            RELAY_PORT="$2"
            shift 2
            ;;
        --yes|-y)
            ASSUME_YES=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "未知参数: $1" >&2
            usage
            exit 2
            ;;
    esac
done

if [[ ${EUID} -ne 0 ]]; then
    echo "请使用 sudo 运行安装脚本。" >&2
    exit 1
fi

for command in systemctl install curl; do
    if ! command -v "$command" >/dev/null 2>&1; then
        echo "缺少命令: $command" >&2
        exit 1
    fi
done

case "$(uname -m)" in
    x86_64|amd64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *)
        echo "不支持的 CPU 架构: $(uname -m)" >&2
        exit 1
        ;;
esac

if [[ -f "${SCRIPT_DIR}/codexlink-relay" ]]; then
    BINARY="${SCRIPT_DIR}/codexlink-relay"
elif [[ -f "${SCRIPT_DIR}/${APP_NAME}-linux-${ARCH}" ]]; then
    BINARY="${SCRIPT_DIR}/${APP_NAME}-linux-${ARCH}"
else
    echo "未找到中继二进制。请将安装包完整解压后运行。" >&2
    exit 1
fi
chmod +x "$BINARY"

if [[ -z "$DOMAIN" && -z "$PUBLIC_HOST" && "$HTTP_ONLY" -eq 0 ]]; then
    if [[ -t 0 && "$ASSUME_YES" -eq 0 ]]; then
        read -r -p "中继域名或公网 IP（留空则使用 127.0.0.1 本机模式）: " PUBLIC_HOST
    fi
fi
if [[ "$HTTP_PUBLIC_EXPLICIT" -eq 1 && -z "$PUBLIC_HOST" ]]; then
    echo "--http-public 或 --http-dual 需要提供公网 IP 或域名。" >&2
    exit 1
fi
if [[ -n "$PUBLIC_HOST" && "$HTTP_PUBLIC_EXPLICIT" -eq 0 && ! "$PUBLIC_HOST" =~ ^[0-9.]+$ ]]; then
    DOMAIN="$PUBLIC_HOST"
    PUBLIC_HOST=""
fi

if [[ -n "$DOMAIN" ]]; then
    DOMAIN="${DOMAIN#http://}"
    DOMAIN="${DOMAIN#https://}"
    DOMAIN="${DOMAIN%%/*}"
    DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
    if [[ ! "$DOMAIN" =~ ^[a-z0-9.-]+$ || "$DOMAIN" != *.* ]]; then
        echo "域名格式无效: $DOMAIN" >&2
        exit 1
    fi
    HTTP_ONLY=0
    HTTP_PUBLIC=0
    HTTP_DUAL=0
elif [[ -n "$PUBLIC_HOST" ]]; then
    PUBLIC_HOST="${PUBLIC_HOST#http://}"
    PUBLIC_HOST="${PUBLIC_HOST#https://}"
    PUBLIC_HOST="${PUBLIC_HOST%%/*}"
    if [[ ! "$PUBLIC_HOST" =~ ^[A-Za-z0-9.-]+$ ]]; then
        echo "公网地址格式无效: $PUBLIC_HOST" >&2
        exit 1
    fi
    HTTP_ONLY=0
    if [[ "$HTTP_DUAL" -eq 1 ]]; then
        HTTP_PUBLIC=0
    else
        HTTP_PUBLIC=1
    fi
else
    HTTP_ONLY=1
fi

if [[ -n "$DOMAIN" ]]; then
    DEFAULT_ADMIN_PORT=8443
    DEFAULT_RELAY_PORT=443
elif [[ "$HTTP_ONLY" -eq 1 ]]; then
    DEFAULT_ADMIN_PORT=8080
    DEFAULT_RELAY_PORT=8787
else
    DEFAULT_ADMIN_PORT=8080
    DEFAULT_RELAY_PORT=80
fi

extract_port() {
    local value="${1:-}"
    value="${value##*:}"
    if [[ "$value" =~ ^[0-9]{1,5}$ ]]; then
        printf '%s' "$value"
    fi
}

if [[ -f "$ENV_FILE" ]]; then
    EXISTING_RELAY_PORT="$(extract_port "$(grep -E '^CODEXLINK_RELAY_LISTEN=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)")"
    EXISTING_ADMIN_PORT="$(extract_port "$(grep -E '^CODEXLINK_RELAY_ADMIN_LISTEN=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)")"
    if [[ -n "$EXISTING_RELAY_PORT" ]]; then
        DEFAULT_RELAY_PORT="$EXISTING_RELAY_PORT"
    fi
    if [[ -n "$EXISTING_ADMIN_PORT" ]]; then
        DEFAULT_ADMIN_PORT="$EXISTING_ADMIN_PORT"
    fi
fi

valid_port() {
    local value="$1"
    [[ "$value" =~ ^[0-9]{1,5}$ ]] && (( 10#$value >= 1 && 10#$value <= 65535 ))
}

prompt_port() {
    local label="$1"
    local default_value="$2"
    local value=""
    while true; do
        read -r -p "${label} [${default_value}]: " value || value=""
        value="${value:-$default_value}"
        if valid_port "$value"; then
            printf '%s' "$value"
            return 0
        fi
        echo "端口必须是 1-65535 的数字，请重新输入。" >&2
    done
}

if [[ "$ASSUME_YES" -eq 0 && -t 0 && -z "$ADMIN_PORT" ]]; then
    echo
    echo "请设置两个服务端口。端口可在腾讯云安全组和本机防火墙中单独放行。"
    ADMIN_PORT="$(prompt_port "Web 管理面板登录端口" "$DEFAULT_ADMIN_PORT")"
fi
if [[ "$ASSUME_YES" -eq 0 && -t 0 && -z "$RELAY_PORT" ]]; then
    while true; do
        RELAY_PORT="$(prompt_port "电脑/手机中转服务端口" "$DEFAULT_RELAY_PORT")"
        if [[ "$RELAY_PORT" != "$ADMIN_PORT" ]]; then
            break
        fi
        echo "中转服务端口不能与 Web 管理面板端口相同，请重新输入。" >&2
    done
fi

ADMIN_PORT="${ADMIN_PORT:-$DEFAULT_ADMIN_PORT}"
RELAY_PORT="${RELAY_PORT:-$DEFAULT_RELAY_PORT}"
if ! valid_port "$ADMIN_PORT"; then
    echo "Web 管理面板端口无效: $ADMIN_PORT" >&2
    exit 1
fi
if ! valid_port "$RELAY_PORT"; then
    echo "中转服务端口无效: $RELAY_PORT" >&2
    exit 1
fi
ADMIN_PORT="$((10#$ADMIN_PORT))"
RELAY_PORT="$((10#$RELAY_PORT))"
if [[ "$ADMIN_PORT" == "$RELAY_PORT" ]]; then
    echo "Web 管理面板端口和中转服务端口不能相同。" >&2
    exit 1
fi

if [[ -n "$DOMAIN" ]]; then
    if [[ "$ADMIN_PORT" == "80" || "$RELAY_PORT" == "80" ]]; then
        echo "域名 HTTPS 模式需要保留 80 端口用于证书验证，请为两个服务选择其他端口。" >&2
        exit 1
    fi
fi
if [[ "$HTTP_DUAL" -eq 1 ]]; then
    if [[ "$RELAY_PORT" == "443" ]]; then
        EXTRA_PORT=80
    else
        EXTRA_PORT=443
    fi
    if [[ "$EXTRA_PORT" == "$ADMIN_PORT" || "$EXTRA_PORT" == "$RELAY_PORT" ]]; then
        echo "双端口 HTTP 模式需要额外使用端口 ${EXTRA_PORT}，请更换管理面板或中转端口。" >&2
        exit 1
    fi
fi

check_port_available() {
    local port="$1"
    local label="$2"
    local main_pid=""
    command -v ss >/dev/null 2>&1 || return 0
    if ! ss -ltnp "sport = :${port}" 2>/dev/null | grep -q .; then
        return 0
    fi
    if systemctl is-active --quiet codexlink-relay 2>/dev/null; then
        main_pid="$(systemctl show -p MainPID --value codexlink-relay 2>/dev/null || true)"
        if [[ -n "$main_pid" && "$main_pid" != "0" ]] &&
            ss -ltnp "sport = :${port}" 2>/dev/null | grep -q "pid=${main_pid},"; then
            echo "端口 ${port} 当前由现有 CodexLink 服务使用，升级时会自动释放。"
            return 0
        fi
    fi
    echo "${label}端口 ${port} 已被其他程序占用，请更换端口或先停止占用程序。" >&2
    exit 1
}

check_port_available "$ADMIN_PORT" "Web 管理面板"
check_port_available "$RELAY_PORT" "中转服务"
if [[ -n "$EXTRA_PORT" ]]; then
    check_port_available "$EXTRA_PORT" "额外 HTTP"
fi

if [[ -f "$ENV_FILE" && -z "$TOKEN" ]]; then
    TOKEN="$(grep -E '^CODEXLINK_RELAY_DESKTOP_TOKEN=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
fi
if [[ -f "$ENV_FILE" && -z "$ADMIN_TOKEN" ]]; then
    ADMIN_TOKEN="$(grep -E '^CODEXLINK_RELAY_ADMIN_TOKEN=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
fi
if [[ -z "$TOKEN" ]]; then
    if command -v openssl >/dev/null 2>&1; then
        TOKEN="$(openssl rand -hex 32)"
    else
        TOKEN="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
    fi
    TOKEN_GENERATED=1
fi
if [[ ${#TOKEN} -lt 32 ]]; then
    echo "电脑端密钥至少需要 32 个字符。" >&2
    exit 1
fi
if [[ -z "$ADMIN_TOKEN" ]]; then
    if command -v openssl >/dev/null 2>&1; then
        ADMIN_TOKEN="$(openssl rand -hex 32)"
    else
        ADMIN_TOKEN="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
    fi
fi
if [[ ${#ADMIN_TOKEN} -lt 32 ]]; then
    echo "中继管理密码至少需要 32 个字符。" >&2
    exit 1
fi

url_for() {
    local scheme="$1"
    local host="$2"
    local port="$3"
    local default_port=80
    if [[ "$scheme" == "https" ]]; then
        default_port=443
    fi
    if [[ "$port" == "$default_port" ]]; then
        printf '%s://%s' "$scheme" "$host"
    else
        printf '%s://%s:%s' "$scheme" "$host" "$port"
    fi
}

if [[ -n "$DOMAIN" ]]; then
    RELAY_URL="$(url_for https "$DOMAIN" "$RELAY_PORT")"
    ADMIN_URL="$(url_for https "$DOMAIN" "$ADMIN_PORT")"
    HTTP_RELAY_URL="$(url_for http "$DOMAIN" 80)"
    PUBLIC_URLS="${RELAY_URL},${HTTP_RELAY_URL}"
    ORIGINS="${RELAY_URL},${HTTP_RELAY_URL}"
elif [[ "$HTTP_ONLY" -eq 1 ]]; then
    RELAY_URL="$(url_for http 127.0.0.1 "$RELAY_PORT")"
    ADMIN_URL="$(url_for http 127.0.0.1 "$ADMIN_PORT")"
    PUBLIC_URLS="${RELAY_URL}"
    ORIGINS="${RELAY_URL}"
else
    RELAY_URL="$(url_for http "$PUBLIC_HOST" "$RELAY_PORT")"
    ADMIN_URL="$(url_for http "$PUBLIC_HOST" "$ADMIN_PORT")"
    PUBLIC_URLS="${RELAY_URL}"
    ORIGINS="${RELAY_URL}"
    if [[ -n "$EXTRA_PORT" ]]; then
        EXTRA_URL="$(url_for http "$PUBLIC_HOST" "$EXTRA_PORT")"
        PUBLIC_URLS="${PUBLIC_URLS},${EXTRA_URL}"
        ORIGINS="${ORIGINS},${EXTRA_URL}"
    fi
fi

echo "安装中继到 ${INSTALL_DIR} ..."
install -d -m 0755 "$INSTALL_DIR"
install -m 0755 "$BINARY" "${INSTALL_DIR}/codexlink-relay"

NOLOGIN="$(command -v nologin || echo /bin/false)"
if ! id -u codexlink >/dev/null 2>&1; then
    useradd --system --home-dir "$DATA_DIR" --shell "$NOLOGIN" codexlink
fi
install -d -m 0700 -o codexlink -g codexlink "$DATA_DIR"

umask 077
{
    echo "CODEXLINK_RELAY_DESKTOP_TOKEN=${TOKEN}"
    echo "CODEXLINK_RELAY_DATA_DIR=${DATA_DIR}"
    if [[ "$HTTP_ONLY" -eq 1 ]]; then
        echo "CODEXLINK_RELAY_LISTEN=127.0.0.1:${RELAY_PORT}"
        echo "CODEXLINK_RELAY_ADMIN_LISTEN=127.0.0.1:${ADMIN_PORT}"
        echo "CODEXLINK_RELAY_TRUST_PROXY=1"
    elif [[ "$HTTP_PUBLIC" -eq 1 ]]; then
        echo "CODEXLINK_RELAY_LISTEN=:${RELAY_PORT}"
        echo "CODEXLINK_RELAY_ADMIN_LISTEN=:${ADMIN_PORT}"
        echo "CODEXLINK_RELAY_TRUST_PROXY=0"
    elif [[ "$HTTP_DUAL" -eq 1 ]]; then
        echo "CODEXLINK_RELAY_LISTEN=:${RELAY_PORT}"
        echo "CODEXLINK_RELAY_ADMIN_LISTEN=:${ADMIN_PORT}"
        echo "CODEXLINK_RELAY_EXTRA_HTTP_ADDR=:${EXTRA_PORT}"
        echo "CODEXLINK_RELAY_TRUST_PROXY=0"
    else
        echo "CODEXLINK_RELAY_LISTEN=:${RELAY_PORT}"
        echo "CODEXLINK_RELAY_ADMIN_LISTEN=:${ADMIN_PORT}"
        echo "CODEXLINK_RELAY_TLS_DOMAIN=${DOMAIN}"
        echo "CODEXLINK_RELAY_TLS_EMAIL=${EMAIL}"
        echo "CODEXLINK_RELAY_HTTP_ADDR=:80"
        echo "CODEXLINK_RELAY_TRUST_PROXY=0"
    fi
    echo "CODEXLINK_RELAY_ORIGINS=${ORIGINS}"
    echo "CODEXLINK_RELAY_ADMIN_TOKEN=${ADMIN_TOKEN}"
    echo "CODEXLINK_RELAY_PUBLIC_URLS=${PUBLIC_URLS}"
} > "$ENV_FILE"
chmod 0600 "$ENV_FILE"
chown root:root "$ENV_FILE"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=CodexLink relay for desktop Codex and Magpie access
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=codexlink
Group=codexlink
EnvironmentFile=${ENV_FILE}
ExecStart=${INSTALL_DIR}/codexlink-relay
Restart=on-failure
RestartSec=3
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$SERVICE_FILE"

if [[ "$HTTP_ONLY" -eq 0 ]]; then
    FIREWALL_PORTS=("$ADMIN_PORT" "$RELAY_PORT")
    if [[ -n "$EXTRA_PORT" ]]; then
        FIREWALL_PORTS+=("$EXTRA_PORT")
    fi
    if [[ -n "$DOMAIN" ]]; then
        FIREWALL_PORTS+=(80)
    fi
    if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
        for port in "${FIREWALL_PORTS[@]}"; do
            ufw allow "${port}/tcp" >/dev/null 2>&1 || true
        done
    elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
        for port in "${FIREWALL_PORTS[@]}"; do
            firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null 2>&1 || true
        done
        firewall-cmd --reload >/dev/null 2>&1 || true
    fi
fi

systemctl daemon-reload
systemctl enable codexlink-relay >/dev/null
systemctl restart codexlink-relay
sleep 2

echo
if systemctl is-active --quiet codexlink-relay; then
    echo "中继服务已启动。"
else
    echo "中继服务启动失败，最近日志：" >&2
    journalctl -u codexlink-relay -n 30 --no-pager >&2 || true
    exit 1
fi

health_check() {
    local label="$1"
    local base_url="$2"
    for _ in 1 2 3 4 5 6; do
        if curl -fsS --max-time 8 "${base_url}/healthz" >/dev/null 2>&1; then
            echo "${label}健康检查: 通过"
            return 0
        fi
        sleep 5
    done
    echo "${label}健康检查: 未通过，请检查安全组、防火墙和 journalctl -u codexlink-relay -f" >&2
    return 1
}

echo "端口配置:"
echo "  Web 管理面板: ${ADMIN_PORT}"
echo "  电脑/手机中转: ${RELAY_PORT}"
if [[ -n "$EXTRA_PORT" ]]; then
    echo "  额外 HTTP 中转: ${EXTRA_PORT}"
fi
echo

health_check "中转服务" "$RELAY_URL" || true
health_check "Web 管理面板" "$ADMIN_URL" || true
if [[ -n "$EXTRA_PORT" ]]; then
    health_check "额外 HTTP 中转" "$EXTRA_URL" || true
fi

echo
if [[ "$HTTP_ONLY" -eq 1 ]]; then
    echo "本机监听地址:"
    echo "  中转: ${RELAY_URL}"
    echo "  面板: ${ADMIN_URL}"
    echo "请用 Nginx/Caddy 反向代理或 SSH 隧道对外提供访问。"
elif [[ -n "$DOMAIN" ]]; then
    echo "HTTPS 公网地址: ${RELAY_URL}"
    echo "管理面板地址: ${ADMIN_URL}/admin"
    echo "80 端口仅用于证书验证和跳转。"
    echo "请确认腾讯云安全组已放行 TCP ${RELAY_PORT}、${ADMIN_PORT} 和 80。"
    echo "首次签发证书可能需要几十秒；若域名未备案，腾讯云可能拦截证书校验。"
else
    echo "公网中转地址: ${RELAY_URL}"
    echo "管理面板地址: ${ADMIN_URL}/admin"
    echo "模式: HTTP 明文直连（未启用 TLS）"
    echo "警告: 电脑端密钥、管理密码、对话内容和远程指令都可能被公网中间人截获。"
    echo "      请不要在公共 Wi-Fi 或不可信网络中使用。"
    echo "强烈建议准备已备案域名，并改用 --domain 重新安装以启用 HTTPS。"
    echo "请确认腾讯云安全组已放行 TCP ${RELAY_PORT}、${ADMIN_PORT}。"
    if [[ -n "$EXTRA_PORT" ]]; then
        echo "另外还需放行额外 HTTP 中转端口 TCP ${EXTRA_PORT}。"
    fi
fi

echo
echo "电脑端设备配对页面填写："
echo "  中继地址: ${RELAY_URL}"
if [[ "$TOKEN_GENERATED" -eq 1 ]]; then
    echo "  电脑端密钥: ${TOKEN}"
    echo "  该密钥只在本次安装时显示，请立即保存到密码管理器。"
else
    echo "  电脑端密钥: 已沿用现有配置（保存在 ${ENV_FILE}）"
fi
echo
echo "服务器 Web 管理后台:"
echo "  ${ADMIN_URL}/admin"
echo "  管理面板与中转服务使用独立端口，管理页面不会暴露在中转端口。"
echo "  管理密码保存在 ${ENV_FILE}"
echo "  查看命令: sudo grep '^CODEXLINK_RELAY_ADMIN_TOKEN=' ${ENV_FILE}"
echo
echo "常用命令："
echo "  systemctl status codexlink-relay"
echo "  journalctl -u codexlink-relay -f"
