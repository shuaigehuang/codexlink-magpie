function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
:root{color-scheme:dark;--bg:#0b0f14;--panel:#121a24;--panel2:#0f1620;--line:#22303f;--text:#e6edf5;--muted:#8fa3b8;--accent:#3b82f6;--good:#22c55e;--bad:#ef4444}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 600px at 20% -10%,#13233a 0%,var(--bg) 55%);color:var(--text);font:15px/1.6 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
a{color:var(--accent)}
.wrap{max-width:1080px;margin:0 auto;padding:28px 18px 60px}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}
.brand{display:flex;align-items:center;gap:12px;font-weight:700;font-size:20px;letter-spacing:.2px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--good);box-shadow:0 0 12px var(--good)}
.card{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
.stat{background:#0d141d;border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.stat b{display:block;font-size:24px;line-height:1.2}
.stat span{color:var(--muted);font-size:13px}
h2{font-size:16px;margin:0 0 12px;color:#cfe0f2}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
th{color:var(--muted);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
code{background:#0a1017;border:1px solid var(--line);border-radius:6px;padding:2px 6px;font-family:Consolas,monospace;font-size:13px}
button{background:var(--accent);color:#fff;border:0;border-radius:10px;padding:9px 14px;font-size:14px;cursor:pointer}
button:hover{filter:brightness(1.08)}
button.ghost{background:#1b2734;border:1px solid var(--line)}
button.danger{background:#3a1517;color:#ffb4b4;border:1px solid #5b2226}
input{background:#0a1017;border:1px solid var(--line);border-radius:10px;color:var(--text);padding:10px 12px;font-size:14px;min-width:220px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.muted{color:var(--muted);font-size:13px}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 9px;font-size:12px;color:#b9cbe0;background:#0d141d}
.ok{color:var(--good)}.bad{color:var(--bad)}
.empty{color:var(--muted);padding:14px 0}
.notice{background:#0f2318;border:1px solid #1d4d31;color:#b9f3cd;border-radius:12px;padding:12px 14px;margin-bottom:14px;word-break:break-all}
form{margin:0}
.login{max-width:420px;margin:12vh auto 0}
.login .card{padding:26px}
.login input{width:100%;margin:12px 0}
.error{color:#ffb4b4;margin-top:10px}
.foot{color:var(--muted);font-size:12px;margin-top:26px}
</style>
</head>
<body>${body}</body>
</html>`;
}

export function loginPage(message = ""): Response {
  const body = `<div class="wrap"><div class="login">
<div class="brand"><span class="dot"></span>CodexLink Cloudflare 中继</div>
<div class="card">
<h2>管理登录</h2>
<p class="muted">使用安装时设置的管理密码登录。此页面仅用于管理电脑令牌与手机授权。</p>
<form method="post" action="/admin/login">
<input type="password" name="password" placeholder="管理密码" autocomplete="current-password" required>
<button type="submit" style="width:100%">登录</button>
</form>
${message ? `<div class="error">${message}</div>` : ""}
</div>
<div class="foot">运行在 Cloudflare Workers · 免费版</div>
</div></div>`;
  return htmlResponse(shell("CodexLink 管理登录", body), 200);
}

export function dashboardPage(publicUrl: string, csrf: string): Response {
  const safeUrl = publicUrl.replace(/</g, "&lt;");
  const body = `<div class="wrap">
<div class="top">
  <div class="brand"><span class="dot"></span>CodexLink Cloudflare 中继</div>
  <form method="post" action="/admin/logout"><button class="ghost" type="submit">退出登录</button></form>
</div>

<div class="card">
  <h2>服务器地址</h2>
  <div class="row"><code id="server-url">${safeUrl}</code><button class="ghost" id="copy-url" type="button">复制</button></div>
  <p class="muted">在电脑端和手机端填写该地址即可。Cloudflare 自动提供 HTTPS/WSS，无需自己配置证书。</p>
</div>

<div class="grid" style="margin-bottom:16px">
  <div class="stat"><b id="stat-tokens">-</b><span>电脑令牌</span></div>
  <div class="stat"><b id="stat-sessions">-</b><span>手机授权</span></div>
  <div class="stat"><b id="stat-online">-</b><span>在线电脑</span></div>
</div>

<div class="card">
  <h2>电脑令牌</h2>
  <div class="row" style="margin-bottom:12px">
    <input id="token-name" placeholder="令牌名称，例如 我的台式机">
    <button id="create-token" type="button">创建令牌</button>
  </div>
  <div id="token-result"></div>
  <div id="token-list"></div>
</div>

<div class="card">
  <h2>手机授权</h2>
  <div id="session-list"></div>
</div>

<div class="foot">CodexLink Cloudflare Worker · 数据存储在 Cloudflare D1</div>
</div>
<script>
const CSRF = "__CSRF__";
const $ = (id) => document.getElementById(id);
function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
  });
}
function fmt(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (isNaN(date.getTime())) return esc(value);
  return date.toLocaleString("zh-CN", {hour12:false});
}
async function api(path, options) {
  const opts = options || {};
  const headers = Object.assign({"Accept":"application/json"}, opts.headers || {});
  if (opts.method && opts.method !== "GET") headers["x-csrf-token"] = CSRF;
  const res = await fetch(path, Object.assign({}, opts, {headers}));
  const data = await res.json().catch(function(){ return {}; });
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}
let state = null;
function render() {
  if (!state) return;
  $("stat-tokens").textContent = state.tokenCount;
  $("stat-sessions").textContent = state.sessionCount;
  $("stat-online").textContent = state.onlineDesktops;
  const tokens = state.tokens || [];
  if (!tokens.length) {
    $("token-list").innerHTML = '<div class="empty">还没有电脑令牌，先创建一个并填入电脑端。</div>';
  } else {
    let html = '<table><thead><tr><th>名称</th><th>密钥</th><th>绑定设备</th><th>最近使用</th><th></th></tr></thead><tbody>';
    tokens.forEach(function (t) {
      html += '<tr><td>' + esc(t.name) + '</td><td><code>' + esc(t.hint) + '</code></td><td>' +
        (t.boundDeviceId ? '<code>' + esc(t.boundDeviceId.slice(0,12)) + '…</code>' : '<span class="muted">未绑定</span>') +
        '</td><td class="muted">' + fmt(t.lastUsedAt) + '</td><td class="row">' +
        (t.boundDeviceId ? '<button class="ghost" data-unbind="' + esc(t.id) + '">解绑</button>' : '') +
        '<button class="danger" data-delete="' + esc(t.id) + '">删除</button></td></tr>';
    });
    html += '</tbody></table>';
    $("token-list").innerHTML = html;
  }
  const sessions = state.sessions || [];
  if (!sessions.length) {
    $("session-list").innerHTML = '<div class="empty">还没有手机授权。电脑端生成配对码后，用手机扫码即可。</div>';
  } else {
    let html = '<table><thead><tr><th>手机</th><th>设备</th><th>权限</th><th>到期</th><th></th></tr></thead><tbody>';
    sessions.forEach(function (s) {
      html += '<tr><td>' + esc(s.deviceName || "未命名手机") + (s.active ? ' <span class="pill ok">在线</span>' : '') +
        '</td><td class="muted"><code>' + esc(s.deviceId.slice(0,12)) + '…</code></td><td class="muted">' +
        esc((s.scopes || []).join(" · ")) + '</td><td class="muted">' + fmt(s.expiresAt) +
        '</td><td><button class="danger" data-revoke="' + esc(s.id) + '" data-device="' + esc(s.deviceId) + '">撤销</button></td></tr>';
    });
    html += '</tbody></table>';
    $("session-list").innerHTML = html;
  }
}
async function load() {
  try { state = await api("/admin/api/state"); render(); }
  catch (error) { $("token-list").innerHTML = '<div class="error">' + esc(error.message) + '</div>'; }
}
$("copy-url").addEventListener("click", function () {
  navigator.clipboard.writeText($("server-url").textContent).then(function () {
    $("copy-url").textContent = "已复制";
    setTimeout(function(){ $("copy-url").textContent = "复制"; }, 1400);
  });
});
$("create-token").addEventListener("click", async function () {
  const name = $("token-name").value.trim();
  if (!name) { $("token-name").focus(); return; }
  try {
    const data = await api("/admin/api/tokens", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({name})});
    $("token-result").innerHTML = '<div class="notice">新令牌（只显示一次，请立即保存）：<br><code>' + esc(data.token) + '</code></div>';
    $("token-name").value = "";
    await load();
  } catch (error) { $("token-result").innerHTML = '<div class="error">' + esc(error.message) + '</div>'; }
});
document.addEventListener("click", async function (event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const del = target.getAttribute("data-delete");
  const unbind = target.getAttribute("data-unbind");
  const revoke = target.getAttribute("data-revoke");
  try {
    if (del) {
      if (!confirm("删除该电脑令牌？已连接的电脑会立即断开。")) return;
      await api("/admin/api/tokens/" + encodeURIComponent(del), {method:"DELETE"});
      await load();
    } else if (unbind) {
      if (!confirm("解除该令牌与当前电脑的绑定？")) return;
      await api("/admin/api/tokens/" + encodeURIComponent(unbind) + "/unbind", {method:"POST"});
      await load();
    } else if (revoke) {
      const device = target.getAttribute("data-device") || "";
      if (!confirm("撤销该手机授权？手机需要重新扫码才能连接。")) return;
      await api("/admin/api/sessions/revoke", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({deviceId:device, sessionId:revoke})});
      await load();
    }
  } catch (error) { alert(error.message); }
});
load();
</script>`;
  return htmlResponse(shell("CodexLink 管理面板", body).replace("__CSRF__", csrf), 200);
}

function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    },
  });
}
