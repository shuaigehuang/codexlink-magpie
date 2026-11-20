export const PathHealth = "/healthz";
export const PathDesktopConnect = "/v1/desktop/connect";
export const PathDesktopSessions = "/v1/desktop/sessions";
export const PathDesktopRevoke = "/v1/desktop/sessions/revoke";
export const PathMobileConnect = "/v1/mobile/connect";
export const PathMobileRPC = "/v1/mobile/rpc";
export const PathPairClaim = "/v1/pair/claim";
export const PathAdmin = "/admin";

export const MessageTypeHello = "hello";
export const MessageTypeError = "error";
export const MessageTypePair = "pair.create";
export const MessageTypePaired = "pair.created";
export const MessageTypeSessions = "sessions.updated";
export const MessageTypeRPC = "rpc";
export const MessageTypeRPCResult = "rpc.result";

export const ErrorDesktopOffline = "desktop_offline";
export const ErrorUnauthorized = "unauthorized";
export const ErrorBadRequest = "bad_request";
export const ErrorMethodBlocked = "method_not_allowed";
export const ErrorDeviceMismatch = "device_mismatch";
export const ErrorScopeDenied = "scope_denied";

export const ScopeRead = "read";
export const ScopeChat = "chat";
export const ScopeFiles = "files";
export const ScopeMagpieAdmin = "magpie-admin";

export const allowedMobileScopes = new Set([
  ScopeRead,
  ScopeChat,
  ScopeFiles,
  ScopeMagpieAdmin,
]);

export const mobileMethodScopes: Record<string, string> = {
  "node.status": ScopeRead,
  "threads.list": ScopeRead,
  "threads.read": ScopeRead,
  "threads.send": ScopeChat,
  "files.begin": ScopeFiles,
  "files.chunk": ScopeFiles,
  "files.finish": ScopeFiles,
  "files.cancel": ScopeFiles,
  "magpie.status": ScopeRead,
  "magpie.admin.status": ScopeRead,
  "magpie.admin.initialize": ScopeMagpieAdmin,
  "magpie.keys.create": ScopeMagpieAdmin,
  "magpie.keys.rotate": ScopeMagpieAdmin,
  "magpie.keys.toggle": ScopeMagpieAdmin,
  "magpie.keys.delete": ScopeMagpieAdmin,
};

export const allowedMobileMethods = new Set([
  "ping",
  ...Object.keys(mobileMethodScopes),
]);

export const maxMessageBytes = 9 * 1024 * 1024;
export const maxRPCParamsBytes = 1 * 1024 * 1024;
export const maxFileChunkBytes = 6 * 1024 * 1024;
export const maxPendingPerDevice = 32;

export interface Message {
  type: string;
  requestId?: string;
  method?: string;
  params?: unknown;
  ok?: boolean;
  result?: unknown;
  error?: string;
  code?: string;
  expiresAt?: string;
  deviceId?: string;
  deviceName?: string;
  pairedSessions?: number;
  scopes?: string[];
}

export interface PairClaimRequest {
  code: string;
  name?: string;
}

export interface PairClaimResponse {
  token: string;
  deviceId: string;
  deviceName?: string;
  expiresAt: string;
  scopes: string[];
}

export function normalizeMobileScopes(input: unknown): string[] {
  const values = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = String(raw ?? "").trim().toLowerCase();
    if (!allowedMobileScopes.has(value) || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  if (!seen.has(ScopeRead)) {
    out.unshift(ScopeRead);
  }
  return out;
}

export function mobileMethodAllowed(method: string, scopes: string[]): boolean {
  if (!allowedMobileMethods.has(method)) {
    return false;
  }
  if (method === "ping") {
    return true;
  }
  const required = mobileMethodScopes[method];
  return !!required && normalizeMobileScopes(scopes).includes(required);
}

export function maxParamsBytesForMethod(method: string): number {
  return method === "files.chunk" ? maxFileChunkBytes : maxRPCParamsBytes;
}

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function randomPairCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  let acc = 0;
  let bits = 0;
  let out = "";
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += crockford[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

export function normalizePairCode(raw: string): string {
  const code = String(raw ?? "")
    .toUpperCase()
    .replace(/[-\s]/g, "")
    .replace(/I/g, "1")
    .replace(/L/g, "1")
    .replace(/O/g, "0")
    .replace(/U/g, "V");
  if (code.length !== 8) {
    return "";
  }
  for (const char of code) {
    if (!crockford.includes(char)) {
      return "";
    }
  }
  return code;
}

export function validDeviceID(value: string): boolean {
  if (value.length < 8 || value.length > 64) {
    return false;
  }
  return /^[A-Za-z0-9_-]+$/.test(value);
}

export function validSessionID(value: string): boolean {
  if (value.length < 8 || value.length > 64) {
    return false;
  }
  return /^[A-Za-z0-9_-]+$/.test(value);
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function randomID(bytes = 12): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function tokenHint(token: string): string {
  return token.length <= 4 ? token : `...${token.slice(-4)}`;
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function addMinutesISO(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function addDaysISO(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(body), { status, headers });
}

export function errorResponse(error: string, status: number): Response {
  return jsonResponse({ error }, status);
}

export function rpcResultMessage(
  requestID: string,
  ok: boolean,
  result?: unknown,
  error?: string,
): Message {
  const message: Message = { type: MessageTypeRPCResult, requestId: requestID, ok };
  if (ok && result !== undefined) {
    message.result = result;
  }
  if (!ok) {
    message.ok = false;
    message.error = error ?? "rpc failed";
  }
  return message;
}
