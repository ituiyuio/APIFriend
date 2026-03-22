# APIFriend

API proxy service with multi-source management, automatic failover, and rate limiting.

## Features

- **Multi-Source Load Balancing** - Configure multiple API sources with priority-based selection
- **Auto Failover** - Automatically switch to backup sources on failure
- **Rate Limiting** - Support RPM/TPM/daily limits to prevent overages
- **Model Mapping** - Map request model names to actual models
- **OpenAI & Anthropic Compatible** - Supports `/v1/chat/completions` and `/v1/messages` endpoints
- **Admin Dashboard** - Modern Liquid Glass style UI
- **State Persistence** - Retain stats across restarts

## Installation

### Option 1: NPM (Recommended)

```bash
npm install -g apifriend

# Create config file
mkdir -p ~/.apifriend && cd ~/.apifriend
curl -O https://raw.githubusercontent.com/ituiyuio/APIFriend/main/config.example.json
mv config.example.json config.json
# Edit config.json and add your API keys

# Start
apifriend
```

### Option 2: Windows EXE

Download `apifriend.exe` from [Releases](https://github.com/ituiyuio/APIFriend/releases).

```bash
# Place apifriend.exe and config.json in the same directory
# Edit config.json and add your API keys
apifriend.exe
```

### Option 3: From Source

```bash
git clone https://github.com/ituiyuio/APIFriend.git
cd APIFriend
npm install
cp config.example.json config.json
# Edit config.json and add your API keys
npm start
```

After starting:
- Proxy URL: `http://127.0.0.1:3000/v1/chat/completions`
- Admin Dashboard: `http://127.0.0.1:3000/admin/sources`

## Run in Background (Windows)

```bash
# Option 1: Start minimized
start /B apifriend.exe

# Option 2: Register as Windows Service (recommended for production)
nssm install APIFriend "C:\path\to\apifriend.exe"
nssm start APIFriend
```

## Configuration

```json
{
  "server": {
    "port": 3000,
    "host": "127.0.0.1"
  },
  "security": {
    "proxyApiKey": "your-secure-key"
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
        "friend": "anthropic/claude-3.5-sonnet",
        "default": "anthropic/claude-3.5-sonnet"
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

### Source Fields

| Field | Description |
|-------|-------------|
| `name` | Source identifier |
| `baseUrl` | API base URL |
| `apiKey` | API key |
| `priority` | Lower number = higher priority |
| `enabled` | Whether source is active |
| `format` | API format: `openai` or `anthropic` |
| `rateLimit` | Rate limit configuration |
| `modelMapping` | Model name mapping |

## API Endpoints

### Proxy Endpoints

```
POST /v1/chat/completions    # OpenAI compatible
POST /v1/messages            # Anthropic compatible
GET  /v1/models              # List available models
```

### Admin Endpoints

```
GET    /admin/sources              # List all sources
POST   /admin/sources              # Create source
GET    /admin/sources/:name        # Get source details
PATCH  /admin/sources/:name        # Update source
DELETE /admin/sources/:name        # Delete source
POST   /admin/sources/:name/toggle # Toggle enabled status
POST   /admin/sources/:name/reset  # Reset source stats
GET    /admin/stats                # Get statistics
GET    /admin/stats/history        # Get historical stats
GET    /admin/health               # Health check
POST   /admin/reload               # Reload config
```

## Usage Example

```python
import openai

client = openai.OpenAI(
    api_key="any",
    base_url="http://127.0.0.1:3000/v1"
)

response = client.chat.completions.create(
    model="friend",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

### Claude Code

For Claude Code, use:

```bash
claude --model friend
```

## Admin Dashboard

Visit `http://127.0.0.1:3000/admin/sources` to view:
- Source status and statistics
- Real-time rate limiting
- Request trend charts
- Enable/disable sources

## Sponsor / 赞助支持

If APIFriend helps you, consider supporting the project:

如果 APIFriend 对你有帮助，欢迎赞助支持：

❤️ https://afdian.com/a/Yomin

## License

MIT