import { loadConfig, type AppConfig } from './config';
import { checkQuota } from './quota';
import { acquireSlot, releaseSlot } from './state';
import { relay, listModels, type ApiKind } from './relay';
import type { RelayRequestBody, Env } from './types';

export { RelayState } from './do';

const POST_ROUTES: Record<string, ApiKind> = {
  '/v1/chat/completions': 'chat',
  '/v1/responses': 'responses',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let cfg: AppConfig;
    try {
      cfg = loadConfig();
    } catch (e) {
      return openaiError(500, 'config_error', (e as Error).message);
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === '/health') {
        return Response.json({ status: 'ok' });
      }
      if (!authorize(request, cfg)) {
        return openaiError(401, 'invalid_api_key', 'Missing or invalid API key');
      }
      if (url.pathname === '/v1/models' && request.method === 'GET') {
        return listModels(cfg);
      }
      const api = POST_ROUTES[url.pathname];
      if (api && request.method === 'POST') {
        return await handleRelay(api, request, env, ctx, cfg);
      }
      return openaiError(404, 'not_found', `Unknown path: ${url.pathname}`);
    } catch (e) {
      return openaiError(500, 'internal_error', (e as Error).message);
    }
  },
} satisfies ExportedHandler<Env>;

function authorize(request: Request, cfg: AppConfig): boolean {
  if (cfg.accessKeys.length === 0) return true; // 未配置则开放访问
  const auth = request.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return cfg.accessKeys.includes(token);
}

async function handleRelay(
  api: ApiKind, request: Request, env: Env, ctx: ExecutionContext, cfg: AppConfig
): Promise<Response> {
  let body: RelayRequestBody;
  try {
    body = await request.json<RelayRequestBody>();
  } catch {
    return openaiError(400, 'invalid_request_error', 'Request body is not valid JSON');
  }

  const mapping = cfg.modelMap.get(body.model);
  if (!mapping) {
    return openaiError(404, 'model_not_found',
      `Model '${body.model}' not found. See GET /v1/models for available models.`);
  }

  const quota = await checkQuota(env, cfg.quota);
  if (!quota.ok) {
    return Response.json({
      error: {
        message: `Global quota exceeded for window "${quota.window}": $${quota.used.toFixed(6)}/$${quota.limit} spent`,
        type: 'insufficient_quota',
        code: 'quota_exceeded',
        window: quota.window,
        used: quota.used,
        limit: quota.limit,
      },
    }, { status: 429 });
  }

  // 全局并发:抢槽后转发,请求结束(或出错)还槽,泄漏由槽位 TTL 兜底
  let token: string | null = null;
  if (cfg.concurrency) {
    token = await acquireSlot(env, cfg.concurrency);
    if (token === null) {
      return Response.json({
        error: {
          message: `Global concurrency limit reached (max ${cfg.concurrency.max}), please retry later`,
          type: 'rate_limit_error',
          code: 'concurrency_limit',
        },
      }, { status: 429 });
    }
  }

  return relay({
    api, body, mapping, cfg, env, ctx,
    onDone: token ? () => releaseSlot(env, ctx, token) : undefined,
  });
}

function openaiError(status: number, code: string, message: string): Response {
  return Response.json({ error: { message, type: 'invalid_request_error', code } }, { status });
}
