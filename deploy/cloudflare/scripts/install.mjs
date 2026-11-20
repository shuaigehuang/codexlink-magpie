#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import {
  chmod,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(path.dirname(root));
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const statePath = path.join(root, ".install-state.json");
const passwordPath = path.join(root, ".admin-password");
const secretsPath = path.join(root, ".secrets.json");
const configPath = path.join(root, "wrangler.toml");
const outputPath = path.join(root, ".wrangler-deploy-output.ndjson");
const state = await readJSON(statePath, {});

process.on("exit", () => {
  try {
    unlinkSync(secretsPath);
  } catch {
    // Nothing to clean up.
  }
});

const apiToken = (args["api-token"] || process.env.CLOUDFLARE_API_TOKEN || await readTokenFile()).trim();
if (!apiToken) {
  fail([
    "缺少 Cloudflare API Token。",
    "推荐设置环境变量 CLOUDFLARE_API_TOKEN，或使用 --api-token-file 指定文件。",
    "Token 需要 Workers Scripts:Edit 与 D1:Edit 权限。",
  ].join("\n"));
}

await ensureWrangler();

const accountId = (
  args["account-id"]
  || process.env.CLOUDFLARE_ACCOUNT_ID
  || state.accountId
  || await discoverAccountId()
).trim();
if (!accountId) {
  fail("无法确定 Cloudflare Account ID，请使用 --account-id 指定。");
}

const workerName = sanitizeWorkerName(args["worker-name"] || state.workerName || "codexlink-relay");
const databaseName = sanitizeDatabaseName(args["db-name"] || state.dbName || workerName);
const publicUrl = normalizePublicUrl(args["public-url"] || state.publicUrl || "");
const customDomain = normalizeHostname(args["custom-domain"] || "");
const skipCheck = Boolean(args["skip-check"]);
const adminPassword = (
  args["admin-password"]
  || process.env.CODEXLINK_ADMIN_PASSWORD
  || (!args["reset-admin-password"] ? await readOptional(passwordPath) : "")
  || randomToken(18)
).trim();
const cookieSecret = state.cookieSecret || randomToken(32);

if (adminPassword.length < 12) {
  fail("管理密码至少需要 12 个字符。可通过 --admin-password 设置。");
}

log(`Cloudflare 账号: ${accountId}`);
log(`Worker 名称: ${workerName}`);
log(`D1 数据库: ${databaseName}`);

const databaseId = await ensureD1(accountId, databaseName);
log(`D1 Database ID: ${databaseId}`);

const template = await readFile(path.join(root, "wrangler.toml.template"), "utf8");
const wranglerConfig = template
  .replaceAll("__WORKER_NAME__", workerName)
  .replaceAll("__D1_NAME__", databaseName)
  .replaceAll("__D1_ID__", databaseId)
  .replace('PUBLIC_URL = ""', `PUBLIC_URL = ${tomlString(publicUrl)}`);
await writeFile(configPath, wranglerConfig, "utf8");

await writeFile(
  secretsPath,
  JSON.stringify({ ADMIN_TOKEN: adminPassword, COOKIE_SECRET: cookieSecret }, null, 2),
  { encoding: "utf8", mode: 0o600 },
);
await chmod(secretsPath, 0o600).catch(() => undefined);
await writeFile(passwordPath, `${adminPassword}\n`, { encoding: "utf8", mode: 0o600 });
await chmod(passwordPath, 0o600).catch(() => undefined);
await writeState();

log("正在应用 D1 数据库迁移...");
await runWrangler([
  "d1",
  "migrations",
  "apply",
  databaseName,
  "--remote",
  "--config",
  configPath,
], { CI: "1" });

log("正在部署 Cloudflare Worker...");
await rm(outputPath, { force: true });
await runWrangler([
  "deploy",
  "--config",
  configPath,
  "--secrets-file",
  secretsPath,
  "--message",
  `CodexLink ${new Date().toISOString()}`,
], { WRANGLER_OUTPUT_FILE_PATH: outputPath });
await rm(secretsPath, { force: true });

const deployInfo = await readDeployOutput(outputPath);
const workerUrl = normalizePublicUrl(deployInfo?.targets?.[0] || "");
if (!workerUrl) {
  fail("部署完成，但未能从 Wrangler 输出中读取 Worker 地址。");
}
let serverUrl = publicUrl || workerUrl;

await writeState({
  accountId,
  workerName,
  dbName: databaseName,
  databaseId,
  workerUrl,
  publicUrl,
  cookieSecret,
  deployedAt: new Date().toISOString(),
});
await rm(outputPath, { force: true });

if (customDomain) {
  const bound = await bindCustomDomain(accountId, workerName, customDomain);
  if (bound && !publicUrl) {
    serverUrl = `https://${customDomain}`;
  }
}

let healthOk = false;
if (!skipCheck) {
  log("正在检查公网地址...");
  try {
    await waitForHealth(serverUrl);
    await checkAdmin(serverUrl);
    healthOk = true;
  } catch (error) {
    log(`健康检查未通过: ${error.message}`);
    log("部署本身已成功，但当前网络可能无法解析该地址（常见于 workers.dev）。");
    log("建议重新运行并加上 --custom-domain 绑定自己的域名，或使用 --skip-check。");
  }
}
await writeState({ serverUrl, healthCheck: healthOk });

console.log("");
console.log("============================================================");
console.log(healthOk || skipCheck
  ? " CodexLink Cloudflare 中继部署完成"
  : " CodexLink Cloudflare 中继已部署（健康检查未通过）");
console.log("============================================================");
console.log(` 服务器地址: ${serverUrl}`);
console.log(` 管理面板:   ${serverUrl}/admin`);
console.log(` 管理密码:   ${adminPassword}`);
console.log(` 密码文件:   ${passwordPath}`);
console.log("");
console.log(" 在电脑端 CodexLink 中填写服务器地址，并使用管理面板创建的");
console.log(" 电脑端令牌。手机端扫描电脑端生成的配对二维码即可。");
console.log("============================================================");

async function ensureD1(account, name) {
  const databases = await cloudflare(
    `/accounts/${account}/d1/database?per_page=100`,
    apiToken,
  );
  const existing = databases.find((item) => item.name === name);
  if (existing) {
    return existing.uuid;
  }
  log("未找到数据库，正在创建新的 D1 数据库...");
  const created = await cloudflare(
    `/accounts/${account}/d1/database`,
    apiToken,
    { method: "POST", body: JSON.stringify({ name }) },
  );
  if (!created?.uuid) {
    fail("D1 数据库创建失败：Cloudflare 未返回 database ID。");
  }
  return created.uuid;
}

async function discoverAccountId() {
  const accounts = await cloudflare("/accounts?per_page=50", apiToken);
  if (!Array.isArray(accounts) || accounts.length === 0) {
    fail("该 API Token 无法读取任何 Cloudflare 账号。");
  }
  if (accounts.length > 1) {
    const names = accounts.map((item) => `${item.name} (${item.id})`).join("\n");
    fail(`Token 可访问多个账号，请用 --account-id 指定：\n${names}`);
  }
  return accounts[0].id;
}

async function cloudflare(apiPath, token, options = {}) {
  const result = await cloudflareRequest(apiPath, token, options);
  if (!result.ok) {
    fail(`Cloudflare API 请求失败（HTTP ${result.status}）: ${result.error || apiPath}`);
  }
  return result.result;
}

async function cloudflareRequest(apiPath, token, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${apiPath}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success !== true) {
    const details = (payload.errors || [])
      .map((item) => item.message || JSON.stringify(item))
      .join("; ");
    return {
      ok: false,
      status: response.status,
      error: details || apiPath,
      result: null,
    };
  }
  return { ok: true, status: response.status, error: "", result: payload.result };
}

async function bindCustomDomain(account, worker, hostname) {
  const zones = await cloudflareRequest("/zones?per_page=100", apiToken);
  if (!zones.ok) {
    log(`无法读取域名列表，跳过自定义域名绑定: ${zones.error}`);
    return false;
  }
  const zone = (zones.result || [])
    .filter((item) => hostname === item.name || hostname.endsWith(`.${item.name}`))
    .sort((left, right) => right.name.length - left.name.length)[0];
  if (!zone) {
    log(`未在 Cloudflare 账号中找到 ${hostname} 所属域名，跳过自定义域名绑定。`);
    return false;
  }
  const bound = await cloudflareRequest(
    `/accounts/${account}/workers/domains`,
    apiToken,
    {
      method: "PUT",
      body: JSON.stringify({
        environment: "production",
        hostname,
        service: worker,
        zone_id: zone.id,
      }),
    },
  );
  if (!bound.ok) {
    log(`自定义域名绑定失败: ${bound.error}`);
    return false;
  }
  log(`自定义域名已绑定: https://${hostname}`);
  return true;
}

async function ensureWrangler() {
  const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
  try {
    await stat(wrangler);
    return;
  } catch {
    // Install dependencies below.
  }
  log("首次运行，正在安装部署依赖...");
  await run("npm", ["install", "--no-audit", "--no-fund"], root);
}

async function runWrangler(wranglerArgs, extraEnv = {}) {
  await run(
    process.execPath,
    [path.join(root, "node_modules", "wrangler", "bin", "wrangler.js"), ...wranglerArgs],
    root,
    {
      CLOUDFLARE_API_TOKEN: apiToken,
      CLOUDFLARE_ACCOUNT_ID: accountId,
      ...extraEnv,
    },
  );
}

function run(command, commandArgs, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`命令结束异常: ${command} (${signal || code})`));
    });
  }).catch((error) => fail(error.message));
}

async function readDeployOutput(file) {
  try {
    const raw = await readFile(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const event = JSON.parse(line);
        if (event.type === "deploy") {
          return event;
        }
      } catch {
        // Ignore non-JSON diagnostics.
      }
    }
  } catch {
    // Fall back to a health check-only deployment.
  }
  return null;
}

async function waitForHealth(url) {
  let lastError = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(8000) });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload.ok === true) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(2000);
  }
  throw new Error(lastError);
}

async function checkAdmin(url) {
  const response = await fetch(`${url}/admin`, { signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  if (!response.ok || !text.includes("管理登录")) {
    throw new Error("管理面板检查失败");
  }
}

async function writeState(extra = {}) {
  const current = await readJSON(statePath, {});
  await writeFile(
    statePath,
    JSON.stringify({ ...state, ...current, ...extra }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(statePath, 0o600).catch(() => undefined);
}

async function readTokenFile() {
  const candidates = [
    args["api-token-file"],
    path.join(repoRoot, "environment", "cloudflare", "api-token.txt"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const value = await readOptional(candidate);
    if (value) {
      return value;
    }
  }
  return "";
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

function normalizePublicUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    return "";
  }
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    fail("服务器地址必须使用 http:// 或 https://");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    fail("Cloudflare Worker 地址不支持子路径，请使用域名根路径。");
  }
  if (url.search || url.hash) {
    fail("服务器地址不能包含查询参数或锚点。");
  }
  return url.origin;
}

function normalizeHostname(raw) {
  const value = String(raw || "").trim().toLowerCase().replace(/\/+$/, "");
  if (!value) {
    return "";
  }
  if (value.includes("://") || value.includes("/") || value.includes(":")) {
    fail("--custom-domain 只填写域名，例如 relay.example.com");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(value)) {
    fail("自定义域名格式不正确，例如 relay.example.com");
  }
  return value;
}

function sanitizeWorkerName(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value)) {
    fail("Worker 名称只能包含小写字母、数字和中划线，长度为 3-63。");
  }
  return value;
}

function sanitizeDatabaseName(raw) {
  const value = String(raw || "").trim();
  if (!/^[A-Za-z0-9_-]{3,63}$/.test(value)) {
    fail("D1 数据库名称只能包含字母、数字、下划线和中划线，长度为 3-63。");
  }
  return value;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function randomToken(bytes) {
  return randomBytes(bytes).toString("base64url");
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

function printHelp() {
  console.log(`
CodexLink Cloudflare 一键部署

用法:
  node scripts/install.mjs [选项]

选项:
  --api-token <token>         Cloudflare API Token（也可用 CLOUDFLARE_API_TOKEN）
  --api-token-file <path>     从文件读取 API Token
  --account-id <id>           Cloudflare Account ID
  --worker-name <name>        Worker 名称，默认 codexlink-relay
  --db-name <name>            D1 数据库名称，默认与 Worker 相同
  --public-url <url>          已绑定的自定义域名（可选）
  --custom-domain <host>      自动绑定 Cloudflare 自定义域名（可选）
  --admin-password <value>    管理面板密码；未提供则自动生成
  --reset-admin-password      重新生成管理密码
  --skip-check                跳过部署后的公网健康检查
  --help                      显示帮助

Token 权限:
  Workers Scripts:Edit
  D1:Edit
  Zone:Read（仅自动绑定自定义域名时需要）
`);
}

function log(message) {
  console.log(`[CodexLink] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  console.error(`\n[CodexLink] 错误: ${message}\n`);
  process.exit(1);
}
