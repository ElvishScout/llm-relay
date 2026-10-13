// RelayState Durable Object 的客户端封装。
import type { ConcurrencyConfig } from './config';
import type { Env } from './types';

export function getStateStub(env: Env): DurableObjectStub {
  if (!env.STATE) {
    throw new Error('缺少 STATE Durable Object 绑定,请检查 wrangler.toml');
  }
  return env.STATE.get(env.STATE.idFromName('global'));
}

export async function doFetch<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  const resp = await getStateStub(env).fetch(`https://do${path}`, init);
  return resp.json<T>();
}

// ---- 并发信号量 ----

/** 抢一个并发槽,成功返回 token,超限返回 null。 */
export async function acquireSlot(env: Env, cc: ConcurrencyConfig): Promise<string | null> {
  const resp = await getStateStub(env).fetch('https://do/acquire', {
    headers: { 'x-max': String(cc.max), 'x-ttl': String(cc.ttlMs) },
  });
  if (resp.status === 429) return null;
  const { token } = await resp.json<{ token: string }>();
  return token;
}

/** 还槽(尽力而为,泄漏由 TTL 兜底)。 */
export function releaseSlot(env: Env, ctx: ExecutionContext, token: string): void {
  ctx.waitUntil(
    getStateStub(env).fetch('https://do/release', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  );
}
