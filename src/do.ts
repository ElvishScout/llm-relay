// 全局状态 Durable Object(单例):
// - 并发信号量(内存槽位 + TTL,泄漏自动回收)
// - 成本额度计数(DO 自带 SQLite,微单位整数)
// - 用量日志(同库)
// 注意:并发槽位在内存中,DO 被驱逐后计数清零(可能短暂放超),TTL 保证最终收敛。
import { LIMIT_FIELDS, type UsageRecord, type WindowKeys } from './quota';
import type { QuotaLimits } from './config';

export class RelayState {
  /** 并发槽位:token -> 过期时间戳 */
  private slots = new Map<string, number>();

  constructor(private readonly ctx: DurableObjectState) {
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS quota (
          window TEXT PRIMARY KEY,
          cost_micros INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS usage (
          id INTEGER PRIMARY KEY,
          ts TEXT NOT NULL,
          model TEXT NOT NULL,           -- 自定义(对外)模型名
          provider TEXT NOT NULL,
          upstream_model TEXT NOT NULL,  -- 上游真实模型名
          prompt_tokens INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          cost REAL NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
      `);
    });
  }

  async fetch(request: Request): Promise<Response> {
    this.purgeExpired();
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/acquire':
        return this.acquire(request);
      case '/release':
        return this.release(request);
      case '/quota/check':
        return this.checkQuota(await request.json());
      case '/usage/record':
        return this.recordUsage(await request.json());
      default:
        return new Response('not found', { status: 404 });
    }
  }

  // ---- 并发信号量 ----

  private acquire(request: Request): Response {
    const max = Number(request.headers.get('x-max') ?? 0);
    const ttlMs = Number(request.headers.get('x-ttl') ?? 300_000);
    if (this.slots.size >= max) {
      return Response.json(
        { error: 'concurrency limit reached', active: this.slots.size, max },
        { status: 429 },
      );
    }
    const token = crypto.randomUUID();
    this.slots.set(token, Date.now() + ttlMs);
    return Response.json({ token });
  }

  private async release(request: Request): Promise<Response> {
    const { token } = await request.json<{ token?: string }>();
    if (token) this.slots.delete(token);
    return new Response(null, { status: 204 });
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [token, expiresAt] of this.slots) {
      if (expiresAt <= now) this.slots.delete(token);
    }
  }

  // ---- 额度与用量(SQLite) ----

  private checkQuota(body: { keys: WindowKeys; limits: QuotaLimits }): Response {
    const { keys, limits } = body;
    const rows = this.ctx.storage.sql.exec(
      'SELECT window, cost_micros FROM quota WHERE window IN (?, ?, ?)',
      keys.h5, keys.week, keys.month,
    ).toArray() as unknown as { window: string; cost_micros: number }[];
    const used = Object.fromEntries(rows.map((r) => [r.window, r.cost_micros]));

    for (const [kind, field] of Object.entries(LIMIT_FIELDS) as [keyof WindowKeys, keyof QuotaLimits][]) {
      const limit = limits[field];
      if (!limit) continue;
      const current = (used[keys[kind]] ?? 0) / 1_000_000;
      if (current >= limit) {
        return Response.json({ ok: false, window: kind, used: current, limit });
      }
    }
    return Response.json({ ok: true });
  }

  private recordUsage(body: { keys: WindowKeys; micros: number; rec: UsageRecord }): Response {
    const { keys, micros, rec } = body;
    this.ctx.storage.transactionSync(() => {
      if (micros > 0) {
        for (const w of [keys.h5, keys.week, keys.month]) {
          this.ctx.storage.sql.exec(
            'INSERT INTO quota (window, cost_micros) VALUES (?, ?) ' +
            'ON CONFLICT(window) DO UPDATE SET cost_micros = cost_micros + excluded.cost_micros',
            w, micros,
          );
        }
      }
      if (rec.promptTokens + rec.completionTokens > 0 || micros > 0) {
        this.ctx.storage.sql.exec(
          'INSERT INTO usage (ts, model, provider, upstream_model, prompt_tokens, completion_tokens, cost) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
          new Date().toISOString(), rec.model, rec.provider, rec.upstreamModel,
          rec.promptTokens, rec.completionTokens, rec.cost,
        );
      }
    });
    return new Response(null, { status: 204 });
  }
}
