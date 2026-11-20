import {
  ErrorBadRequest,
  ErrorDesktopOffline,
  ErrorMethodBlocked,
  ErrorScopeDenied,
  MessageTypeError,
  MessageTypeHello,
  MessageTypePair,
  MessageTypePaired,
  MessageTypeRPC,
  MessageTypeRPCResult,
  MessageTypeSessions,
  PathDesktopConnect,
  PathMobileConnect,
  PathMobileRPC,
  addDaysISO,
  addMinutesISO,
  errorResponse,
  hashToken,
  jsonResponse,
  maxFileChunkBytes,
  maxMessageBytes,
  maxParamsBytesForMethod,
  maxPendingPerDevice,
  mobileMethodAllowed,
  normalizeMobileScopes,
  normalizePairCode,
  nowISO,
  randomID,
  randomPairCode,
  randomToken,
  rpcResultMessage,
  type Message,
  type PairClaimResponse,
} from "./protocol";
import type { Env } from "./env";

const HTTP_RPC_TIMEOUT_MS = 115_000;
const WS_RPC_TIMEOUT_MS = 120_000;

interface Attachment {
  role: "desktop" | "mobile";
  deviceId: string;
  name?: string;
  sessionID?: string;
  scopes?: string[];
  tokenID?: string;
  paired?: number;
}

interface PendingRecord {
  kind: "ws";
  requestId: string;
  deviceId: string;
  mobileSessionID: string;
  mobileRequestID: string;
  method: string;
  expiresAt: number;
}

interface HTTPPending {
  kind: "http";
  deviceId: string;
  method: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (message: Message) => void;
}

export class DeviceRoom {
  private state: DurableObjectState;
  private env: Env;
  private httpPending = new Map<string, HTTPPending>();
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case PathDesktopConnect:
      case PathMobileConnect:
        return this.handleSocket(request);
      case PathMobileRPC:
        return this.handleHTTPRPC(request);
      case "/pair/claim":
        return this.handlePairClaim(request);
      case "/revoke":
        return this.handleRevoke(request);
      case "/presence":
        return jsonResponse(this.presence());
      case "/kick":
        return this.handleKick(request);
      default:
        return errorResponse("not_found", 404);
    }
  }

  private handleSocket(request: Request): Response {
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return errorResponse("websocket_upgrade_required", 426);
    }
    const role = request.headers.get("x-codexlink-role");
    const deviceId = request.headers.get("x-codexlink-device") || "";
    if (role !== "desktop" && role !== "mobile") {
      return errorResponse(ErrorBadRequest, 400);
    }
    const pair = new WebSocketPair();
    const client = (pair as unknown as WebSocket[])[0];
    const server = (pair as unknown as WebSocket[])[1];
    const attachment: Attachment = {
      role,
      deviceId,
      name: request.headers.get("x-codexlink-name") || "",
      sessionID: request.headers.get("x-codexlink-session") || undefined,
      scopes: normalizeMobileScopes(parseStringArray(request.headers.get("x-codexlink-scopes"))),
      tokenID: request.headers.get("x-codexlink-token-id") || undefined,
      paired: Number(request.headers.get("x-codexlink-paired") || 0) || 0,
    };

    if (role === "desktop") {
      for (const old of this.state.getWebSockets("desktop")) {
        try {
          old.close(4000, "replaced");
        } catch {
          // The old connection is already closing.
        }
      }
    } else if (attachment.sessionID) {
      for (const old of this.state.getWebSockets("mobile")) {
        const oldAttachment = old.deserializeAttachment() as Attachment | null;
        if (oldAttachment?.sessionID === attachment.sessionID) {
          try {
            old.close(4000, "replaced");
          } catch {
            // The old connection is already closing.
          }
        }
      }
    }

    this.state.acceptWebSocket(server, [role]);
    server.serializeAttachment(attachment);

    this.safeSend(server, {
      type: MessageTypeHello,
      deviceId,
      deviceName: attachment.name,
      pairedSessions: attachment.paired,
      scopes: role === "mobile" ? attachment.scopes : undefined,
    });

    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") {
      return;
    }
    if (raw.length > maxMessageBytes) {
      try {
        socket.close(1009, "message too large");
      } catch {
        // The connection may already be gone.
      }
      return;
    }
    let message: Message;
    try {
      message = JSON.parse(raw) as Message;
    } catch {
      this.safeSend(socket, { type: MessageTypeError, error: ErrorBadRequest });
      return;
    }
    const attachment = socket.deserializeAttachment() as Attachment | null;
    if (!attachment) {
      return;
    }
    if (attachment.role === "desktop") {
      await this.onDesktopMessage(socket, attachment, message);
      return;
    }
    await this.onMobileMessage(socket, attachment, message);
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    const attachment = socket.deserializeAttachment() as Attachment | null;
    try {
      if (code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code)) {
        socket.close(code, reason);
      } else {
        socket.close();
      }
    } catch {
      // The close frame may already have been acknowledged.
    }
    if (!attachment) {
      return;
    }
    if (attachment.role === "desktop") {
      await this.failPendingForDevice(attachment.deviceId, ErrorDesktopOffline);
      return;
    }
    if (attachment.sessionID) {
      await this.dropPendingForMobileSession(attachment.sessionID);
    }
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    const attachment = socket.deserializeAttachment() as Attachment | null;
    if (!attachment) {
      return;
    }
    if (attachment.role === "desktop") {
      await this.failPendingForDevice(attachment.deviceId, ErrorDesktopOffline);
    } else if (attachment.sessionID) {
      await this.dropPendingForMobileSession(attachment.sessionID);
    }
  }

  private async onDesktopMessage(
    socket: WebSocket,
    attachment: Attachment,
    message: Message,
  ): Promise<void> {
    if (message.type === MessageTypePair) {
      if (!message.requestId) {
        this.safeSend(socket, { type: MessageTypeError, error: ErrorBadRequest });
        return;
      }
      const scopes = normalizeMobileScopes(message.scopes);
      const ttl = Math.max(1, Number(this.env.PAIR_TTL_MINUTES || 10));
      const expiresAt = addMinutesISO(ttl);
      let code = "";
      let saved = false;
      await this.env.DB.prepare("DELETE FROM pair_codes WHERE device_id = ?")
        .bind(attachment.deviceId)
        .run()
        .catch(() => undefined);
      for (let attempt = 0; attempt < 5 && !saved; attempt += 1) {
        code = randomPairCode();
        try {
          await this.env.DB.prepare(
            "INSERT INTO pair_codes (code, device_id, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
          )
            .bind(code, attachment.deviceId, JSON.stringify(scopes), nowISO(), expiresAt)
            .run();
          saved = true;
        } catch {
          saved = false;
        }
      }
      if (!saved) {
        this.safeSend(socket, {
          type: MessageTypeError,
          requestId: message.requestId,
          error: "could not create pairing code",
        });
        return;
      }
      await this.env.DB.prepare("DELETE FROM pair_codes WHERE expires_at < ?")
        .bind(nowISO())
        .run()
        .catch(() => undefined);
      this.safeSend(socket, {
        type: MessageTypePaired,
        requestId: message.requestId,
        expiresAt,
        scopes,
        code,
      });
      return;
    }

    if (message.type === MessageTypeRPCResult) {
      await this.routeRPCResult(attachment, message);
      return;
    }

    this.safeSend(socket, { type: MessageTypeError, error: "unsupported desktop message" });
  }

  private async onMobileMessage(
    socket: WebSocket,
    attachment: Attachment,
    message: Message,
  ): Promise<void> {
    if (message.type !== MessageTypeRPC) {
      this.safeSend(
        socket,
        rpcResultMessage(message.requestId || "", false, undefined, "unsupported mobile message"),
      );
      return;
    }
    const requestID = message.requestId || "";
    const method = message.method || "";
    if (!requestID || !mobileMethodAllowed(method, attachment.scopes || [])) {
      this.safeSend(socket, rpcResultMessage(requestID, false, undefined, ErrorMethodBlocked));
      return;
    }
    if (JSON.stringify(message.params ?? null).length > maxParamsBytesForMethod(method)) {
      this.safeSend(socket, rpcResultMessage(requestID, false, undefined, "request too large"));
      return;
    }
    const desktop = this.getDesktop();
    if (!desktop) {
      this.safeSend(socket, rpcResultMessage(requestID, false, undefined, ErrorDesktopOffline));
      return;
    }
    if ((await this.pendingCount()) >= maxPendingPerDevice) {
      this.safeSend(socket, rpcResultMessage(requestID, false, undefined, "too many pending requests"));
      return;
    }

    const relayID = randomID(18);
    const pending: PendingRecord = {
      kind: "ws",
      requestId: relayID,
      deviceId: attachment.deviceId,
      mobileSessionID: attachment.sessionID || "",
      mobileRequestID: requestID,
      method,
      expiresAt: Date.now() + WS_RPC_TIMEOUT_MS,
    };
    await this.saveWSPending(pending);
    if (!this.safeSend(desktop, {
      type: MessageTypeRPC,
      requestId: relayID,
      method,
      params: message.params,
    })) {
      await this.removeWSPending(relayID);
      this.safeSend(socket, rpcResultMessage(requestID, false, undefined, ErrorDesktopOffline));
    }
  }

  private async routeRPCResult(desktop: Attachment, message: Message): Promise<void> {
    const requestID = message.requestId || "";
    const httpPending = this.httpPending.get(requestID);
    if (httpPending) {
      if (httpPending.deviceId !== desktop.deviceId) {
        return;
      }
      clearTimeout(httpPending.timer);
      this.httpPending.delete(requestID);
      httpPending.resolve(message);
      return;
    }

    const key = pendingKey(requestID);
    const record = await this.state.storage.get<PendingRecord>(key);
    if (!record || record.deviceId !== desktop.deviceId) {
      return;
    }
    await this.state.storage.delete(key);
    this.clearPendingTimer(requestID);
    this.sendToMobileSession(record.mobileSessionID, {
      type: MessageTypeRPCResult,
      requestId: record.mobileRequestID,
      ok: message.ok === true,
      result: message.result,
      error: message.error,
    });
  }

  private async handleHTTPRPC(request: Request): Promise<Response> {
    const raw = await request.text();
    if (raw.length > maxFileChunkBytes + 64 * 1024) {
      return errorResponse("request too large", 413);
    }
    let body: { method?: string; params?: unknown };
    try {
      body = JSON.parse(raw) as { method?: string; params?: unknown };
    } catch {
      return errorResponse(ErrorBadRequest, 400);
    }
    const method = String(body.method || "").trim();
    const headerMethod = request.headers.get("x-codexlink-method");
    if (headerMethod && headerMethod !== method) {
      return errorResponse(ErrorBadRequest, 400);
    }
    const scopes = normalizeMobileScopes(parseStringArray(request.headers.get("x-codexlink-scopes")));
    const deviceId = request.headers.get("x-codexlink-device") || "";
    if (!method || !mobileMethodAllowed(method, scopes)) {
      return errorResponse(ErrorScopeDenied, 403);
    }
    if (JSON.stringify(body.params ?? null).length > maxParamsBytesForMethod(method)) {
      return errorResponse("request too large", 413);
    }
    const desktop = this.getDesktop();
    if (!desktop) {
      return errorResponse(ErrorDesktopOffline, 503);
    }
    if (this.httpPending.size >= maxPendingPerDevice) {
      return errorResponse("too many pending requests", 429);
    }

    const relayID = randomID(18);
    const result = await new Promise<Message>((resolve) => {
      const timer = setTimeout(() => {
        this.httpPending.delete(relayID);
        resolve(rpcResultMessage(relayID, false, undefined, "desktop request timed out"));
      }, HTTP_RPC_TIMEOUT_MS);
      this.httpPending.set(relayID, {
        kind: "http",
        deviceId,
        method,
        expiresAt: Date.now() + HTTP_RPC_TIMEOUT_MS,
        timer,
        resolve,
      });
      if (!this.safeSend(desktop, {
        type: MessageTypeRPC,
        requestId: relayID,
        method,
        params: body.params,
      })) {
        clearTimeout(timer);
        this.httpPending.delete(relayID);
        resolve(rpcResultMessage(relayID, false, undefined, ErrorDesktopOffline));
      }
    });

    if (result.ok !== true) {
      if (result.error === ErrorDesktopOffline) {
        return errorResponse(ErrorDesktopOffline, 503);
      }
      if (result.error === "desktop request timed out") {
        return errorResponse("desktop request timed out", 504);
      }
    }
    return jsonResponse(result);
  }

  private async handlePairClaim(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as
      | { code?: string; name?: string; deviceId?: string }
      | null;
    const code = normalizePairCode(body?.code || "");
    if (!code) {
      return errorResponse("invalid request", 400);
    }
    const row = await this.env.DB.prepare(
      "SELECT code, device_id, scopes, expires_at FROM pair_codes WHERE code = ?",
    )
      .bind(code)
      .first<{ code: string; device_id: string; scopes: string; expires_at: string }>();
    if (!row) {
      return errorResponse("pairing code expired or invalid", 410);
    }
    if (body?.deviceId && body.deviceId !== row.device_id) {
      return errorResponse("pairing code expired or invalid", 410);
    }
    if (Date.parse(row.expires_at) <= Date.now()) {
      await this.env.DB.prepare("DELETE FROM pair_codes WHERE code = ?").bind(code).run().catch(() => undefined);
      return errorResponse("pairing code expired or invalid", 410);
    }
    if (!this.getDesktop()) {
      return errorResponse(ErrorDesktopOffline, 409);
    }

    await this.env.DB.prepare("DELETE FROM pair_codes WHERE code = ?").bind(code).run();
    const token = randomToken(32);
    const sessionID = randomID(12);
    const days = Math.max(1, Number(this.env.SESSION_TTL_DAYS || 90));
    const expiresAt = addDaysISO(days);
    const scopes = normalizeMobileScopes(parseStringArray(row.scopes));
    const name = String(body?.name || "").slice(0, 80);
    await this.env.DB.prepare(
      "INSERT INTO mobile_sessions (token_hash, session_id, device_id, device_name, created_at, expires_at, scopes) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(await hashToken(token), sessionID, row.device_id, name, nowISO(), expiresAt, JSON.stringify(scopes))
      .run();

    await this.notifySessionCount(row.device_id);
    const response: PairClaimResponse = {
      token,
      deviceId: row.device_id,
      deviceName: name,
      expiresAt,
      scopes,
    };
    return jsonResponse(response);
  }

  private async handleRevoke(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as
      | { sessionIds?: string[]; all?: boolean; deviceId?: string }
      | null;
    const ids = new Set(Array.isArray(body?.sessionIds) ? body!.sessionIds : []);
    let closed = 0;
    for (const socket of this.state.getWebSockets("mobile")) {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      if (!attachment) {
        continue;
      }
      if (body?.all || (attachment.sessionID && ids.has(attachment.sessionID))) {
        try {
          socket.close(4001, "revoked");
          closed += 1;
        } catch {
          // The connection may already be closed.
        }
      }
    }
    const deviceId = body?.deviceId || this.getDesktopAttachment()?.deviceId || "";
    if (deviceId) {
      await this.notifySessionCount(deviceId);
    }
    return jsonResponse({ closed });
  }

  private async handleKick(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { desktop?: boolean; mobile?: boolean } | null;
    const deviceId = this.getDesktopAttachment()?.deviceId || "";
    let closed = 0;
    if (body?.desktop !== false) {
      for (const socket of this.state.getWebSockets("desktop")) {
        try {
          socket.close(4001, "revoked");
          closed += 1;
        } catch {
          // The connection may already be closed.
        }
      }
      await this.failPendingForDevice(deviceId, ErrorDesktopOffline);
    }
    if (body?.mobile) {
      for (const socket of this.state.getWebSockets("mobile")) {
        try {
          socket.close(4001, "revoked");
          closed += 1;
        } catch {
          // The connection may already be closed.
        }
      }
      await this.dropAllWSPending();
    }
    return jsonResponse({ closed });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.state.storage.list<PendingRecord>({ prefix: "pending:" });
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const [key, record] of entries) {
      if (!record || record.expiresAt <= now) {
        if (key) {
          await this.state.storage.delete(key);
        }
        if (record?.requestId) {
          this.clearPendingTimer(record.requestId);
          this.sendToMobileSession(
            record.mobileSessionID,
            rpcResultMessage(
              record.mobileRequestID,
              false,
              undefined,
              "desktop request timed out",
            ),
          );
        }
        continue;
      }
      nextExpiry = Math.min(nextExpiry, record.expiresAt);
    }
    if (Number.isFinite(nextExpiry)) {
      await this.state.storage.setAlarm(nextExpiry);
    }
  }

  private presence(): { desktopOnline: boolean; mobiles: number; sessions: string[] } {
    const sessions: string[] = [];
    for (const socket of this.state.getWebSockets("mobile")) {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      if (attachment?.sessionID) {
        sessions.push(attachment.sessionID);
      }
    }
    return {
      desktopOnline: !!this.getDesktop(),
      mobiles: this.state.getWebSockets("mobile").length,
      sessions,
    };
  }

  private async saveWSPending(record: PendingRecord): Promise<void> {
    await this.state.storage.put(pendingKey(record.requestId), record);
    const alarm = await this.state.storage.getAlarm();
    if (alarm === null || alarm > record.expiresAt) {
      await this.state.storage.setAlarm(record.expiresAt);
    }
    this.clearPendingTimer(record.requestId);
    const delay = Math.max(0, record.expiresAt - Date.now());
    this.pendingTimers.set(
      record.requestId,
      setTimeout(() => {
        void this.expireWSPending(record.requestId, record.expiresAt);
      }, delay),
    );
  }

  private async removeWSPending(requestID: string): Promise<void> {
    await this.state.storage.delete(pendingKey(requestID));
    this.clearPendingTimer(requestID);
  }

  private async expireWSPending(requestID: string, expectedExpiry: number): Promise<void> {
    const key = pendingKey(requestID);
    const record = await this.state.storage.get<PendingRecord>(key);
    if (!record || record.expiresAt !== expectedExpiry) {
      this.clearPendingTimer(requestID);
      return;
    }
    await this.state.storage.delete(key);
    this.clearPendingTimer(requestID);
    this.sendToMobileSession(
      record.mobileSessionID,
      rpcResultMessage(
        record.mobileRequestID,
        false,
        undefined,
        "desktop request timed out",
      ),
    );
  }

  private async failPendingForDevice(deviceId: string, error: string): Promise<void> {
    if (!deviceId) {
      return;
    }
    for (const [requestID, pending] of this.httpPending) {
      if (pending.deviceId !== deviceId) {
        continue;
      }
      clearTimeout(pending.timer);
      this.httpPending.delete(requestID);
      pending.resolve(rpcResultMessage(requestID, false, undefined, error));
    }

    const entries = await this.state.storage.list<PendingRecord>({ prefix: "pending:" });
    for (const [key, record] of entries) {
      if (!record || record.deviceId !== deviceId) {
        continue;
      }
      await this.state.storage.delete(key);
      this.clearPendingTimer(record.requestId);
      this.sendToMobileSession(
        record.mobileSessionID,
        rpcResultMessage(record.mobileRequestID, false, undefined, error),
      );
    }
  }

  private async dropPendingForMobileSession(sessionID: string): Promise<void> {
    if (!sessionID) {
      return;
    }
    const entries = await this.state.storage.list<PendingRecord>({ prefix: "pending:" });
    for (const [key, record] of entries) {
      if (!record || record.mobileSessionID !== sessionID) {
        continue;
      }
      await this.state.storage.delete(key);
      this.clearPendingTimer(record.requestId);
    }
  }

  private async dropAllWSPending(): Promise<void> {
    const entries = await this.state.storage.list<PendingRecord>({ prefix: "pending:" });
    for (const [key, record] of entries) {
      await this.state.storage.delete(key);
      if (record?.requestId) {
        this.clearPendingTimer(record.requestId);
      }
    }
  }

  private async pendingCount(): Promise<number> {
    const entries = await this.state.storage.list<PendingRecord>({ prefix: "pending:" });
    return this.httpPending.size + entries.size;
  }

  private clearPendingTimer(requestID: string): void {
    const timer = this.pendingTimers.get(requestID);
    if (timer) {
      clearTimeout(timer);
      this.pendingTimers.delete(requestID);
    }
  }

  private sendToMobileSession(sessionID: string, message: Message): void {
    if (!sessionID) {
      return;
    }
    for (const socket of this.state.getWebSockets("mobile")) {
      if (socket.readyState !== 1) {
        continue;
      }
      const attachment = socket.deserializeAttachment() as Attachment | null;
      if (attachment?.sessionID === sessionID && this.safeSend(socket, message)) {
        return;
      }
    }
  }

  private async notifySessionCount(deviceId: string): Promise<void> {
    const desktop = this.getDesktop();
    if (!desktop) {
      return;
    }
    const row = await this.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM mobile_sessions WHERE device_id = ? AND revoked_at IS NULL AND expires_at > ?",
    )
      .bind(deviceId, nowISO())
      .first<{ n: number }>();
    this.safeSend(desktop, {
      type: MessageTypeSessions,
      pairedSessions: Number(row?.n || 0),
    });
  }

  private getDesktop(): WebSocket | null {
    for (const socket of this.state.getWebSockets("desktop")) {
      if (socket.readyState === 1) {
        return socket;
      }
    }
    return null;
  }

  private getDesktopAttachment(): Attachment | null {
    const desktop = this.getDesktop();
    return desktop ? desktop.deserializeAttachment() as Attachment | null : null;
  }

  private safeSend(socket: WebSocket, message: Message): boolean {
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }
}

function pendingKey(requestID: string): string {
  return `pending:${requestID}`;
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}
