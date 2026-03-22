# APIFriend

API 中转路由服务，支持多源管理、自动故障切换、速率限制。

## 特性

- **多源负载均衡** - 配置多个 API 源，按优先级自动选择
- **自动故障切换** - 源失效时自动切换到备用源
- **速率限制** - 支持 RPM/TPM/日限制，防止超额
- **模型映射** - 将请求模型名映射到实际模型
- **OpenAI & Anthropic 兼容** - 支持 `/v1/chat/completions` 和 `/v1/messages` 端点
- **管理面板** - 现代化 Liquid Glass 风格 UI
- **状态持久化** - 重启后保留统计数据

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/ituiyuio/APIFriend.git
cd APIFriend

# 安装依赖
npm install

# 复制配置文件
cp config.example.json config.json

# 编辑配置，填入你的 API Key
# 然后启动
npm start
```

服务启动后：
- 代理地址: `http://127.0.0.1:3000/v1/chat/completions`
- 管理面板: `http://127.0.0.1:3000/admin/sources`

## 配置说明

```json
{
  "server": {
    "port": 3000,
    "host": "127.0.0.1"
  },
  "security": {
    "proxyApiKey": "your-secure-key"  // 可选，保护代理端点
  },
  "sources": [
    {
      "name": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "YOUR_API_KEY",
      "priority": 1,
      "enabled": true,
      "format": "openai",
      "rateLimit": {
        "requestsPerMinute": 20,
        "tokensPerMinute": 6000
      },
      "modelMapping": {
        "gpt-4": "anthropic/claude-3-opus",
        "default": "meta-llama/llama-3-8b-instruct"
      }
    }
  ],
  "failover": {
    "timeoutMs": 15000,
    "maxRetries": 3,
    "cooldownMinutes": 5
  }
}
```

### 源配置字段

| 字段 | 说明 |
|------|------|
| `name` | 源名称，用于标识 |
| `baseUrl` | API 基础 URL |
| `apiKey` | API 密钥 |
| `priority` | 优先级，数字越小越优先 |
| `enabled` | 是否启用 |
| `format` | API 格式: `openai` 或 `anthropic` |
| `rateLimit` | 速率限制配置 |
| `modelMapping` | 模型名映射 |

## API 端点

### 代理端点

```
POST /v1/chat/completions    # OpenAI 兼容
POST /v1/messages            # Anthropic 兼容
GET  /v1/models              # 列出可用模型
```

### 管理端点

```
GET    /admin/sources              # 获取所有源
POST   /admin/sources              # 创建源
GET    /admin/sources/:name        # 获取单个源
PATCH  /admin/sources/:name        # 更新源
DELETE /admin/sources/:name        # 删除源
POST   /admin/sources/:name/toggle # 切换启用状态
POST   /admin/sources/:name/reset  # 重置源状态
GET    /admin/stats                # 获取统计
GET    /admin/stats/history        # 获取历史统计
GET    /admin/health               # 健康检查
POST   /admin/reload               # 重载配置
```

## 使用示例

```python
import openai

client = openai.OpenAI(
    api_key="any",  # 或配置中的 proxyApiKey
    base_url="http://127.0.0.1:3000/v1"
)

response = client.chat.completions.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

## 管理面板

访问 `http://127.0.0.1:3000/admin/sources` 查看：
- 源状态和统计
- 实时速率限制
- 请求趋势图表
- 启用/禁用源

## 许可证

MIT
