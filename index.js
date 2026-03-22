#!/usr/bin/env node
/**
 * APIFriend - API 中转路由服务入口文件
 * 整合所有模块，启动 Express 服务
 */

const express = require('express');
const http = require('http');

// 导入模块
const { loadConfig, validateConfig, DEFAULT_CONFIG, watchConfig, reloadConfig } = require('./src/config');
const { RateLimiter } = require('./src/rateLimiter');
const { SourceManager, SourceStatus } = require('./src/sourceManager');
const { Proxy } = require('./src/proxy');
const { FailoverDetector } = require('./src/failover');
const { StreamErrorHandler } = require('./src/streamErrorHandler');
const { StatsRecorder } = require('./src/statsRecorder');
const { 
  StatePersistence, 
  createSourceManagerProvider, 
  createRateLimiterProvider,
  createFailoverDetectorProvider,
  createStreamErrorHandlerProvider,
  createStatsRecorderProvider
} = require('./src/statePersistence');
const { createAdminRouter } = require('./src/adminApi');
const { 
  createAuthMiddleware, 
  createSecurityHeadersMiddleware,
  createRateLimitMiddleware 
} = require('./src/authMiddleware');
const { 
  Logger, 
  LogLevel, 
  getLogger, 
  createRequestLogMiddleware,
  createErrorLogMiddleware 
} = require('./src/logger');

/**
 * APIFriend 应用类
 */
class APIFriendApp {
  constructor(options = {}) {
    this.configPath = options.configPath || 'config.json';
    this.config = null;
    
    // 组件实例
    this.logger = null;
    this.rateLimiter = null;
    this.sourceManager = null;
    this.proxy = null;
    this.failoverDetector = null;
    this.streamErrorHandler = null;
    this.statePersistence = null;
    this.statsRecorder = null;
    
    // Express
    this.app = null;
    this.server = null;
    
    // 状态
    this.isRunning = false;
  }
  
  /**
   * 初始化应用
   */
  async initialize() {
    // 1. 加载配置
    this.config = loadConfig(this.configPath);
    const validation = validateConfig(this.config);
    if (!validation.valid) {
      throw new Error(`Invalid configuration: ${validation.errors.join(', ')}`);
    }
    
    // 2. 初始化日志
    this.logger = new Logger({
      name: 'APIFriend',
      level: this._parseLogLevel(this.config.logging?.level),
      console: true,
      file: this.config.logging?.file,
      colorize: true,
      format: 'json'
    });
    
    this.logger.info('APIFriend initializing...', {
      version: require('./package.json').version,
      configPath: this.configPath
    });
    
    // 3. 初始化限流器
    this.rateLimiter = new RateLimiter();
    this.logger.debug('RateLimiter initialized');
    
    // 4. 初始化源管理器
    this.sourceManager = new SourceManager(this.config);
    this.logger.info('SourceManager initialized', {
      sourceCount: this.config.sources.length
    });
    
    // 5. 初始化统计记录器
    this.statsRecorder = new StatsRecorder({
      maxHours: 24,
      maxDays: 30
    });
    this.logger.debug('StatsRecorder initialized');
    
    // 6. 初始化代理核心
    this.proxy = new Proxy(this.config, this.rateLimiter, this.statsRecorder);
    this.logger.debug('Proxy initialized');
    
    // 7. 初始化故障检测器
    this.failoverDetector = new FailoverDetector(this.config);
    this.logger.debug('FailoverDetector initialized');
    
    // 8. 初始化流式错误处理器
    this.streamErrorHandler = new StreamErrorHandler({
      onLog: (level, msg, data) => this.logger[level](msg, data)
    });
    this.logger.debug('StreamErrorHandler initialized');
    
    // 9. 初始化状态持久化
    if (this.config.persistence?.enabled !== false) {
      this.statePersistence = new StatePersistence({
        file: this.config.persistence?.file || '.state.json',
        intervalMs: this.config.persistence?.intervalMs || 60000,
        saveOnExit: true,
        onLog: (level, msg, data) => this.logger[level](msg, data)
      });
      
      // 注册状态提供者
      this.statePersistence.register(
        'sourceManager', 
        ...Object.values(createSourceManagerProvider(this.sourceManager))
      );
      this.statePersistence.register(
        'rateLimiter',
        ...Object.values(createRateLimiterProvider(this.rateLimiter))
      );
      this.statePersistence.register(
        'failoverDetector',
        ...Object.values(createFailoverDetectorProvider(this.failoverDetector))
      );
      this.statePersistence.register(
        'streamErrorHandler',
        ...Object.values(createStreamErrorHandlerProvider(this.streamErrorHandler))
      );
      this.statePersistence.register(
        'statsRecorder',
        ...Object.values(createStatsRecorderProvider(this.statsRecorder))
      );
      
      // 加载已保存的状态
      await this.statePersistence.load();
      
      // 启动自动保存
      this.statePersistence.startAutoSave();
      
      // 设置状态变化回调，触发立即持久化
      this.sourceManager.onStateChange = () => {
        this.statePersistence.save(true).catch(err => {
          this.logger.warn('Failed to save state on change', { error: err.message });
        });
      };
      
      this.logger.info('StatePersistence initialized');
    }
    
    // 9. 设置事件监听
    this._setupEventListeners();
    
    this.logger.info('APIFriend initialized successfully');
  }
  
  /**
   * 设置事件监听
   */
  _setupEventListeners() {
    // 源状态变化
    this.sourceManager.on('source_failure', ({ source, error }) => {
      this.logger.warn('Source failure', { source, error });
    });
    
    this.sourceManager.on('cooldown_entered', ({ source, until }) => {
      this.logger.warn('Source entered cooldown', { source, until });
      // 触发立即持久化
      this.statePersistence?.save(true);
    });
    
    this.sourceManager.on('cooldown_exited', ({ source }) => {
      this.logger.info('Source exited cooldown', { source });
    });
    
    // 监听配置文件变化
    this._onConfigChange = (newConfig) => {
      this.logger.info('Config file changed, reloading sources...');
      
      // 更新源配置
      if (newConfig.sources) {
        this.sourceManager.updateConfig({ sources: newConfig.sources });
        this.logger.info(`Reloaded ${newConfig.sources.length} sources from config`);
      }
    };
    
    this.configWatcher = watchConfig(this._onConfigChange);
  }
  
  /**
   * 手动重载配置
   */
  reloadConfig() {
    const newConfig = reloadConfig(this._onConfigChange);
    return newConfig;
  }
  
  /**
   * 解析日志级别
   */
  _parseLogLevel(level) {
    const levels = {
      'debug': LogLevel.DEBUG,
      'info': LogLevel.INFO,
      'warn': LogLevel.WARN,
      'error': LogLevel.ERROR
    };
    return levels[level?.toLowerCase()] ?? LogLevel.INFO;
  }
  
  /**
   * 创建 Express 应用
   */
  _createExpressApp() {
    const app = express();
    
    // 基础中间件
    app.use(express.json({ limit: '10mb' }));
    app.use(express.raw({ type: 'application/octet-stream', limit: '10mb' }));
    
    // 安全头
    app.use(createSecurityHeadersMiddleware());
    
    // 请求日志
    app.use(createRequestLogMiddleware(this.logger));
    
    // 认证中间件（仅保护代理路由 /v1/*）
    if (this.config.security?.proxyApiKey) {
      app.use(createAuthMiddleware({
        proxyApiKey: this.config.security.proxyApiKey,
        adminApiKey: this.config.security.adminApiKey,
        onLog: (level, msg, data) => this.logger[level](msg, data)
      }));
      this.logger.info('Authentication middleware enabled');
    }
    
    // 速率限制（可选）
    if (this.config.security?.rateLimit) {
      app.use(createRateLimitMiddleware({
        windowMs: this.config.security.rateLimit.windowMs || 60000,
        maxRequests: this.config.security.rateLimit.maxRequests || 100
      }));
    }
    
    // 管理 API
    app.use('/admin', createAdminRouter({
      sourceManager: this.sourceManager,
      rateLimiter: this.rateLimiter,
      failoverDetector: this.failoverDetector,
      statePersistence: this.statePersistence,
      statsRecorder: this.statsRecorder,
      config: this.config,
      startTime: this.startTime,
      onLog: (level, msg, data) => this.logger[level](msg, data),
      onReloadConfig: () => this.reloadConfig()
    }));
    
    // 静态文件服务（管理面板）
    const path = require('path');
    app.use(express.static(path.join(__dirname, 'public')));
    
    // 代理路由 - OpenAI 兼容端点
    app.use('/v1', this._createProxyRouter());
    
    // 根路径 - 重定向到管理面板
    app.get('/', (req, res) => {
      res.redirect('/index.html');
    });
    
    // 404 处理
    app.use((req, res) => {
      res.status(404).json({
        error: {
          type: 'not_found',
          message: `Route not found: ${req.method} ${req.path}`
        }
      });
    });
    
    // 错误处理
    app.use(createErrorLogMiddleware(this.logger));
    app.use((err, req, res, next) => {
      res.status(err.status || 500).json({
        error: {
          type: 'internal_error',
          message: err.message
        }
      });
    });
    
    return app;
  }
  
  /**
   * 创建代理路由
   */
  _createProxyRouter() {
    const router = express.Router();
    
    // GET /v1/models - 列出可用模型
    router.get('/models', (req, res) => {
      // 只返回 friend 模型，简化 Claude Code 选择
      const models = ['friend'];
      
      res.json({
        object: 'list',
        data: models.map(id => ({
          id,
          object: 'model',
          created: Date.now(),
          owned_by: 'apifriend'
        }))
      });
    });
    
    // GET /v1/models/:model - 获取单个模型
    router.get('/models/:model', (req, res) => {
      const modelId = req.params.model;
      
      res.json({
        id: modelId,
        object: 'model',
        created: Date.now(),
        owned_by: 'apifriend'
      });
    });
    
    // POST /v1/chat/completions - 聊天完成
    router.post('/chat/completions', async (req, res) => {
      await this._handleProxyRequest(req, res);
    });
    
    // POST /v1/completions - 文本完成
    router.post('/completions', async (req, res) => {
      await this._handleProxyRequest(req, res);
    });
    
    // POST /v1/embeddings - 嵌入
    router.post('/embeddings', async (req, res) => {
      await this._handleProxyRequest(req, res);
    });
    
    // POST /v1/messages - Anthropic 原生 API 兼容
    router.post('/messages', async (req, res) => {
      await this._handleAnthropicRequest(req, res);
    });
    
    return router;
  }
  
  /**
   * 处理 Anthropic 格式的请求
   * 将 Anthropic API 格式转换为 OpenAI 格式
   */
  async _handleAnthropicRequest(req, res) {
    const startTime = Date.now();
    const maxRetries = this.failoverConfig?.maxRetries || 3;
    const retryDelayMs = this.failoverConfig?.retryDelayMs || 1000;
    
    // 转换 Anthropic 格式到 OpenAI 格式
    const anthropicBody = req.body;
    const openaiBody = this._convertAnthropicToOpenAI(anthropicBody);
    const requestedModel = anthropicBody.model;
    
    let currentSource = null;
    let retryCount = 0;
    
    while (retryCount < maxRetries) {
      // 选择源
      if (!currentSource) {
        const selected = this.sourceManager.selectSource(requestedModel);
        if (!selected) {
          return res.status(503).json({
            type: 'error',
            error: {
              type: 'no_available_source',
              message: 'No available source found'
            }
          });
        }
        currentSource = selected;
      }
      
      // 构建请求体（应用模型映射）
      const requestBody = {
        ...openaiBody,
        model: currentSource.mappedModel || openaiBody.model
      };
      
      try {
        // 转发请求
        const result = await this.proxy.forward(
          currentSource.source,
          '/chat/completions',
          'POST',
          requestBody,
          { 'content-type': 'application/json' }
        );
        
        if (result.success) {
          // 标记成功
          this.sourceManager.markSuccess(currentSource.source.name);
          
          // 流式响应
          if (result.isStream) {
            return await this._handleAnthropicStreamResponse(res, result.response, anthropicBody.model, currentSource.source.name, startTime);
          }
          
          // 非流式响应
          return await this._handleAnthropicNonStreamResponse(res, result.response, anthropicBody.model, currentSource.source.name, startTime);
        }
        
        // 失败，标记并尝试切换源
        this.sourceManager.markFailure(currentSource.source.name, result.errorType, {
          type: result.errorType,
          message: result.error || result.message,
          statusCode: result.statusCode
        });
        
        this.logger.warn('Anthropic proxy request failed, trying next source', {
          path: req.path,
          source: currentSource.source.name,
          error: result.error,
          errorType: result.errorType
        });
        
        // 认证错误不重试
        if (result.errorType === 'auth_error') {
          return res.status(result.statusCode || 502).json({
            type: 'error',
            error: {
              type: 'proxy_error',
              message: result.message || 'Authentication failed'
            }
          });
        }
        
        // 选择下一个源
        const nextSource = this.sourceManager.selectNextSource(currentSource.source.name, requestedModel);
        
        if (!nextSource) {
          // 没有可用源了
          return res.status(503).json({
            type: 'error',
            error: {
              type: 'all_sources_failed',
              message: 'All sources are unavailable'
            }
          });
        }
        
        // 切换到下一个源
        currentSource = nextSource;
        retryCount++;
        
        // 延迟重试
        if (retryDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        }
        
      } catch (err) {
        this.logger.error('Anthropic proxy request error', {
          path: req.path,
          error: err.message,
          stack: err.stack
        });
        
        this.sourceManager.markFailure(currentSource.source.name, 'network_error', {
          type: 'network_error',
          message: err.message
        });
        
        // 尝试下一个源
        const nextSource = this.sourceManager.selectNextSource(currentSource.source.name, requestedModel);
        if (!nextSource) {
          if (!res.headersSent) {
            return res.status(502).json({
              type: 'error',
              error: {
                type: 'proxy_error',
                message: err.message
              }
            });
          }
          return;
        }
        
        currentSource = nextSource;
        retryCount++;
      }
    }
    
    // 超过最大重试次数
    if (!res.headersSent) {
      return res.status(503).json({
        type: 'error',
        error: {
          type: 'max_retries_exceeded',
          message: `Failed after ${maxRetries} retries`
        }
      });
    }
  }
  
  /**
   * 处理 Anthropic 流式响应
   */
  async _handleAnthropicStreamResponse(res, upstreamResponse, model, sourceName, startTime) {
    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    
    const messageId = `msg_${Date.now()}`;
    
    // 发送 message_start 事件
    const messageStart = {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: model,
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    };
    res.write(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`);
    
    let hasStartedContent = false;
    let hasStartedToolUse = false;
    let currentToolCall = null; // 用于累积 tool_call 参数
    let toolCallIndex = 0;
    let fullText = '';
    let sseBuffer = ''; // 用于处理跨 chunk 的 SSE 数据
    
    try {
      const reader = upstreamResponse.body.getReader();
      const decoder = new TextDecoder();
      
      const pump = async () => {
        const { done, value } = await reader.read();
        
        if (done) {
          // 发送结束事件
          if (hasStartedContent) {
            res.write(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`);
          }
          if (hasStartedToolUse) {
            res.write(`event: content_block_stop\ndata: {"type":"content_block_stop","index":${hasStartedContent ? 1 : 0}}\n\n`);
          }
          const stopReason = currentToolCall ? 'tool_use' : 'end_turn';
          res.write(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"${stopReason}"},"usage":{"output_tokens":0}}\n\n`);
          res.write(`event: message_stop\ndata: {}\n\n`);
          res.end();
          
          const latency = Date.now() - startTime;
          
          // 记录统计
          if (this.statsRecorder) {
            this.statsRecorder.recordRequest({
              source: sourceName,
              success: true,
              latency: latency
            });
          }
          
          this.logger.info('Anthropic proxy request completed', {
            path: '/v1/messages',
            source: sourceName,
            model: model,
            isStream: true,
            duration: latency
          });
          return;
        }
        
        const chunk = decoder.decode(value, { stream: true });
        fullText += chunk;
        sseBuffer += chunk;
        
        // 按双换行符分割完整的 SSE 事件，保留最后一个不完整的部分
        const events = sseBuffer.split('\n\n');
        sseBuffer = events.pop() || ''; // 保留最后一个可能不完整的部分
        
        // 处理完整的 SSE 事件
        for (const event of events) {
          const lines = event.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (data === '[DONE]') continue;
              if (!data) continue;
              
              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta;
                
                // 处理文本内容
                if (delta?.content) {
                  // 首次输出内容时发送 content_block_start
                  if (!hasStartedContent) {
                    hasStartedContent = true;
                    res.write(`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`);
                  }
                  
                  // 使用 JSON.stringify 正确转义并发送内容
                  res.write(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(delta.content)}}}\n\n`);
                }
                
                // 处理工具调用
                if (delta?.tool_calls && delta.tool_calls.length > 0) {
                  for (const toolCallDelta of delta.tool_calls) {
                    // 工具调用开始
                    if (toolCallDelta.function?.name) {
                      const blockIndex = hasStartedContent ? 1 : 0;
                      if (!hasStartedToolUse) {
                        hasStartedToolUse = true;
                        toolCallIndex = blockIndex;
                        currentToolCall = {
                          id: toolCallDelta.id || `call_${Date.now()}`,
                          name: toolCallDelta.function.name,
                          arguments: ''
                        };
                        res.write(`event: content_block_start\ndata: ${JSON.stringify({
                          type: "content_block_start",
                          index: blockIndex,
                          content_block: {
                            type: "tool_use",
                            id: currentToolCall.id,
                            name: currentToolCall.name,
                            input: {}
                          }
                        })}\n\n`);
                      }
                    }
                    
                    // 工具参数增量
                    if (toolCallDelta.function?.arguments) {
                      if (currentToolCall) {
                        currentToolCall.arguments += toolCallDelta.function.arguments;
                      }
                      const blockIndex = hasStartedContent ? 1 : 0;
                      res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                        type: "content_block_delta",
                        index: blockIndex,
                        delta: {
                          type: "input_json_delta",
                          partial_json: toolCallDelta.function.arguments
                        }
                      })}\n\n`);
                    }
                  }
                }
              } catch (e) {
                // 忽略解析错误，可能是不完整的数据
              }
            }
          }
        }
        
        await pump();
      };
      
      await pump();
      
    } catch (err) {
      this.logger.error('Anthropic stream error', { error: err.message });
      if (!res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: err.message } })}\n\n`);
        res.end();
      }
    }
  }
  
  /**
   * 处理 Anthropic 非流式响应
   */
  async _handleAnthropicNonStreamResponse(res, upstreamResponse, model, sourceName, startTime) {
    try {
      const body = await upstreamResponse.json();
      
      const anthropicResponse = this._convertOpenAIToAnthropic(body, model);
      
      const latency = Date.now() - startTime;
      const tokens = (body.usage?.prompt_tokens || 0) + (body.usage?.completion_tokens || 0);
      
      // 记录统计
      if (this.statsRecorder) {
        this.statsRecorder.recordRequest({
          source: sourceName,
          success: true,
          tokens: tokens,
          latency: latency
        });
      }
      
      this.logger.info('Anthropic proxy request completed', {
        path: '/v1/messages',
        source: sourceName,
        model: model,
        isStream: false,
        duration: latency
      });
      
      res.json(anthropicResponse);
    } catch (err) {
      this.logger.error('Anthropic response parse error', { error: err.message });
      res.status(502).json({
        type: 'error',
        error: {
          type: 'response_parse_error',
          message: err.message
        }
      });
    }
  }
  
  /**
   * 将 OpenAI 响应格式转换为 Anthropic 格式
   */
  _convertOpenAIToAnthropic(openaiResponse, model) {
    const message = openaiResponse.choices?.[0]?.message;
    const inputTokens = openaiResponse.usage?.prompt_tokens || 0;
    const outputTokens = openaiResponse.usage?.completion_tokens || 0;
    const finishReason = openaiResponse.choices?.[0]?.finish_reason;
    
    const content = [];
    
    // 添加文本内容
    if (message?.content) {
      content.push({
        type: 'text',
        text: message.content
      });
    }
    
    // 添加工具调用
    if (message?.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        let input = {};
        try {
          input = JSON.parse(toolCall.function.arguments || '{}');
        } catch (e) {
          // 解析失败时保持空对象
        }
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input: input
        });
      }
    }
    
    // 如果没有内容，添加空文本
    if (content.length === 0) {
      content.push({
        type: 'text',
        text: ''
      });
    }
    
    // 确定停止原因
    let stopReason = 'end_turn';
    if (finishReason === 'length') {
      stopReason = 'max_tokens';
    } else if (finishReason === 'tool_calls' || message?.tool_calls) {
      stopReason = 'tool_use';
    }
    
    return {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: model,
      content: content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens
      }
    };
  }
  
  /**
   * 将 Anthropic 格式转换为 OpenAI 格式
   */
  _convertAnthropicToOpenAI(anthropicBody) {
    const messages = [];
    
    // 处理 system
    if (anthropicBody.system) {
      messages.push({
        role: 'system',
        content: anthropicBody.system
      });
    }
    
    // 处理 messages
    if (anthropicBody.messages && Array.isArray(anthropicBody.messages)) {
      for (const msg of anthropicBody.messages) {
        // 处理 content 可能是字符串或数组的情况
        const content = msg.content;
        
        if (typeof content === 'string') {
          messages.push({
            role: msg.role,
            content: content
          });
        } else if (Array.isArray(content)) {
          // 分离不同类型的内容
          const textParts = content.filter(c => c.type === 'text');
          const toolResults = content.filter(c => c.type === 'tool_result');
          const toolUses = content.filter(c => c.type === 'tool_use');
          
          // 文本内容
          if (textParts.length > 0) {
            const textContent = textParts.map(c => c.text).join('\n');
            messages.push({
              role: msg.role,
              content: textContent
            });
          }
          
          // 工具结果 (Anthropic: tool_result -> OpenAI: tool role)
          for (const result of toolResults) {
            let resultContent = result.content;
            if (typeof resultContent === 'object') {
              resultContent = JSON.stringify(resultContent);
            }
            messages.push({
              role: 'tool',
              tool_call_id: result.tool_use_id,
              content: resultContent || ''
            });
          }
          
          // 工具使用 (Anthropic: tool_use in assistant -> OpenAI: tool_calls)
          if (toolUses.length > 0 && msg.role === 'assistant') {
            const toolCalls = toolUses.map(tu => ({
              id: tu.id,
              type: 'function',
              function: {
                name: tu.name,
                arguments: typeof tu.input === 'object' ? JSON.stringify(tu.input) : (tu.input || '{}')
              }
            }));
            
            // 添加 assistant 消息，包含 tool_calls
            const assistantMsg = {
              role: 'assistant',
              content: textParts.length > 0 ? textParts.map(c => c.text).join('\n') : null,
              tool_calls: toolCalls
            };
            messages.push(assistantMsg);
          }
          
          // 如果只有文本且没有特殊处理
          if (textParts.length > 0 && toolResults.length === 0 && toolUses.length === 0) {
            // 已经在上面处理了
          } else if (textParts.length === 0 && toolResults.length === 0 && toolUses.length === 0) {
            // 空内容
          }
        }
      }
    }
    
    const openaiBody = {
      model: anthropicBody.model,
      messages: messages,
      stream: anthropicBody.stream || false,
      max_tokens: anthropicBody.max_tokens,
      temperature: anthropicBody.temperature,
      top_p: anthropicBody.top_p,
      stop: anthropicBody.stop_sequences
    };
    
    // 转换工具定义
    if (anthropicBody.tools && anthropicBody.tools.length > 0) {
      openaiBody.tools = anthropicBody.tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema
        }
      }));
    }
    
    return openaiBody;
  }
  
  /**
   * 处理代理请求
   */
  async _handleProxyRequest(req, res) {
    const startTime = Date.now();
    
    try {
      const result = await this.proxy.handleRequest(
        this.sourceManager,
        req.path,
        req.method,
        req.body,
        req.headers,
        res
      );
      
      if (!result.success) {
        const duration = Date.now() - startTime;
        this.logger.error('Proxy request failed', {
          path: req.path,
          error: result.error,
          duration
        });
        
        // 如果响应还没有发送，发送错误响应
        if (!res.headersSent) {
          res.status(502).json({
            error: {
              type: 'proxy_error',
              message: result.message || result.error,
              code: result.error
            }
          });
        }
        return;
      }
      
      // 记录成功的请求
      const duration = Date.now() - startTime;
      this.logger.info('Proxy request completed', {
        path: req.path,
        source: result.source?.name,
        model: req.body?.model,
        isStream: result.isStream,
        duration
      });
      
    } catch (err) {
      this.logger.error('Proxy request error', {
        path: req.path,
        error: err.message,
        stack: err.stack
      });
      
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            type: 'internal_error',
            message: err.message
          }
        });
      }
    }
  }
  
  /**
   * 启动服务
   */
  async start() {
    if (this.isRunning) {
      throw new Error('APIFriend is already running');
    }
    
    // 初始化
    await this.initialize();
    
    // 设置启动时间（在创建 app 之前）
    this.startTime = Date.now();
    
    // 创建 Express 应用
    this.app = this._createExpressApp();
    
    // 创建 HTTP 服务器
    this.server = http.createServer(this.app);
    
    // 启动监听
    const host = this.config.server?.host || '127.0.0.1';
    const port = this.config.server?.port || 3000;
    
    return new Promise((resolve, reject) => {
      this.server.listen(port, host, (err) => {
        if (err) {
          reject(err);
          return;
        }
        
        this.isRunning = true;
        
        this.logger.info('APIFriend started', {
          host,
          port,
          url: `http://${host}:${port}`
        });
        
        console.log(`\n🚀 APIFriend is running at http://${host}:${port}`);
        console.log(`   Proxy:    http://${host}:${port}/v1/chat/completions`);
        console.log(`   Admin:    http://${host}:${port}/admin/sources`);
        console.log(`   Health:   http://${host}:${port}/admin/health\n`);
        
        resolve();
      });
    });
  }
  
  /**
   * 停止服务
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }
    
    this.logger.info('APIFriend shutting down...');
    
    // 关闭配置文件监听
    this.configWatcher?.close();
    
    // 停止自动保存
    this.statePersistence?.stopAutoSave();
    
    // 保存最终状态
    await this.statePersistence?.save(true);
    
    // 关闭服务器
    return new Promise((resolve) => {
      this.server?.close(() => {
        this.isRunning = false;
        this.logger.info('APIFriend stopped');
        resolve();
      });
    });
  }
  
  /**
   * 获取应用状态
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      config: {
        host: this.config.server?.host,
        port: this.config.server?.port
      },
      sources: this.sourceManager?.getAllSources().map(s => ({
        name: s.name,
        enabled: s.enabled,
        priority: s.priority
      })),
      logger: this.logger?.getStats()
    };
  }
}

// 主入口
async function main() {
  const app = new APIFriendApp();
  
  // 优雅关闭
  process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT, shutting down...');
    await app.stop();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM, shutting down...');
    await app.stop();
    process.exit(0);
  });
  
  // 启动
  try {
    await app.start();
  } catch (err) {
    console.error('Failed to start APIFriend:', err.message);
    process.exit(1);
  }
}

// 导出
module.exports = {
  APIFriendApp,
  main
};

// 直接运行时启动
if (require.main === module) {
  main();
}
