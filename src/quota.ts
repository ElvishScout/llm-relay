// 全局额度:5 小时 / ISO 周 / 自然月三个固定窗口。
// 按成本计费(由各模型 pricing 折算),与是否收费无关——免费期也照算。
// 计数与日志存 RelayState Durable Object 的 SQLite,这里只算窗口键和转发请求。
import { doFetch } from './state';
import type { QuotaLimits } from './config';
import type { Env } from './types';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const MICROS = 1_000_000;

export interface WindowKeys {
  h5: string;
  week: string;
  month: string;
}

export type QuotaCheck =
  | { ok: true }
  | { ok: false; window: string; used: number; limit: number };

export interface UsageRecord {
  model: string;
  provider: string;
  upstreamModel: string;
  promptTokens: number;
  completionTokens: number;
  cost: number; // 货币单位(如 USD)
}

export const LIMIT_FIELDS: Record<keyof WindowKeys, keyof QuotaLimits> = {
  h5: 'costPer5Hours',
  week: 'costPerWeek',
  month: 'costPerMonth',
};

export function toMicros(cost: number): number {
  return Math.round(cost * MICROS);
}

export function windowKeys(now: Date = new Date()): WindowKeys {
  return {
    h5: `h5:${Math.floor(now.getTime() / FIVE_HOURS_MS)}`,
    week: `w:${isoWeek(now)}`,
    month: `m:${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
  };
}

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7; // 周一 = 0
  t.setUTCDate(t.getUTCDate() - day + 3); // 本周周四
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const fd = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fd + 3);
  const week = 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// 请求前检查。任一窗口超限返回 { ok: false, ... },used/limit 为货币单位。
export function checkQuota(env: Env, quota: QuotaLimits | null): Promise<QuotaCheck> {
  if (!quota) return Promise.resolve({ ok: true });
  return doFetch<QuotaCheck>(env, '/quota/check', {
    method: 'POST',
    body: JSON.stringify({ keys: windowKeys(), limits: quota }),
  });
}

// 响应后记账:三个窗口成本计数器自增 + 写一条用量日志(DO 内单事务)。
export async function recordUsage(env: Env, rec: UsageRecord): Promise<void> {
  await doFetch<null>(env, '/usage/record', {
    method: 'POST',
    body: JSON.stringify({ keys: windowKeys(), micros: toMicros(rec.cost), rec }),
  });
}
