# Grok2API — Cloudflare Worker 版

将 Grok 网页端 API 反向代理为 **OpenAI 兼容接口**，部署在 Cloudflare Worker 上。

> 本项目是 [Grok2API](https://github.com/chenyme/grok2api) Python 版的 TypeScript 移植，专为 Cloudflare Worker 无服务器环境设计。

---

## 功能

- **OpenAI 兼容** — 直接对接支持 OpenAI SDK 的客户端（ChatGPT-Next-Web、LobeChat、Cursor 等）
- **Chat Completions** — 流式 (SSE) 与非流式响应
- **Tool / Function Calling** — 基于 prompt 注入的工具调用，支持流式工具调用
- **多模型支持** — grok-3 / grok-4 / grok-4.1 全系列（含 thinking / heavy / fast / expert 模式）
- **Token 池管理** — ssoBasic / ssoSuper 双池，自动选择最大配额 Token，跨 Token 重试
- **认证** — API Key（支持多 key 逗号分隔）、Admin App Key
- **Admin API** — 远程管理配置和 Token
- **KV 持久化** — 配置和 Token 数据存储在 Cloudflare KV 中
- **重试策略** — 指数退避 + decorrelated jitter，429 自动标记冷却并换 Token

## 支持的模型

| 模型 ID | 说明 | 档位 |
|---------|------|------|
| `grok-3` | Grok 3 | Basic |
| `grok-3-mini` | Grok 3 Mini (Thinking) | Basic |
| `grok-3-thinking` | Grok 3 Thinking | Basic |
| `grok-4` | Grok 4 | Basic |
| `grok-4-thinking` | Grok 4 Thinking | Basic |
| `grok-4-heavy` | Grok 4 Heavy | Super |
| `grok-4.1-mini` | Grok 4.1 Mini Thinking | Basic |
| `grok-4.1-fast` | Grok 4.1 Fast | Basic |
| `grok-4.1-expert` | Grok 4.1 Expert | Basic |
| `grok-4.1-thinking` | Grok 4.1 Thinking | Basic |
| `grok-4.20-beta` | Grok 4.20 Beta | Basic |

---

## 快速开始

### 前置要求

- [Node.js](https://nodejs.org/) >= 18
- [Cloudflare 账号](https://dash.cloudflare.com/)
- Grok SSO Token（从 grok.com 登录后获取 Cookie 中的 `sso` 值）

### 1. 安装依赖

```bash
npm install
```

### 2. 创建 KV 命名空间

```bash
npx wrangler kv namespace create CONFIG_KV
npx wrangler kv namespace create TOKENS_KV
```

将输出的 `id` 填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "CONFIG_KV"
id = "<你的 CONFIG_KV id>"

[[kv_namespaces]]
binding = "TOKENS_KV"
id = "<你的 TOKENS_KV id>"
```

### 3. 配置密钥

```bash
# API 调用密钥（可选，不设则无需认证）
npx wrangler secret put API_KEY

# 后台管理密码（默认 grok2api）
npx wrangler secret put APP_KEY
```

### 4. 添加 Token

通过 Admin API 添加 Grok SSO Token：

```bash
curl -X POST https://your-worker.workers.dev/v1/admin/tokens \
  -H "Authorization: Bearer grok2api" \
  -H "Content-Type: application/json" \
  -d '{
    "ssoBasic": [
      { "token": "你的SSO_TOKEN", "status": "active", "quota": 80 }
    ]
  }'
```

### 5. 部署

```bash
npm run deploy
```

### 6. 本地开发

```bash
npm run dev
```

---

## API 接口

### 公共接口

需要 `Authorization: Bearer <API_KEY>`（如果配置了 API_KEY）。

#### Chat Completions

```
POST /v1/chat/completions
```

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

**请求参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | 是 | 模型 ID |
| `messages` | array | 是 | 消息数组 |
| `stream` | boolean | 否 | 是否流式输出（默认 true） |
| `temperature` | number | 否 | 采样温度 0-2（默认 0.8） |
| `top_p` | number | 否 | nucleus 采样 0-1（默认 0.95） |
| `reasoning_effort` | string | 否 | 推理强度：none / minimal / low / medium / high / xhigh |
| `tools` | array | 否 | 工具定义（OpenAI 格式） |
| `tool_choice` | string/object | 否 | 工具选择：auto / required / none |
| `parallel_tool_calls` | boolean | 否 | 是否允许并行工具调用（默认 true） |

#### Models

```
GET /v1/models
```

返回所有可用模型列表。

#### 健康检查

```
GET /health
```

### Admin 接口

需要 `Authorization: Bearer <APP_KEY>`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/admin/verify` | 验证 App Key |
| GET | `/v1/admin/config` | 获取当前配置 |
| POST | `/v1/admin/config` | 更新配置 |
| GET | `/v1/admin/tokens` | 获取所有 Token 及统计 |
| POST | `/v1/admin/tokens` | 批量更新 Token |
| POST | `/v1/admin/tokens/refresh` | 重置所有 Token 配额 |

---

## 配置说明

配置通过 KV 存储持久化，也可通过环境变量覆盖部分值。

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `API_KEY` | API 调用密钥（逗号分隔支持多个） | 空（不认证） |
| `APP_KEY` | 后台管理密码 | `grok2api` |
| `BASE_PROXY_URL` | 代理到 Grok 的代理地址 | 空（直连） |
| `CF_CLEARANCE` | Cloudflare Clearance Cookie | 空 |
| `USER_AGENT` | User-Agent 字符串 | Chrome 136 |
| `BROWSER` | 浏览器指纹标识 | `chrome136` |

### 运行时配置（通过 Admin API 修改）

<details>
<summary>点击展开完整配置项</summary>

```jsonc
{
  "app": {
    "api_key": "",              // API 密钥
    "app_key": "grok2api",      // 管理密码
    "temporary": true,          // 临时对话模式
    "disable_memory": true,     // 禁用 Grok 记忆
    "stream": true,             // 默认流式输出
    "thinking": true,           // 默认输出思维链
    "dynamic_statsig": true,    // 动态 Statsig 指纹
    "custom_instruction": "",   // 自定义指令
    "filter_tags": [            // 过滤的标签
      "xaiartifact",
      "xai:tool_usage_card",
      "grok:render"
    ]
  },
  "proxy": {
    "base_proxy_url": "",       // 代理地址
    "cf_clearance": "",         // CF Clearance
    "browser": "chrome136",     // 浏览器指纹
    "user_agent": "Mozilla/5.0 ..."
  },
  "retry": {
    "max_retry": 3,             // 最大重试次数
    "retry_status_codes": [401, 429, 403],
    "retry_backoff_base": 0.5,  // 退避基础延迟（秒）
    "retry_backoff_factor": 2.0,
    "retry_backoff_max": 20.0,
    "retry_budget": 60.0        // 总重试预算（秒）
  },
  "token": {
    "fail_threshold": 5         // 连续失败阈值（自动标记过期）
  },
  "chat": {
    "timeout": 60,              // 请求超时（秒）
    "stream_timeout": 60        // 流式空闲超时（秒）
  }
}
```

</details>

---

## Token 管理

### 池说明

| 池名 | 说明 | 默认配额 |
|------|------|----------|
| `ssoBasic` | 普通账号 Token 池 | 80 |
| `ssoSuper` | 高级账号 Token 池 | 140 |

- Basic 模型优先使用 `ssoBasic` 池，不足时回退到 `ssoSuper`
- Super 模型（如 grok-4-heavy）仅使用 `ssoSuper` 池
- 低消耗请求扣 1 配额，高消耗请求扣 4 配额
- 配额耗尽自动标记为 `cooling` 状态
- 连续 401 失败达阈值自动标记为 `expired`

### Token 状态

| 状态 | 说明 |
|------|------|
| `active` | 正常可用 |
| `cooling` | 配额耗尽，等待刷新 |
| `expired` | 认证失败过多，需检查 |
| `disabled` | 手动禁用 |

---

## 客户端对接

### OpenAI SDK (Python)

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-api-key",
    base_url="https://your-worker.workers.dev/v1"
)

response = client.chat.completions.create(
    model="grok-4",
    messages=[{"role": "user", "content": "你好！"}],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### OpenAI SDK (Node.js)

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "your-api-key",
  baseURL: "https://your-worker.workers.dev/v1",
});

const stream = await client.chat.completions.create({
  model: "grok-4",
  messages: [{ role: "user", content: "Hello!" }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

### curl

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.1-fast",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "写一首关于编程的诗"}
    ],
    "stream": true,
    "temperature": 0.7
  }'
```

### Tool Calling

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4",
    "messages": [{"role": "user", "content": "北京今天天气怎么样？"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "获取指定城市天气",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {"type": "string", "description": "城市名"}
          },
          "required": ["city"]
        }
      }
    }],
    "tool_choice": "auto"
  }'
```

---

## 项目结构

```
src/
├── index.ts                          # 入口 + 路由注册
├── types.ts                          # 全局类型定义
├── core/
│   ├── auth.ts                       # Bearer Token 认证
│   ├── config.ts                     # 配置管理（KV 持久化）
│   └── errors.ts                     # OpenAI 兼容错误格式
└── services/
    ├── model.ts                      # 模型定义与映射
    ├── token.ts                      # Token 池管理（KV 持久化）
    ├── grok/
    │   ├── chat.ts                   # Chat 服务（流式/非流式处理器）
    │   ├── message.ts                # OpenAI 消息格式提取与转换
    │   └── tool_call.ts              # Tool calling prompt 构建与解析
    └── reverse/
        ├── app_chat.ts               # Grok app-chat API 请求
        ├── headers.ts                # 请求头 + SSO Cookie 构建
        ├── retry.ts                  # 重试策略（指数退避）
        └── statsig.ts                # Statsig ID 生成器
```

---

## 与 Python 版的差异

| 特性 | Python 版 | CF Worker 版 | 说明 |
|------|-----------|-------------|------|
| Chat Completions | ✅ | ✅ | 完全兼容 |
| Tool Calling | ✅ | ✅ | 完全兼容 |
| 图片生成 | ✅ | ❌ | 需要 WebSocket (wss://grok.com/ws/imagine) |
| 视频生成 | ✅ | ❌ | 需要 WebSocket |
| 语音 | ✅ | ❌ | 需要 LiveKit SDK |
| 浏览器 TLS 指纹 | ✅ | ❌ | CF Worker fetch 不支持 impersonate |
| CF 自动刷新 | ✅ | ❌ | 需要 FlareSolverr 外部服务 |
| 存储后端 | Local/Redis/MySQL/PgSQL | KV | Cloudflare KV |
| Admin UI | ✅ | ❌ | 仅 API 接口 |
| 部署方式 | Docker / Granian | `wrangler deploy` | 无服务器 |

---

## License

MIT
