export interface Env {
  STATE: DurableObjectNamespace;
}

// 上游 usage:chat completions 用 prompt/completion_tokens,
// responses API 用 input/output_tokens,统一按此结构接收后再归一化。
export interface UpstreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface NormalizedUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface RelayRequestBody {
  model: string;
  stream?: boolean;
  stream_options?: { include_usage?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}
