export interface Env {
  DB: D1Database;
  DEVICE_ROOM: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  ADMIN_TOKEN: string;
  COOKIE_SECRET: string;
  PUBLIC_URL: string;
  SESSION_TTL_DAYS: string;
  PAIR_TTL_MINUTES: string;
}
