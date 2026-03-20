# APIFriend 设计文档

## 1. 项目概述

APIFriend 是一个 API 中转路由服务，主要解决免费 API 的用量限制问题。

### 核心功能
- **多源管理**：配置多个免费 API 源，支持优先级排序
- **自动故障切换**：请求失败（429/5xx）时自动切换到下一个可用源
- **统一入口**：对外提供一个 URL，供 Claude Code 等工具使用
- **无缝体验**：用户无需关心底层切换逻辑

### 使用场景
```
Claude Code → http://localhost:3000/v1/chat/completions
                      ↓
              APIFriend (自动选择可用源)
                      ↓
    ┌─────────────────┼─────────────────┐
    ↓                 ↓                 ↓
 OpenRouter      Together.ai        Groq
 (优先级1)        (优先级2)         (优先级3)
```

---

## 2. 文件结构

```
D:\APIFriend\
├── config.json              # 用户配置（API源列表）
├── config.example.json      # 配置示例
├── index.js                 # 入口文件，启动服务
├── src/
│   ├── proxy.js             # 代理核心（请求转发、响应透传）
│   ├── sourceManager.js     # 源管理器（状态追踪、自动切换）
│   ├── rateLimiter.js       # 限流器（记录用量、防止超限）
│   └── formatters/          # API 格式转换器
│       ├── index.js         # 格式转换入口
│       ├── openai.js        # OpenAI 兼容格式
│       └── anthropic.js     # Anthropic 格式
├── logs/                    # 日志目录
│   └── apifriend.log
└── DESIGN.md                # 本文档
```

---

## 3. 配置文件设计

```json
{
  "server": {
    "port": 3000,
    "host": "127.0.0.1"
  },
  "security": {
    "proxyApiKey": "your-secret-key-here"
  },
  "sources": [
    {
      "name": "openrouter-free",
      "baseUrl": "https://openrouter.ai/api",
      "apiKey": "sk-or-xxx",
      "priority": 1,
      "enabled": true,
      "format": "openai",
      "rateLimit": {
        "requestsPerMinute": 20,
        "tokensPerMinute": 6000,
        "requestsPerDay": 200,
        "tokensPerDay": 100000
      },
      "modelMapping": {
        "default": "meta-llama/llama-3-8b-instruct:free",
        "gpt-3.5-turbo": "meta-llama/llama-3-8b-instruct:free",
        "llama3": "meta-llama/llama-3-8b-instruct:free"
      }
    },
    {
      "name": "groq-free",
      "baseUrl": "https://api.groq.com/openai/v1",
      "apiKey": "gsk_xxx",
      "priority": 2,
      "enabled": true,
      "format": "openai",
      "rateLimit": {
        "requestsPerMinute": 30,
        "tokensPerMinute": 6000,
        "requestsPerDay": 14400,
        "tokensPerDay": 500000
      },
      "modelMapping": {
        "default": "llama3-8b-8192",
        "gpt-3.5-turbo": "llama3-8b-8192",
        "gpt-4": "mixtral-8x7b-32768",
        "llama3": "llama3-8b-8192"
      }
    }
  ],
  "failover": {
    "timeoutMs": 15000,
    "maxRetries": 3,
    "retryDelayMs": 1000,
    "cooldownMinutes": 5,
    "failureThreshold": 3
  },
  "persistence": {
    "enabled": true,
    "file": ".state.json",
    "intervalMs": 60000
  },
  "logging": {
    "level": "info",
    "file": "logs/apifriend.log"
  }
}
```

### 配置项说明

| 字段 | 说明 |
|------|------|
| `security.proxyApiKey` | 代理访问密钥，保护本地服务不被滥用 |
| `sources[].priority` | 优先级，数字越小越优先 |
| `sources[].enabled` | 是否启用该源 |
| `sources[].format` | API 格式：`openai` / `anthropic` |
| `sources[].modelMapping` | 模型名称映射，key 为客户端请求的模型名，value 为实际模型名 |
| `sources[].modelMapping.default` | 默认模型，当请求的模型无映射时使用 |
| `sources[].rateLimit.tokensPerMinute` | 每分钟 Token 限制（TPM） |
| `sources[].rateLimit.tokensPerDay` | 每天 Token 限制（TPD） |
| `failover.timeoutMs` | 请求超时时间（毫秒），超时后触发切换 |
| `failover.maxRetries` | 单次请求最大重试次数 |
| `failover.cooldownMinutes` | 源冷却时间（分钟） |
| `failover.failureThreshold` | 连续失败多少次进入冷却 |
| `persistence.enabled` | 是否启用状态持久化 |
| `persistence.file` | 状态持久化文件路径 |
| `persistence.intervalMs` | 持久化间隔（毫秒） |

---

## 4. 核心流程

### 4.1 请求处理流程

```
┌─────────────────────────────────────────────────────────────┐
│                     请求到达                                  │
│                 POST /v1/chat/completions                   │
└─────────────────────────┬───────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                  SourceManager.selectSource()               │
│         选择优先级最高且可用的源（非冷却、未超限）             │
└─────────────────────────┬───────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                     Proxy.forward()                         │
│                    转发请求到目标源                           │
└─────────────────────────┬───────────────────────────────────┘
                          ↓
              ┌───────────┴───────────┐
              ↓                       ↓
        请求成功                  请求失败
        (2xx响应)              (429/5xx/超时)
              ↓                       ↓
    ┌─────────────────┐    ┌─────────────────────┐
    │ 返回响应给客户端 │    │ 标记源失败          │
    │ 更新成功计数     │    │ 切换下一个源        │
    └─────────────────┘    │ 重试请求            │
                           └──────────┬──────────┘
                                      ↓
                            ┌─────────────────┐
                            │ 所有源都不可用?  │
                            └────────┬────────┘
                                     ↓
                           ┌─────────┴─────────┐
                           ↓                   ↓
                        返回错误          等待冷却后重试
```

### 4.2 源状态流转

```
         ┌──────────────┐
         │   ENABLED    │  ← 初始状态
         │   (可用)     │
         └──────┬───────┘
                │ 连续失败 >= failureThreshold
                ↓
         ┌──────────────┐
         │   COOLING    │  ← 冷却中
         │   (暂停使用) │
         └──────┬───────┘
                │ 冷却时间结束
                ↓
         ┌──────────────┐
         │   ENABLED    │  ← 恢复可用
         └──────────────┘
```

---

## 5. 状态管理

### 5.1 源状态数据结构

```javascript
{
  name: "openrouter-free",
  status: "enabled",           // enabled | cooling | disabled
  stats: {
    totalRequests: 150,
    successCount: 142,
    failureCount: 8,
    lastSuccess: "2026-03-20T10:30:00Z",
    lastFailure: "2026-03-20T10:35:00Z",
    consecutiveFailures: 2
  },
  rateLimit: {
    minuteCount: 5,            // 当前分钟请求数
    dayCount: 150,             // 当天请求数
    minuteReset: timestamp,    // 分钟计数器重置时间
    dayReset: timestamp        // 天计数器重置时间
  },
  cooldownUntil: null          // 冷却结束时间，null表示未冷却
}
```

### 5.2 冷却机制

- 触发条件：连续失败次数 >= `failureThreshold`
- 冷却时长：`cooldownMinutes` 分钟
- 自动恢复：冷却结束后自动变为可用状态

### 5.3 限流机制

- 每个源独立计数 `requestsPerMinute` 和 `requestsPerDay`
- 达到限制时，该源标记为"已达限"，等待计数器重置
- 不影响其他源的使用

---

## 6. API 格式转换

### 6.1 OpenAI 兼容格式（默认）

请求端点：
- `POST /v1/chat/completions`
- `POST /v1/completions`
- `GET /v1/models`

请求头转换：
```
Authorization: Bearer <source.apiKey>
```

### 6.2 Anthropic 格式

请求端点：
- `POST /v1/messages`

请求头转换：
```
x-api-key: <source.apiKey>
anthropic-version: 2023-06-01
```

请求体转换：将 OpenAI 格式转换为 Anthropic 格式

---

## 7. 管理 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/admin/sources` | GET | 获取所有源状态 |
| `/admin/sources/:name` | GET | 获取单个源详情 |
| `/admin/sources/:name` | PATCH | 更新源配置 |
| `/admin/sources/:name/enable` | POST | 启用源 |
| `/admin/sources/:name/disable` | POST | 禁用源 |
| `/admin/sources/:name/reset` | POST | 重置源状态 |
| `/admin/stats` | GET | 获取全局统计 |

---

## 8. 关键技术细节

### 8.1 流式输出（Streaming）的故障切换处理

**问题**：LLM 请求绝大部分是流式输出（`stream: true`）

- **请求阶段失败**：如果请求刚发出去就遇到 429 或 5xx，可以轻松拦截并切换下一个源
- **传输阶段失败**：如果 HTTP 状态码返回 200，SSE 流已经开始向客户端吐字，但中途断开，此时**无法进行故障切换**（HTTP 头部已发送给客户端）

**解决方案**：

```javascript
// proxy.js 核心逻辑
async function handleRequest(req, res, source) {
  const upstreamRes = await fetch(sourceUrl, options);
  
  // 只有在未向客户端发送任何响应头之前，才触发重试机制
  if (!upstreamRes.ok && !res.headersSent) {
    // 可以安全切换源重试
    return retryWithNextSource(req, res);
  }
  
  // 如果已经开始流式传输，只能透传，无法回退
  if (upstreamRes.headers.get('content-type')?.includes('text/event-stream')) {
    // 流式响应：直接透传，记录中断情况
    upstreamRes.body.pipe(res);
    upstreamRes.body.on('error', (err) => {
      logStreamInterrupt(source, err);
      // 向客户端注入错误信息，使其优雅结束当前生成
      res.write(`data: {"error": {"message": "APIFriend: Upstream stream interrupted: ${err.message}"}}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  }
}
```

**建议**：客户端应实现自己的重试逻辑，处理流式中断的情况。

### 8.2 模型名称映射（Model Mapping）

**问题**：同一个模型在不同厂商的命名不同

| 通用名称 | OpenRouter | Groq |
|---------|------------|------|
| Llama 3 8B | `meta-llama/llama-3-8b-instruct:free` | `llama3-8b-8192` |
| Mixtral | `mistralai/mixtral-8x7b-instruct` | `mixtral-8x7b-32768` |

**配置扩展**：

```json
{
  "name": "groq-free",
  "baseUrl": "https://api.groq.com/openai/v1",
  "modelMapping": {
    "default": "llama3-8b-8192",
    "gpt-3.5-turbo": "llama3-8b-8192",
    "gpt-4": "mixtral-8x7b-32768",
    "llama3": "llama3-8b-8192",
    "claude-3-opus": "llama3-70b-8192"
  },
  "modelMappingStrict": false
}
```

**处理逻辑**：

```javascript
function mapModel(source, requestedModel) {
  const mapping = source.modelMapping[requestedModel];
  
  if (mapping) {
    return mapping;
  }
  
  // 无映射但有 default
  if (source.modelMapping['default']) {
    if (source.modelMappingStrict) {
      // 严格模式：无映射时跳过该源
      return { skip: true, reason: 'model_not_supported' };
    }
    return source.modelMapping['default'];
  }
  
  // 无 default 则原样透传
  return requestedModel;
}

// 转发前修改请求体
const modelResult = mapModel(source, req.body.model);
if (modelResult.skip) {
  // 跳过该源，选择下一个
  return selectNextSource();
}
const body = { ...req.body, model: modelResult };
```

**模型路由策略**：
- `modelMappingStrict: false`（默认）：无映射时使用 default 兜底
- `modelMappingStrict: true`：无映射时跳过该源，避免悄悄降级到低能力模型

### 8.3 并发与限流器的竞争条件

**问题**：Node.js 单线程非阻塞，但如果有异步操作可能产生竞争

**安全做法**：

```javascript
// rateLimiter.js - 同步计数，避免异步竞争
class RateLimiter {
  constructor() {
    this.counts = new Map();  // sourceName -> { minuteCount, dayCount, ... }
  }
  
  // 同步检查和递增，确保原子性
  checkAndIncrement(sourceName, limits) {
    const state = this.getState(sourceName);
    
    // 同步检查
    if (state.minuteCount >= limits.requestsPerMinute) {
      return { allowed: false, reason: 'minute_limit' };
    }
    if (state.dayCount >= limits.requestsPerDay) {
      return { allowed: false, reason: 'day_limit' };
    }
    
    // 同步递增
    state.minuteCount++;
    state.dayCount++;
    
    return { allowed: true };
  }
}
```

**注意**：如果后续引入持久化，需要在异步写入前完成内存计数，避免脏写。

### 8.4 状态持久化

**问题**：内存状态在重启后丢失，可能导致：
- 限流计数归零，瞬间超量请求触发上游 429
- 冷却状态丢失，立即请求已知有问题的源

**解决方案**：

```javascript
// stateManager.js
const STATE_FILE = '.state.json';

// 定期持久化（每分钟）
setInterval(() => saveState(), 60 * 1000);

// 优雅退出时保存
process.on('SIGINT', () => saveStateAndExit());
process.on('SIGTERM', () => saveStateAndExit());

// 关键状态变更时立即持久化（异步，不阻塞）
function saveStateImmediate() {
  setImmediate(() => saveState());
}

function saveState() {
  const state = {
    version: 1,
    updatedAt: new Date().toISOString(),
    sources: sourceManager.exportState()
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    sourceManager.importState(state.sources);
  }
}

// 关键事件触发立即持久化
sourceManager.on('cooldown_entered', () => saveStateImmediate());
sourceManager.on('threshold_reached', () => saveStateImmediate());
```

**持久化策略**：
- 定时持久化：每 60 秒
- 事件驱动持久化：触发冷却、连续失败达到阈值时立即保存
- 退出时持久化：SIGINT/SIGTERM 信号

**持久化内容**：
- 各源的请求计数（分钟/天）
- Token 计数（分钟/天）
- 冷却状态和剩余时间
- 连续失败计数

### 8.5 安全性设计

**默认绑定 127.0.0.1**：

```json
{
  "server": {
    "host": "127.0.0.1",  // 不是 0.0.0.0
    "port": 3000
  }
}
```

**Proxy API Key 保护**：

```json
{
  "security": {
    "proxyApiKey": "your-secret-key-here"
  }
}
```

```javascript
// 请求验证中间件
function authMiddleware(req, res, next) {
  const configKey = config.security?.proxyApiKey;
  
  if (!configKey) {
    // 未配置则跳过验证（开发模式）
    return next();
  }
  
  const clientKey = req.headers['authorization']?.replace('Bearer ', '')
                  || req.headers['x-proxy-key'];
  
  if (clientKey !== configKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
}
```

**使用方式**：
```
OPENAI_BASE_URL=http://localhost:3000/v1
OPENAI_API_KEY=your-proxy-key  # 用于验证本地代理
```

### 8.6 Token 级限流（TPM/TPD）

**问题**：免费 API（如 Groq、OpenRouter、Together）中，Token 频率限制（TPM - Tokens Per Minute）往往比请求次数限制更容易触发。

**解决方案**：

```javascript
class TokenTracker {
  constructor() {
    this.tokenCounts = new Map();  // sourceName -> { minuteTokens, dayTokens, ... }
  }
  
  // 流式响应结束后估算 Token 数量
  estimateTokens(text) {
    // 粗略估算：英文 ~4 字符 = 1 token，中文 ~1.5 字符 = 1 token
    return Math.ceil(text.length / 4);
  }
  
  // 流式输出时累计统计
  accumulateTokens(sourceName, chunk) {
    const tokens = this.estimateTokens(chunk);
    const state = this.getState(sourceName);
    state.minuteTokens += tokens;
    state.dayTokens += tokens;
  }
  
  checkLimit(sourceName, limits) {
    const state = this.getState(sourceName);
    
    if (state.minuteTokens >= limits.tokensPerMinute) {
      return { allowed: false, reason: 'token_minute_limit' };
    }
    if (state.dayTokens >= limits.tokensPerDay) {
      return { allowed: false, reason: 'token_day_limit' };
    }
    
    return { allowed: true };
  }
}
```

**注意**：精确 Token 计数需要 tokenizer（如 tiktoken），但会增加依赖和性能开销。初期可用估算方案。

### 8.7 请求超时控制

**问题**：免费 API 常见问题是挂起（Hang）/ 超时，如果上游一直不返回，当前源会阻塞，无法及时触发 failover。

**解决方案**：

```javascript
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeout);
    return { success: true, response };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return { success: false, error: 'timeout', message: `Request timed out after ${timeoutMs}ms` };
    }
    return { success: false, error: err.name, message: err.message };
  }
}

// 使用
const result = await fetchWithTimeout(sourceUrl, options, config.failover.timeoutMs);
if (!result.success) {
  // 超时，标记失败并切换源
  sourceManager.markFailure(source);
  return retryWithNextSource(req, res);
}
```

### 8.8 API 格式转换的复杂性预警

**问题**：OpenAI 与 Anthropic 格式互转难度极大：

| 差异点 | OpenAI | Anthropic |
|--------|--------|-----------|
| System Prompt | `messages` 数组中 `role: system` | 独立 `system` 字段 |
| Tool Calling | `tools` + `tool_choice` | `tools` 结构不同 |
| 多模态 | `content` 可为数组 | `content` 结构不同 |

**建议**：
- **Phase 1**：只做协议代理（端点和鉴权头转换），不做深度 Body 格式转换
- 强制要求客户端发送 OpenAI 兼容格式
- 后端只对接提供 OpenAI 兼容接口的源（Groq、OpenRouter、Together 均天然支持）
- 如需对接原生 Anthropic API，建议引入第三方转换库（如 `@lobehub/chat-plugins-gateway`）

```javascript
// Phase 1 简化策略：只支持 OpenAI 兼容源
const SUPPORTED_FORMATS = ['openai'];

function validateSource(source) {
  if (!SUPPORTED_FORMATS.includes(source.format)) {
    console.warn(`Source ${source.name} uses unsupported format: ${source.format}`);
    return false;
  }
  return true;
}
```

---

## 9. 后续扩展

### Phase 1（当前）
- [x] 基础代理功能
- [x] 自动故障切换
- [x] OpenAI 兼容格式
- [x] 流式输出支持
- [x] 模型名称映射
- [x] 状态持久化

### Phase 2
- [ ] Web 管理界面
- [ ] 实时日志查看
- [ ] 用量图表统计

### Phase 3
- [ ] Tauri 桌面应用
- [ ] 系统托盘运行
- [ ] 开机自启动

---

## 10. 使用方式

### 启动服务
```bash
node index.js
```

### 配置 Claude Code

Claude Code 使用 OpenAI 兼容模式：

```bash
# 设置 provider 为 openai
claude config set provider openai

# 设置 API Key（使用 proxyApiKey）
claude config set openai_api_key your-proxy-key

# 设置 Base URL
claude config set openai_base_url http://localhost:3000/v1
```

或设置环境变量：

```bash
export OPENAI_API_KEY=your-proxy-key
export OPENAI_BASE_URL=http://localhost:3000/v1
```

### 配置其他工具

**Cursor / VSCode 插件**：
```json
{
  "openai.apiKey": "your-proxy-key",
  "openai.baseUrl": "http://localhost:3000/v1"
}
```

**Python OpenAI SDK**：
```python
from openai import OpenAI

client = OpenAI(
    api_key="your-proxy-key",
    base_url="http://localhost:3000/v1"
)
```
