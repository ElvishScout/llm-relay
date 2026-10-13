# llm-relay

基于 Cloudflare Workers 的 LLM 中转站：对外提供 OpenAI 兼容协议，上游接入多个供应商，支持模型名映射、按模型 pricing 折算成本，全局 5 小时/周/月**成本额度**限制（当前免费，但额度按定价照算）。

## 结构

- `config.json` — 真实配置，**不进 git**（构建时打包进 Worker），模板见 `config.example.json`
- `src/config.ts` — 配置加载与校验
- `src/index.ts` — 路由、鉴权、额度预检、并发槽获取
- `src/relay.ts` — 上游转发、流式透传 + usage 捕获
- `src/quota.ts` — 窗口键计算，额度/记账的 DO 客户端
- `src/state.ts` — RelayState DO 客户端（并发信号量）
- `src/do.ts` — RelayState Durable Object：并发信号量 + 成本计数 + 用量日志（自带 SQLite）

## 本地开发

```bash
npm install
cp config.example.json config.json   # 填入真实 apiKey
npm run dev
```

## 部署

```bash
npm run deploy
```

首次部署会自动创建 RelayState DO（见 `wrangler.toml` 的 migrations)，无需手动建库。

### GitHub 自动部署

push 到 `main` 自动部署（见 `.github/workflows/deploy.yml`)。需要在仓库 Settings → Secrets → Actions 配置：

| Secret | 内容 |
| --- | --- |
| `RELAY_CONFIG` | 整份 `config.json` 内容 |
| `CLOUDFLARE_API_TOKEN` | 有 Workers 编辑权限的 API token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID |

`wrangler.toml` 里的 `database_id` 不敏感，直接提交。

## 配置说明

```jsonc
{
  "accessKeys": ["sk-relay-xxx"],   // 调用方的 Bearer key;空数组 = 开放访问
  "providers": {
    "deepseek": {                    // 供应商,OpenAI 兼容协议
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "sk-...",
      "headers": {}                  // 可选,附加请求头
    }
  },
  "models": [{
    "name": "fast-chat",             // 对外暴露的自定义名称
    "provider": "deepseek",
    "model": "deepseek-chat",        // 上游真实模型名
    "pricing": { "input": 0.27, "output": 1.1 }  // 每百万 token 单价,必填
  }],
  "quota": {
    "costPer5Hours": 2,              // 成本额度(货币单位),按 pricing 折算;
    "costPerWeek": 10,               // 任一窗口超限 → 429;字段省略 = 该窗口不限
    "costPerMonth": 40
  },
  "concurrency": {                   // 全局并发限制(DO 信号量),省略 = 不限
    "max": 20,                       // 最大并发请求数,超限 → 429
    "ttlMs": 300000                  // 槽位租约时长,泄漏自动回收
  }
}
```

注意：`pricing` 为必填（额度按它折算成本），缺失会在启动时报错。想给某模型免额度可显式配 `{ "input": 0, "output": 0 }`。

## API

OpenAI 兼容，`base_url` 指向 Worker 地址即可：

```python
from openai import OpenAI
client = OpenAI(base_url="https://<worker>.workers.dev/v1", api_key="sk-relay-xxx")
client.chat.completions.create(model="fast-chat",
    messages=[{"role": "user", "content": "hi"}], stream=True)
```

- `POST /v1/chat/completions` — 流式/非流式；自动注入 `stream_options.include_usage` 用于记账
- `POST /v1/responses` — Responses API，流式/非流式；usage 从 `response.completed` 事件提取（`input_tokens`/`output_tokens` 已归一化）
- `GET /v1/models` — 列出对外模型名
- `GET /health`

## 已知取舍

- 额度按**成本**统计（请求后由 `usage` × `pricing` 折算），请求前检查、响应后记账，瞬时并发可能略微超额；固定窗口（非滑动），窗口边界重置
- 并发信号量在 DO 内存中，DO 被驱逐后计数清零（可能短暂放超）；槽位 TTL 兜底泄漏，最终收敛
- 全局状态集中在单例 DO，强一致但单点串行；当前规模足够，成为瓶颈时可按窗口/分片拆分
- 上游不支持 `include_usage` 时流式请求不记账
- 上游目前仅支持 OpenAI 兼容协议；Anthropic 等需加协议转换层

## 从 D1 版本迁移

存储已从 D1 迁至 RelayState DO 的 SQLite（额度与用量历史不迁移）。如部署过旧版本，可在 Cloudflare Dashboard 删除 `llm-relay` D1 数据库。
