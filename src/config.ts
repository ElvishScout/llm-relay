// 配置加载:config.json 在构建时由 Wrangler 打包进 Worker,不进 git。
// 本地开发时从 config.example.json 复制一份。
import rawConfig from '../config.json';

export interface Pricing {
  input: number;  // 每百万输入 token 单价
  output: number; // 每百万输出 token 单价
}

export interface Provider {
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
}

export interface ModelMapping {
  name: string;              // 对外暴露的自定义名称
  provider: string;
  model: string;             // 上游真实模型名
  pricing: Pricing;          // 必填:额度按 pricing 折算成本,缺了会绕过限制
}

export interface QuotaLimits {
  costPer5Hours?: number; // 货币单位(如 USD),按各模型 pricing 折算
  costPerWeek?: number;
  costPerMonth?: number;
}

export interface ConcurrencyConfig {
  max: number;    // 全局最大并发请求数
  ttlMs: number;  // 槽位租约时长,泄漏自动回收
}

export interface CorsConfig {
  origins: string[]; // 允许的 Origin;"*" 表示任意来源
}

export interface AppConfig {
  accessKeys: string[];
  providers: Map<string, Provider>;
  modelMap: Map<string, ModelMapping>;
  quota: QuotaLimits | null;
  concurrency: ConcurrencyConfig | null;
  cors: CorsConfig | null;
  pathPrefix: string; // 自定义域名路由的路径前缀(如 /openai),空串表示无前缀
}

interface RawProvider {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
}

interface RawModel {
  name: string;
  provider: string;
  model: string;
  pricing: Pricing; // 必填,加载时校验
}

interface RawConfig {
  accessKeys?: string[];
  providers?: Record<string, RawProvider>;
  models?: RawModel[];
  quota?: QuotaLimits;
  concurrency?: { max: number; ttlMs?: number };
  cors?: { origins: string[] };
  pathPrefix?: string;
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const raw = rawConfig as RawConfig;

  const providers = new Map<string, Provider>();
  for (const [name, p] of Object.entries(raw.providers ?? {})) {
    if (!p.baseUrl || !p.apiKey) {
      throw new Error(`provider "${name}" 缺少 baseUrl 或 apiKey`);
    }
    providers.set(name, {
      baseUrl: p.baseUrl.replace(/\/+$/, ''),
      apiKey: p.apiKey,
      headers: p.headers ?? {},
    });
  }

  const modelMap = new Map<string, ModelMapping>();
  for (const m of raw.models ?? []) {
    if (!m.name || !m.provider || !m.model) {
      throw new Error(`模型配置缺少 name/provider/model: ${JSON.stringify(m)}`);
    }
    if (!providers.has(m.provider)) {
      throw new Error(`模型 "${m.name}" 引用了不存在的 provider "${m.provider}"`);
    }
    const p = m.pricing;
    if (!p || typeof p.input !== 'number' || typeof p.output !== 'number' || p.input < 0 || p.output < 0) {
      throw new Error(`模型 "${m.name}" 缺少有效的 pricing(需要非负的 input/output 单价)`);
    }
    modelMap.set(m.name, {
      name: m.name,
      provider: m.provider,
      model: m.model,
      pricing: { input: p.input, output: p.output },
    });
  }

  const cc = raw.concurrency;
  if (cc && (!Number.isInteger(cc.max) || cc.max <= 0)) {
    throw new Error('concurrency.max 必须是正整数');
  }

  const prefix = raw.pathPrefix ?? '';
  if (prefix && (!prefix.startsWith('/') || prefix.endsWith('/') || prefix.length === 1)) {
    throw new Error('pathPrefix 必须形如 "/openai"(以 / 开头,不以 / 结尾)');
  }

  cached = {
    accessKeys: raw.accessKeys ?? [],
    providers,
    modelMap,
    quota: raw.quota ?? null,
    concurrency: cc ? { max: cc.max, ttlMs: cc.ttlMs ?? 300_000 } : null,
    cors: raw.cors && raw.cors.origins.length > 0 ? { origins: raw.cors.origins } : null,
    pathPrefix: prefix,
  };
  return cached;
}
