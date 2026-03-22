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

## Quick Start

```bash
# Clone the repository
git clone https://github.com/ituiyuio/APIFriend.git
cd APIFriend

# Install dependencies
npm install

# Copy example config
cp config.example.json config.json

# Edit config and add your API keys
# Then start
npm start
```

After starting:
- Proxy URL: `http://127.0.0.1:3000/v1/chat/completions`
- Admin Dashboard: `http://127.0.0.1:3000/admin/sources`

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
    model="gpt-4",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

## Admin Dashboard

Visit `http://127.0.0.1:3000/admin/sources` to view:
- Source status and statistics
- Real-time rate limiting
- Request trend charts
- Enable/disable sources

## License

MIT