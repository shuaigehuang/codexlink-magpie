#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = parseArgs(process.argv.slice(2));
const state = await readJSON(path.join(root, ".install-state.json"), {});
const accountId = String(args["account-id"] || state.accountId || "").trim();
const databaseId = String(args["database-id"] || state.databaseId || "").trim();
const token = String(
  args["api-token"]
  || process.env.CLOUDFLARE_API_TOKEN
  || await readOptional(path.join(path.dirname(path.dirname(root)), "environment", "cloudflare", "api-token.txt"))
  || "",
).trim();
const dataDir = path.resolve(args["data-dir"] || path.join(root, "import-data"));
const dryRun = args["dry-run"] === true;

if (!accountId || !databaseId || !token) {
  fail("缺少账号、D1 数据库或 API Token。请先运行 install.mjs，或传入 --account-id/--database-id/--api-token。");
}

const tokens = await readJSON(path.join(dataDir, "desktop_tokens.json"), []);
const sessions = await readJSON(path.join(dataDir, "sessions.json"), []);
if (!Array.isArray(tokens) || !Array.isArray(sessions)) {
  fail("数据文件格式不正确，应为 JSON 数组。");
}

let importedTokens = 0;
let importedSessions = 0;
for (const record of tokens) {
  const tokenHash = String(record.tokenHash || "").trim();
  if (!tokenHash) {
    continue;
  }
  const id = String(record.id || randomID(8));
  const name = String(record.name || "迁移的电脑令牌").slice(0, 80);
  const hint = String(record.tokenHint || "...").slice(0, 80);
  const createdAt = String(record.createdAt || new Date().toISOString());
  if (!dryRun) {
    await d1(
      `INSERT OR IGNORE INTO desktop_tokens
       (id, name, token_hash, hint, created_at, last_used_at, bound_device_id, source, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        id,
        name,
        tokenHash,
        hint,
        createdAt,
        record.lastUsedAt ? String(record.lastUsedAt) : null,
        record.deviceId ? String(record.deviceId) : null,
        record.source ? String(record.source) : "go-relay",
      ],
    );
  }
  importedTokens += 1;
}

const now = Date.now();
for (const record of sessions) {
  const tokenHash = String(record.tokenHash || "").trim();
  const deviceId = String(record.deviceId || "").trim();
  const expiresAt = String(record.expiresAt || "").trim();
  if (!tokenHash || !deviceId || !expiresAt || Date.parse(expiresAt) <= now) {
    continue;
  }
  const sessionId = String(record.sessionId || sessionIDForToken(tokenHash));
  const createdAt = String(record.createdAt || new Date(Date.parse(expiresAt) - 90 * 86400000).toISOString());
  const scopes = normalizeScopes(record.scopes);
  if (!dryRun) {
    await d1(
      `INSERT OR IGNORE INTO mobile_sessions
       (token_hash, session_id, device_id, device_name, created_at, expires_at, scopes, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        tokenHash,
        sessionId,
        deviceId,
        String(record.deviceName || "").slice(0, 80),
        createdAt,
        expiresAt,
        JSON.stringify(scopes),
      ],
    );
  }
  importedSessions += 1;
}

console.log("");
console.log(dryRun ? "迁移预检完成（未写入）" : "迁移完成");
console.log(`  电脑令牌: ${importedTokens}`);
console.log(`  手机授权: ${importedSessions}`);

async function d1(sql, params) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success !== true) {
    const details = (payload.errors || []).map((item) => item.message).join("; ");
    fail(`D1 写入失败: ${details || `HTTP ${response.status}`}`);
  }
  return payload.result;
}

function normalizeScopes(raw) {
  const allowed = new Set(["read", "chat", "files", "magpie-admin"]);
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const value = String(item).trim().toLowerCase();
    if (allowed.has(value) && !out.includes(value)) {
      out.push(value);
    }
  }
  if (!out.includes("read")) {
    out.unshift("read");
  }
  return out;
}

function sessionIDForToken(tokenHash) {
  return createHash("sha256")
    .update(`codexlink-session:${tokenHash}`)
    .digest("hex")
    .slice(0, 24);
}

function randomID(bytes) {
  return randomBytes(bytes).toString("hex");
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
