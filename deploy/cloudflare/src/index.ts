import {
  ErrorBadRequest,
  ErrorDeviceMismatch,
  ErrorMethodBlocked,
  ErrorScopeDenied,
  ErrorUnauthorized,
  MessageTypeSessions,
  PathDesktopConnect,
  PathDesktopRevoke,
  PathDesktopSessions,
  PathHealth,
  PathMobileConnect,
  PathMobileRPC,
  PathPairClaim,
  addDaysISO,
  base64url,
  errorResponse,
  hashToken,
  jsonResponse,
  maxFileChunkBytes,
  mobileMethodAllowed,
  normalizeMobileScopes,
  normalizePairCode,
  nowISO,
  randomID,
  randomToken,
  tokenHint,
  validDeviceID,
  validSessionID,
  allowedMobileMethods,
} from "./protocol";
import type { Env } from "./env";
import { dashboardPage, loginPage } from "./admin-page";

export { DeviceRoom } from "./device-room";
export { RateLimiter } from "./rate-limiter";

const ADMIN_COOKIE = "codexlink_admin";
const ADMIN_TTL_MS = 12 * 60 * 60 * 1000;

interface DesktopTokenRow {
  id: string;
  name: string;
  token_hash: string;
  hint: string;
  created_at: string;
  last_used_at: string | null;
  bound_device_id: string | null;
  source: string | null;
  revoked_at: string | null;
}

interface SessionRow {
  token_hash: string;
  session_id: string;
  device_id: string;
  device_name: string | null;
  created_at: string;
  expires_at: string;
  scopes: string;
  revoked_at: string | null;
}

interface AdminPayload {
  exp: number;
  csrf: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      console.error("relay error", error);
      return errorResponse("internal_error", 500);
    }
  },
};

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === PathHealth) {
    if (request.method !== "GET") {
      return errorResponse("method not allowed", 405);
    }
    return jsonResponse({
      ok: true,
      service: "codexlink-relay",
      runtime: "cloudflare-workers",
      time: nowISO(),
    });
  }
  if (path === "/admin" || path.startsWith("/admin/")) {
    return handleAdmin(request, env, ctx);
  }
  if (path === PathDesktopConnect) {
    return handleDesktopConnect(request, env, ctx);
  }
  if (path === PathMobileConnect) {
    return handleMobileConnect(request, env);
  }
  if (path === PathMobileRPC) {
    return handleMobileRPC(request, env);
  }
  if (path === PathPairClaim) {
    return handlePairClaim(request, env);
  }
  if (path === PathDesktopSessions) {
    return handleDesktopSessions(request, env);
  }
  if (path === PathDesktopRevoke) {
    return handleDesktopRevoke(request, env);
  }
  return errorResponse("not_found", 404);
}

async function handleDesktopConnect(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "GET") {
    return errorResponse("method not allowed", 405);
  }
  const url = new URL(request.url);
  const deviceId = (url.searchParams.get("device") || "").trim();
  if (!validDeviceID(deviceId)) {
    return errorResponse("invalid device id", 400);
  }
  const auth = await authenticateDesktop(request, env, deviceId);
  if (auth.response) {
    return auth.response;
  }
  const record = auth.record!;
  const paired = await countSessions(env, deviceId);
  const headers = new Headers(request.headers);
  headers.set("x-codexlink-role", "desktop");
  headers.set("x-codexlink-device", deviceId);
  headers.set("x-codexlink-name", (url.searchParams.get("name") || "").slice(0, 80));
  headers.set("x-codexlink-token-id", record.id);
  headers.set("x-codexlink-paired", String(paired));
  const stub = deviceRoom(env, deviceId);
  ctx.waitUntil(markTokenUsed(env, record));
  return stub.fetch(new Request(request, { method: "GET", headers }));
}

async function handleMobileConnect(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return errorResponse("method not allowed", 405);
  }
  const auth = await authenticateMobile(request, env);
  if (auth.response) {
    return auth.response;
  }
  const session = auth.session!;
  const url = new URL(request.url);
  const requested = (url.searchParams.get("device") || "").trim();
  if (requested && requested !== session.device_id) {
    return errorResponse(ErrorDeviceMismatch, 403);
  }
  const headers = new Headers(request.headers);
  headers.set("x-codexlink-role", "mobile");
  headers.set("x-codexlink-device", session.device_id);
  headers.set("x-codexlink-name", session.device_name || "");
  headers.set("x-codexlink-session", session.session_id);
  headers.set("x-codexlink-scopes", session.scopes);
  headers.set("x-codexlink-paired", "0");
  const stub = deviceRoom(env, session.device_id);
  return stub.fetch(new Request(request, { method: "GET", headers }));
}

async function handleMobileRPC(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("method not allowed", 405);
  }
  const auth = await authenticateMobile(request, env);
  if (auth.response) {
    return auth.response;
  }
  const session = auth.session!;
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > maxFileChunkBytes + 64 * 1024) {
    return errorResponse("request too large", 413);
  }
  const raw = await request.text();
  if (raw.length > maxFileChunkBytes + 64 * 1024) {
    return errorResponse("request too large", 413);
  }
  const headerMethod = request.headers.get("x-codexlink-method") || "";
  const method = headerMethod.trim() || methodFromJSONPrefix(raw);
  if (!method) {
    return errorResponse(ErrorBadRequest, 400);
  }
  if (!allowedMobileMethods.has(method)) {
    return errorResponse(ErrorMethodBlocked, 403);
  }
  if (!mobileMethodAllowed(method, scopesFromJSON(session.scopes))) {
    return errorResponse(ErrorScopeDenied, 403);
  }
  const headers = new Headers({
    "Content-Type": "application/json",
    "x-codexlink-scopes": session.scopes,
    "x-codexlink-device": session.device_id,
    "x-codexlink-session": session.session_id,
    "x-codexlink-method": method,
  });
  const stub = deviceRoom(env, session.device_id);
  const response = await stub.fetch("https://device-room/v1/mobile/rpc", {
    method: "POST",
    headers,
    body: raw,
  });
  const text = await response.text();
  const outHeaders = new Headers(response.headers);
  outHeaders.set("Cache-Control", "no-store");
  outHeaders.set("X-Content-Type-Options", "nosniff");
  return new Response(text, { status: response.status, headers: outHeaders });
}

async function handlePairClaim(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("method not allowed", 405);
  }
  const ip = clientIP(request);
  if (!(await allowRequest(env, `pair:${ip}`, 10, 600))) {
    return errorResponse("too many pairing attempts", 429);
  }
  const raw = await request.text();
  if (raw.length > 8 * 1024) {
    return errorResponse("invalid request", 400);
  }
  let body: { code?: string; name?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    return errorResponse("invalid request", 400);
  }
  const code = normalizePairCode(body.code || "");
  if (!code) {
    return errorResponse("pairing code is required", 400);
  }
  const row = await env.DB.prepare(
    "SELECT code, device_id, expires_at FROM pair_codes WHERE code = ?",
  )
    .bind(code)
    .first<{ code: string; device_id: string; expires_at: string }>();
  if (!row) {
    return errorResponse("pairing code expired or invalid", 410);
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    await env.DB.prepare("DELETE FROM pair_codes WHERE code = ?").bind(code).run().catch(() => undefined);
    return errorResponse("pairing code expired or invalid", 410);
  }
  const stub = deviceRoom(env, row.device_id);
  const response = await stub.fetch("https://device-room/pair/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name: body.name || "", deviceId: row.device_id }),
  });
  const text = await response.text();
  return new Response(text, {
    status: response.status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function handleDesktopSessions(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return errorResponse("method not allowed", 405);
  }
  const url = new URL(request.url);
  const deviceId = (url.searchParams.get("device") || "").trim();
  if (!validDeviceID(deviceId)) {
    return errorResponse("invalid device id", 400);
  }
  const auth = await authenticateDesktop(request, env, deviceId);
  if (auth.response) {
    return auth.response;
  }
  const rows = await env.DB.prepare(
    "SELECT * FROM mobile_sessions WHERE device_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC",
  )
    .bind(deviceId, nowISO())
    .all<SessionRow>();
  let active: string[] = [];
  try {
    const presence = await deviceRoom(env, deviceId).fetch("https://device-room/presence");
    const data = (await presence.json()) as { sessions?: string[] };
    active = Array.isArray(data.sessions) ? data.sessions : [];
  } catch {
    active = [];
  }
  const sessions = (rows.results || []).map((row) => ({
    id: row.session_id,
    deviceName: row.device_name || "",
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    active: active.includes(row.session_id),
    scopes: scopesFromJSON(row.scopes),
  }));
  return jsonResponse({ sessions, count: sessions.length });
}

async function handleDesktopRevoke(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("method not allowed", 405);
  }
  const raw = await request.text();
  if (raw.length > 8 * 1024) {
    return errorResponse(ErrorBadRequest, 400);
  }
  let body: { deviceId?: string; sessionId?: string; all?: boolean };
  try {
    body = JSON.parse(raw);
  } catch {
    return errorResponse(ErrorBadRequest, 400);
  }
  const deviceId = String(body.deviceId || "").trim();
  const sessionId = String(body.sessionId || "").trim();
  if (!validDeviceID(deviceId)) {
    return errorResponse("invalid device id", 400);
  }
  const auth = await authenticateDesktop(request, env, deviceId);
  if (auth.response) {
    return auth.response;
  }
  if (!body.all && !validSessionID(sessionId)) {
    return errorResponse("invalid session id", 400);
  }
  const rows = await env.DB.prepare(
    body.all
      ? "SELECT session_id FROM mobile_sessions WHERE device_id = ?"
      : "SELECT session_id FROM mobile_sessions WHERE device_id = ? AND session_id = ?",
  )
    .bind(...(body.all ? [deviceId] : [deviceId, sessionId]))
    .all<{ session_id: string }>();
  const ids = (rows.results || []).map((row) => row.session_id);
  if (body.all) {
    await env.DB.prepare("DELETE FROM mobile_sessions WHERE device_id = ?").bind(deviceId).run();
  } else {
    await env.DB.prepare("DELETE FROM mobile_sessions WHERE device_id = ? AND session_id = ?")
      .bind(deviceId, sessionId)
      .run();
  }
  await deviceRoom(env, deviceId)
    .fetch("https://device-room/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionIds: ids, all: !!body.all, deviceId }),
    })
    .catch(() => undefined);
  return jsonResponse({ revoked: ids.length });
}

async function authenticateDesktop(
  request: Request,
  env: Env,
  deviceId: string,
): Promise<{ record?: DesktopTokenRow; response?: Response }> {
  const token = bearerToken(request);
  if (!token) {
    return { response: errorResponse(ErrorUnauthorized, 401) };
  }
  const row = await env.DB.prepare(
    "SELECT * FROM desktop_tokens WHERE token_hash = ? AND revoked_at IS NULL",
  )
    .bind(await hashToken(token))
    .first<DesktopTokenRow>();
  if (!row) {
    return { response: errorResponse(ErrorUnauthorized, 401) };
  }
  if (row.bound_device_id && row.bound_device_id !== deviceId) {
    return { response: errorResponse(ErrorDeviceMismatch, 403) };
  }
  if (!row.bound_device_id) {
    await env.DB.prepare(
      "UPDATE desktop_tokens SET bound_device_id = ? WHERE id = ? AND (bound_device_id IS NULL OR bound_device_id = '')",
    )
      .bind(deviceId, row.id)
      .run();
    row.bound_device_id = deviceId;
  }
  return { record: row };
}

async function authenticateMobile(
  request: Request,
  env: Env,
): Promise<{ session?: SessionRow; response?: Response }> {
  const token = bearerToken(request);
  if (!token) {
    return { response: errorResponse(ErrorUnauthorized, 401) };
  }
  const session = await env.DB.prepare(
    "SELECT * FROM mobile_sessions WHERE token_hash = ? AND revoked_at IS NULL",
  )
    .bind(await hashToken(token))
    .first<SessionRow>();
  if (!session || Date.parse(session.expires_at) <= Date.now()) {
    return { response: errorResponse(ErrorUnauthorized, 401) };
  }
  return { session };
}

async function markTokenUsed(env: Env, record: DesktopTokenRow): Promise<void> {
  const last = record.last_used_at ? Date.parse(record.last_used_at) : 0;
  if (Date.now() - last < 5 * 60_000) {
    return;
  }
  await env.DB.prepare("UPDATE desktop_tokens SET last_used_at = ? WHERE id = ?")
    .bind(nowISO(), record.id)
    .run()
    .catch(() => undefined);
}

async function countSessions(env: Env, deviceId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM mobile_sessions WHERE device_id = ? AND revoked_at IS NULL AND expires_at > ?",
  )
    .bind(deviceId, nowISO())
    .first<{ n: number }>();
  return Number(row?.n || 0);
}

function deviceRoom(env: Env, deviceId: string): DurableObjectStub {
  return env.DEVICE_ROOM.get(env.DEVICE_ROOM.idFromName(deviceId));
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") || "";
  if (!header.toLowerCase().startsWith("bearer ")) {
    return "";
  }
  return header.slice(7).trim();
}

function clientIP(request: Request): string {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

async function allowRequest(
  env: Env,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName("global"));
  const query = `key=${encodeURIComponent(key)}&limit=${limit}&window=${windowSeconds}`;
  const response = await stub.fetch(`https://rate-limiter/check?${query}`);
  return response.status === 200;
}

async function handleAdmin(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (!env.ADMIN_TOKEN || !env.COOKIE_SECRET) {
    return new Response("服务器未配置管理密码", { status: 503 });
  }
  if (url.pathname === "/admin" && request.method === "GET") {
    const payload = await verifyAdminCookie(request, env);
    if (!payload) {
      return loginPage();
    }
    return dashboardPage(env.PUBLIC_URL || url.origin, payload.csrf);
  }
  if (url.pathname === "/admin/login" && request.method === "POST") {
    if (!(await allowRequest(env, `admin:${clientIP(request)}`, 10, 600))) {
      return loginPage("尝试次数过多，请稍后再试");
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return loginPage("请求格式不正确");
    }
    const password = String(form.get("password") || "");
    if (!(await constantTimeEqual(password, env.ADMIN_TOKEN))) {
      return loginPage("管理密码不正确");
    }
    const cookie = await createAdminCookie(env);
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/admin",
        "Set-Cookie": `${ADMIN_COOKIE}=${cookie.value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`,
        "Cache-Control": "no-store",
      },
    });
  }
  if (url.pathname === "/admin/logout" && request.method === "POST") {
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/admin",
        "Set-Cookie": `${ADMIN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
        "Cache-Control": "no-store",
      },
    });
  }
  const payload = await verifyAdminCookie(request, env);
  if (!payload) {
    return errorResponse(ErrorUnauthorized, 401);
  }
  if (url.pathname.startsWith("/admin/api/")) {
    if (request.method !== "GET") {
      const csrf = request.headers.get("x-csrf-token") || "";
      if (!(await constantTimeEqual(csrf, payload.csrf))) {
        return errorResponse("invalid csrf token", 403);
      }
    }
    return handleAdminAPI(request, env, url, ctx);
  }
  return errorResponse("not_found", 404);
}

async function handleAdminAPI(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response> {
  if (url.pathname === "/admin/api/state" && request.method === "GET") {
    return adminState(env, url.origin);
  }
  if (url.pathname === "/admin/api/tokens" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as { name?: string } | null;
    const name = String(body?.name || "").trim().slice(0, 80);
    if (!name) {
      return errorResponse("name is required", 400);
    }
    const token = randomToken(32);
    const id = randomID(8);
    await env.DB.prepare(
      "INSERT INTO desktop_tokens (id, name, token_hash, hint, created_at, source) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(id, name, await hashToken(token), tokenHint(token), nowISO(), "admin")
      .run();
    return jsonResponse({ token, record: { id, name, hint: tokenHint(token), createdAt: nowISO() } });
  }
  const tokenMatch = url.pathname.match(/^\/admin\/api\/tokens\/([A-Za-z0-9_-]+)(\/unbind)?$/);
  if (tokenMatch) {
    const id = tokenMatch[1];
    const unbind = !!tokenMatch[2];
    const row = await env.DB.prepare("SELECT * FROM desktop_tokens WHERE id = ?")
      .bind(id)
      .first<DesktopTokenRow>();
    if (!row) {
      return errorResponse("token not found", 404);
    }
    if (unbind && request.method === "POST") {
      await env.DB.prepare("UPDATE desktop_tokens SET bound_device_id = NULL WHERE id = ?").bind(id).run();
      if (row.bound_device_id) {
        await env.DB.prepare("DELETE FROM mobile_sessions WHERE device_id = ?")
          .bind(row.bound_device_id)
          .run();
        ctx.waitUntil(kickDevice(env, row.bound_device_id, { desktop: true, mobile: true }));
      }
      return jsonResponse({ ok: true });
    }
    if (!unbind && request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM desktop_tokens WHERE id = ?").bind(id).run();
      if (row.bound_device_id) {
        await env.DB.prepare("DELETE FROM mobile_sessions WHERE device_id = ?")
          .bind(row.bound_device_id)
          .run();
        ctx.waitUntil(kickDevice(env, row.bound_device_id, { desktop: true, mobile: true }));
      }
      return jsonResponse({ ok: true });
    }
    return errorResponse("method not allowed", 405);
  }
  if (url.pathname === "/admin/api/sessions/revoke" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as
      | { deviceId?: string; sessionId?: string; all?: boolean }
      | null;
    const deviceId = String(body?.deviceId || "").trim();
    const sessionId = String(body?.sessionId || "").trim();
    if (!validDeviceID(deviceId)) {
      return errorResponse("invalid device id", 400);
    }
    const rows = await env.DB.prepare(
      body?.all
        ? "SELECT session_id FROM mobile_sessions WHERE device_id = ?"
        : "SELECT session_id FROM mobile_sessions WHERE device_id = ? AND session_id = ?",
    )
      .bind(...(body?.all ? [deviceId] : [deviceId, sessionId]))
      .all<{ session_id: string }>();
    const ids = (rows.results || []).map((row) => row.session_id);
    if (body?.all) {
      await env.DB.prepare("DELETE FROM mobile_sessions WHERE device_id = ?").bind(deviceId).run();
    } else {
      await env.DB.prepare("DELETE FROM mobile_sessions WHERE device_id = ? AND session_id = ?")
        .bind(deviceId, sessionId)
        .run();
    }
    ctx.waitUntil(
      deviceRoom(env, deviceId)
        .fetch("https://device-room/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionIds: ids, all: !!body?.all, deviceId }),
        })
        .then(() => undefined)
        .catch(() => undefined),
    );
    return jsonResponse({ revoked: ids.length });
  }
  return errorResponse("not_found", 404);
}

async function adminState(env: Env, origin: string): Promise<Response> {
  const tokens = await env.DB.prepare(
    "SELECT * FROM desktop_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 100",
  ).all<DesktopTokenRow>();
  const sessions = await env.DB.prepare(
    "SELECT * FROM mobile_sessions WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 200",
  )
    .bind(nowISO())
    .all<SessionRow>();
  const tokenRows = tokens.results || [];
  const sessionRows = sessions.results || [];
  const checked = tokenRows.filter((row) => row.bound_device_id).slice(0, 20);
  const deviceIds = [...new Set(checked.map((row) => row.bound_device_id!))];
  const presenceByDevice = new Map<string, { desktopOnline: boolean; sessions: string[] }>();
  await Promise.all(
    deviceIds.map(async (deviceId) => {
      try {
        const response = await deviceRoom(env, deviceId).fetch("https://device-room/presence");
        const data = (await response.json()) as { desktopOnline?: boolean; sessions?: string[] };
        presenceByDevice.set(deviceId, {
          desktopOnline: data.desktopOnline === true,
          sessions: Array.isArray(data.sessions) ? data.sessions : [],
        });
      } catch {
        presenceByDevice.set(deviceId, { desktopOnline: false, sessions: [] });
      }
    }),
  );
  let onlineDesktops = 0;
  const activeSessions = new Set<string>();
  for (const presence of presenceByDevice.values()) {
    if (presence.desktopOnline) {
      onlineDesktops += 1;
    }
    for (const id of presence.sessions) {
      activeSessions.add(id);
    }
  }
  return jsonResponse({
    ok: true,
    secure: true,
    tokenCount: tokenRows.length,
    sessionCount: sessionRows.length,
    onlineDesktops,
    addresses: [
      {
        url: env.PUBLIC_URL || origin,
        label: "Cloudflare Workers",
        note: "由 Cloudflare 自动提供 HTTPS/WSS，无需配置证书。",
        secure: true,
        recommended: true,
      },
    ],
    tokens: tokenRows.map((row) => ({
      id: row.id,
      name: row.name,
      hint: row.hint,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at || "",
      source: row.source || "",
      boundDeviceId: row.bound_device_id || "",
    })),
    sessions: sessionRows.map((row) => ({
      id: row.session_id,
      deviceId: row.device_id,
      deviceName: row.device_name || "",
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      scopes: scopesFromJSON(row.scopes),
      active: activeSessions.has(row.session_id),
    })),
  });
}

async function kickDevice(env: Env, deviceId: string, body: object): Promise<void> {
  await deviceRoom(env, deviceId)
    .fetch("https://device-room/kick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    .then(() => undefined)
    .catch(() => undefined);
}

async function createAdminCookie(env: Env): Promise<{ value: string; csrf: string }> {
  const payload: AdminPayload = { exp: Date.now() + ADMIN_TTL_MS, csrf: randomToken(18) };
  const data = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacHex(env.COOKIE_SECRET, data);
  return { value: `${data}.${signature}`, csrf: payload.csrf };
}

async function verifyAdminCookie(request: Request, env: Env): Promise<AdminPayload | null> {
  const raw = readCookie(request, ADMIN_COOKIE);
  if (!raw) {
    return null;
  }
  const index = raw.lastIndexOf(".");
  if (index <= 0) {
    return null;
  }
  const data = raw.slice(0, index);
  const signature = raw.slice(index + 1);
  const expected = await hmacHex(env.COOKIE_SECRET, data);
  if (!(await constantTimeEqual(signature, expected))) {
    return null;
  }
  try {
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64url(data))) as AdminPayload;
    if (!payload || typeof payload.exp !== "number" || payload.exp <= Date.now() || !payload.csrf) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function decodeBase64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function readCookie(request: Request, name: string): string {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const index = trimmed.indexOf("=");
    if (index > 0 && trimmed.slice(0, index) === name) {
      return trimmed.slice(index + 1);
    }
  }
  return "";
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([hashToken(a), hashToken(b)]);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

function methodFromJSONPrefix(raw: string): string {
  const match = raw.slice(0, 2048).match(/"method"\s*:\s*"([^"\\]*)"/);
  return match ? match[1].trim() : "";
}

function scopesFromJSON(raw: string): string[] {
  try {
    const value = JSON.parse(raw || "[]");
    return normalizeMobileScopes(Array.isArray(value) ? value : []);
  } catch {
    return normalizeMobileScopes([]);
  }
}
