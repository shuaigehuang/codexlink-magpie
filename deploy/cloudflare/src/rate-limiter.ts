import { jsonResponse } from "./protocol";
import type { Env } from "./env";

interface WindowRecord {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/check") {
      return jsonResponse({ error: "not_found" }, 404);
    }
    const key = (url.searchParams.get("key") || "").slice(0, 128);
    const limit = Math.max(1, Number(url.searchParams.get("limit") || 10));
    const windowSeconds = Math.max(1, Number(url.searchParams.get("window") || 600));
    if (!key) {
      return jsonResponse({ allowed: true });
    }

    const now = Date.now();
    const storageKey = `rl:${key}`;
    let record = (await this.state.storage.get<WindowRecord>(storageKey)) ?? null;
    if (!record || record.resetAt <= now) {
      record = { count: 0, resetAt: now + windowSeconds * 1000 };
    }
    record.count += 1;
    await this.state.storage.put(storageKey, record);
    await this.state.storage.setAlarm(record.resetAt + 60_000);

    const allowed = record.count <= limit;
    return jsonResponse(
      {
        allowed,
        remaining: Math.max(0, limit - record.count),
        resetAt: new Date(record.resetAt).toISOString(),
      },
      allowed ? 200 : 429,
    );
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.state.storage.list<WindowRecord>({ prefix: "rl:" });
    const expired: string[] = [];
    for (const [key, value] of entries) {
      if (!value || value.resetAt + 60_000 <= now) {
        expired.push(key);
      }
    }
    if (expired.length) {
      await this.state.storage.delete(expired);
    }
    await this.state.storage.setAlarm(now + 3_600_000);
  }
}
