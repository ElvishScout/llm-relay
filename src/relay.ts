// 上游转发:按映射改写模型名,流式响应边转发边抓 usage 记账。
// 支持两种 OpenAI API:chat completions 和 responses。
import { recordUsage, type UsageRecord } from './quota';
import type { AppConfig, ModelMapping } from './config';
import type { NormalizedUsage, RelayRequestBody, UpstreamUsage, Env } from './types';

export type ApiKind = 'chat' | 'responses';

const API_PATHS: Record<ApiKind, string> = {
  chat: '/chat/completions',
  responses: '/responses',
};

interface RelayArgs {
  api: ApiKind;
  body: RelayRequestBody;
  mapping: ModelMapping;
  cfg: AppConfig;
  env: Env;
  ctx: ExecutionContext;
  onDone?: () => void; // 请求终结(完成/出错/流结束)时回调,用于还并发槽
}

export function listModels(cfg: AppConfig): Response {
  const created = 1700000000;
  return Response.json({
    object: 'list',
    data: [...cfg.modelMap.values()].map((m) => ({
      id: m.name,
      object: 'model',
      created,
      owned_by: m.provider,
    })),
  });
}

export async function relay({ api, body, mapping, cfg, env, ctx, onDone }: RelayArgs): Promise<Response> {
  const provider = cfg.providers.get(mapping.provider)!;
  const isStream = body.stream === true;

  const upstream: RelayRequestBody = { ...body, model: mapping.model };
  // chat completions 需要显式要求流末尾返回 usage;
  // responses API 的 response.completed 事件自带 usage,无需注入
  if (isStream && api === 'chat') {
    upstream.stream_options = { ...(upstream.stream_options ?? {}), include_usage: true };
  }

  let resp: Response;
  try {
    resp = await fetch(`${provider.baseUrl}${API_PATHS[api]}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
        ...provider.headers,
      },
      body: JSON.stringify(upstream),
    });
  } catch {
    onDone?.();
    return openaiError(502, 'upstream_unavailable', `上游 ${mapping.provider} 连接失败`);
  }

  if (!resp.ok) {
    // 上游错误原样透传(错误响应体较小,缓冲后返回并释放资源)
    const text = await resp.text();
    onDone?.();
    return new Response(text, { status: resp.status, headers: jsonHeaders(resp) });
  }

  const finish = (usage: NormalizedUsage | null): void => {
    if (!usage) return;
    ctx.waitUntil(recordUsage(env, buildUsageRecord(mapping, usage)));
  };

  if (!isStream) {
    const data = await resp.json<{ usage?: UpstreamUsage }>();
    finish(data.usage ? normalizeUsage(api, data.usage) : null);
    onDone?.();
    return Response.json(data);
  }

  // 流式:管道透传,旁路解析 SSE 抓 usage,流结束时收尾
  const capture = createUsageCapture();
  ctx.waitUntil(capture.promise.then((u) => {
    finish(u ? normalizeUsage(api, u) : null);
    onDone?.();
  }));
  return new Response(resp.body!.pipeThrough(capture.stream), {
    status: resp.status,
    headers: sseHeaders(),
  });
}

// chat: prompt_tokens/completion_tokens;responses: input_tokens/output_tokens
function normalizeUsage(api: ApiKind, raw: UpstreamUsage): NormalizedUsage {
  if (api === 'responses') {
    return {
      promptTokens: raw.input_tokens ?? 0,
      completionTokens: raw.output_tokens ?? 0,
    };
  }
  return {
    promptTokens: raw.prompt_tokens ?? 0,
    completionTokens: raw.completion_tokens ?? 0,
  };
}

// 成本始终按 pricing 折算(与是否收费无关),供额度统计和用量日志使用。
function buildUsageRecord(mapping: ModelMapping, usage: NormalizedUsage): UsageRecord {
  const cost = (usage.promptTokens * mapping.pricing.input +
                usage.completionTokens * mapping.pricing.output) / 1e6;
  return {
    model: mapping.name,
    provider: mapping.provider,
    upstreamModel: mapping.model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cost,
  };
}

interface UsageCapture {
  stream: TransformStream<Uint8Array, Uint8Array>;
  promise: Promise<UpstreamUsage | null>;
}

// 透传每个 chunk,同时按行扫描 SSE 找 usage。
// chat 的 usage 在最后一个 data 帧顶层;responses 的在 response.completed 帧的 response 字段内。
function createUsageCapture(): UsageCapture {
  let resolve!: (u: UpstreamUsage | null) => void;
  const promise = new Promise<UpstreamUsage | null>((r) => { resolve = r; });
  let buffer = '';
  let usage: UpstreamUsage | null = null;
  const decoder = new TextDecoder();

  const tryParse = (line: string): void => {
    if (!line.startsWith('data:') || !line.includes('"usage"')) return;
    try {
      const json = JSON.parse(line.slice(5).trim()) as {
        usage?: UpstreamUsage;
        response?: { usage?: UpstreamUsage };
      };
      usage = json.usage ?? json.response?.usage ?? usage;
    } catch { /* 半行或非 JSON,忽略 */ }
  };

  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        tryParse(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    },
    flush() {
      tryParse(buffer);
      resolve(usage);
    },
  });
  return { stream, promise };
}

function openaiError(status: number, code: string, message: string): Response {
  return Response.json({ error: { message, type: 'server_error', code } }, { status });
}

function jsonHeaders(resp: Response): Headers {
  const headers = new Headers();
  headers.set('content-type', resp.headers.get('content-type') ?? 'application/json');
  return headers;
}

function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  };
}
