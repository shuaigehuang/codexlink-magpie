#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const state = await readJSON(path.join(root, ".install-state.json"), {});
const args = parseArgs(process.argv.slice(2));
const baseUrl = String(
  args.url || process.env.CODEXLINK_RELAY_URL || state.publicUrl || state.workerUrl || "",
).replace(/\/+$/, "");
const adminPassword = String(
  args.password
  || process.env.CODEXLINK_ADMIN_PASSWORD
  || await readOptional(path.join(root, ".admin-password"))
  || "",
).trim();

if (!baseUrl || !adminPassword) {
  fail("需要服务器地址和管理密码。请先运行 install.mjs，或传入 --url 与 --password。");
}

const report = [];
let adminCookie = "";
let csrf = "";
let desktopToken = "";
let tokenId = "";
const sockets = [];

try {
  const health = await getJSON(`${baseUrl}/healthz`);
  assert(health.ok === true && health.runtime === "cloudflare-workers", "健康检查失败");
  report.push("健康检查");

  await loginAdmin();
  report.push("管理面板登录");

  const created = await adminAPI("/admin/api/tokens", {
    method: "POST",
    body: JSON.stringify({ name: `smoke-${Date.now()}` }),
  });
  desktopToken = created.token;
  tokenId = created.record.id;
  assert(desktopToken && tokenId, "创建电脑令牌失败");
  report.push("创建电脑令牌");

  const deviceId = `smoke-${Date.now().toString(36)}`;
  const desktop = await openSocket(
    `${baseUrl.replace(/^http/, "ws")}/v1/desktop/connect?device=${encodeURIComponent(deviceId)}&name=Smoke`,
    desktopToken,
  );
  assert(desktop.hello.type === "hello", "电脑端未收到 hello");
  report.push("电脑端 WebSocket");

  const pairRequestId = `pair-${Date.now()}`;
  desktop.ws.send(JSON.stringify({
    type: "pair.create",
    requestId: pairRequestId,
    scopes: ["read", "chat", "files", "magpie-admin"],
  }));
  const paired = await desktop.waitFor(
    (message) => message.type === "pair.created" && message.requestId === pairRequestId,
    10000,
  );
  assert(/^[0-9A-Z]{8}$/.test(paired.code || ""), "配对码格式错误");
  report.push("生成配对码");

  const claimResponse = await fetch(`${baseUrl}/v1/pair/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: paired.code, name: "Smoke Phone" }),
  });
  const claim = await claimResponse.json();
  assert(claimResponse.ok && claim.token && claim.deviceId === deviceId, `配对失败: ${JSON.stringify(claim)}`);
  report.push("手机配对");

  const mobile = await openSocket(
    `${baseUrl.replace(/^http/, "ws")}/v1/mobile/connect?device=${encodeURIComponent(deviceId)}`,
    claim.token,
  );
  assert(mobile.hello.type === "hello", "手机端未收到 hello");
  desktop.onRPC = (message) => {
    desktop.ws.send(JSON.stringify({
      type: "rpc.result",
      requestId: message.requestId,
      ok: true,
      result: {
        pong: true,
        method: message.method,
        bytes: JSON.stringify(message.params || {}).length,
      },
    }));
  };

  const wsRequestId = `ws-${Date.now()}`;
  mobile.ws.send(JSON.stringify({
    type: "rpc",
    requestId: wsRequestId,
    method: "ping",
    params: {},
  }));
  const wsResult = await mobile.waitFor(
    (message) => message.type === "rpc.result" && message.requestId === wsRequestId,
    15000,
  );
  assert(wsResult.ok === true && wsResult.result?.pong === true, "WebSocket 指令失败");
  report.push("手机 WebSocket 指令");

  const httpResult = await postJSON(
    `${baseUrl}/v1/mobile/rpc?device=${encodeURIComponent(deviceId)}`,
    { method: "ping", params: {} },
    claim.token,
  );
  assert(httpResult.ok === true && httpResult.result?.pong === true, "HTTP 指令失败");
  report.push("手机 HTTP 指令");

  const payload = "A".repeat(4 * 1024 * 1024);
  const largeHTTP = await postJSON(
    `${baseUrl}/v1/mobile/rpc?device=${encodeURIComponent(deviceId)}`,
    { method: "files.chunk", params: { uploadId: "smoke", index: 0, data: payload } },
    claim.token,
  );
  assert(largeHTTP.ok === true, "4 MB 文件分片转发失败");
  report.push("4 MB 文件分片");

  const sessions = await adminAPI("/admin/api/state");
  assert(
    sessions.sessions.some((item) => item.deviceName === "Smoke Phone"),
    "管理面板未显示手机授权",
  );
  report.push("手机令牌管理");
} finally {
  for (const item of sockets) {
    try {
      item.close();
    } catch {
      // Ignore cleanup errors.
    }
  }
  if (tokenId && adminCookie && csrf) {
    try {
      await adminAPI(`/admin/api/tokens/${encodeURIComponent(tokenId)}`, { method: "DELETE" });
    } catch {
      // Test cleanup must not hide the original result.
    }
  }
}

console.log("");
console.log("Cloudflare 中继端到端测试通过：");
for (const item of report) {
  console.log(`  ✓ ${item}`);
}

async function loginAdmin() {
  const form = new URLSearchParams({ password: adminPassword });
  const response = await fetch(`${baseUrl}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    redirect: "manual",
  });
  assert(response.status === 303, `管理登录失败（HTTP ${response.status}）`);
  adminCookie = readSetCookie(response.headers);
  assert(adminCookie, "管理登录未返回 Cookie");
  const dashboard = await fetch(`${baseUrl}/admin`, {
    headers: { Cookie: adminCookie },
  });
  const html = await dashboard.text();
  assert(dashboard.ok && html.includes("管理面板"), "管理面板打开失败");
  const match = html.match(/const CSRF = "([^"]+)"/);
  assert(match, "管理面板缺少 CSRF Token");
  csrf = match[1];
}

async function adminAPI(apiPath, options = {}) {
  const headers = {
    "Accept": "application/json",
    "Cookie": adminCookie,
    ...(options.headers || {}),
  };
  if (options.method && options.method !== "GET") {
    headers["x-csrf-token"] = csrf;
  }
  const response = await fetch(`${baseUrl}${apiPath}`, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`管理 API 失败（HTTP ${response.status}）: ${payload.error || ""}`);
  }
  return payload;
}

function openSocket(url, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: 12000,
    });
    const queue = [];
    const waiters = [];
    const state = { ws, hello: null, onRPC: null, close: () => ws.close() };
    sockets.push(state);
    const timer = setTimeout(() => reject(new Error(`WebSocket 连接超时: ${url}`)), 15000);

    ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type === "rpc") {
        state.onRPC?.(message);
      }
      if (message.type === "hello") {
        state.hello = message;
        clearTimeout(timer);
        resolve(state);
      }
      for (let index = 0; index < waiters.length; index += 1) {
        if (waiters[index].predicate(message)) {
          const waiter = waiters.splice(index, 1)[0];
          clearTimeout(waiter.timer);
          waiter.resolve(message);
          break;
        }
      }
      queue.push(message);
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    state.waitFor = (predicate, timeout = 10000) => {
      const found = queue.find(predicate);
      if (found) {
        return Promise.resolve(found);
      }
      return new Promise((resolveWait, rejectWait) => {
        const waiter = {
          predicate,
          resolve: resolveWait,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
            rejectWait(new Error("等待中继消息超时"));
          }, timeout),
        };
        waiters.push(waiter);
      });
    };
  });
}

async function postJSON(url, body, token) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`HTTP RPC 失败（HTTP ${response.status}）: ${payload.error || ""}`);
  }
  return payload;
}

async function getJSON(url) {
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`请求失败（HTTP ${response.status}）`);
  }
  return payload;
}

function readSetCookie(headers) {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie") || ""];
  const match = values.join(";").match(/(?:^|;\s*)codexlink_admin=([^;]+)/);
  return match ? `codexlink_admin=${match[1]}` : "";
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readOptional(file) {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch {
    return "";
  }
}

async function readJSON(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      continue;
    }
    const equal = item.indexOf("=");
    if (equal > 2) {
      parsed[item.slice(2, equal)] = item.slice(equal + 1);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function fail(message) {
  console.error(`[CodexLink] 错误: ${message}`);
  process.exit(1);
}
