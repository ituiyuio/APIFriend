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
  createStreamErrorHandlerProvider
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
    
    try {
      // 转换 Anthropic 格式到 OpenAI 格式
      const anthropicBody = req.body;
      const openaiBody = this._convertAnthropicToOpenAI(anthropicBody);
      const isStream = openaiBody.stream;
      const requestedModel = anthropicBody.model;
      
      // 选择源
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
      
      // 构建请求体（应用模型映射）
      const requestBody = {
        ...openaiBody,
        model: selected.mappedModel || openaiBody.model
      };
      
      // 转发请求
      const result = await this.proxy.forward(
        selected.source,
        '/chat/completions',
        'POST',
        requestBody,
        { 'content-type': 'application/json' }
      );
      
      const duration = Date.now() - startTime;
      
      if (!result.success) {
        this.sourceManager.markFailure(selected.source.name, result.errorType, {
          type: result.errorType,
          message: result.error || result.message,
          statusCode: result.statusCode
        });
        
        this.logger.error('Anthropic proxy request failed', {
          path: req.path,
          source: selected.source.name,
          error: result.error,
          duration
        });
        
        return res.status(result.statusCode || 502).json({
          type: 'error',
          error: {
            type: 'proxy_error',
            message: result.message || (typeof result.error === 'string' ? result.error : JSON.stringify(result.error))
          }
        });
      }
      
      // 标记成功
      this.sourceManager.markSuccess(selected.source.name);
      
      // 流式响应
      if (result.isStream) {
        return await this._handleAnthropicStreamResponse(res, result.response, anthropicBody.model, selected.source.name, startTime);
      }
      
      // 非流式响应
      return await this._handleAnthropicNonStreamResponse(res, result.response, anthropicBody.model, selected.source.name, startTime);
      
    } catch (err) {
      this.logger.error('Anthropic proxy request error', {
        path: req.path,
        error: err.message,
        stack: err.stack
      });
      
      if (!res.headersSent) {
        res.status(500).json({
          type: 'error',
          error: {
            type: 'internal_error',
            message: err.message
          }
        });
      }
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
    let fullText = '';
    
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
          res.write(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n`);
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
        
        // 解析 OpenAI SSE 格式
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;
              
              if (delta?.content) {
                // 首次输出内容时发送 content_block_start
                if (!hasStartedContent) {
                  hasStartedContent = true;
                  res.write(`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`);
                }
                
                // 转义并发送内容
                const escapedContent = delta.content
                  .replace(/\\/g, '\\\\')
                  .replace(/"/g, '\\"')
                  .replace(/\n/g, '\\n')
                  .replace(/\r/g, '\\r')
                  .replace(/\t/g, '\\t');
                
                res.write(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${escapedContent}"}}\n\n`);
              }
            } catch (e) {
              // 忽略解析错误
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
    const content = openaiResponse.choices?.[0]?.message?.content || '';
    const inputTokens = openaiResponse.usage?.prompt_tokens || 0;
    const outputTokens = openaiResponse.usage?.completion_tokens || 0;
    
    return {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: model,
      content: [
        {
          type: 'text',
          text: content
        }
      ],
      stop_reason: openaiResponse.choices?.[0]?.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
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
        let content = msg.content;
        if (Array.isArray(content)) {
          // 提取文本内容
          content = content
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('\n');
        }
        
        messages.push({
          role: msg.role,
          content: content
        });
      }
    }
    
    return {
      model: anthropicBody.model,
      messages: messages,
      stream: anthropicBody.stream || false,
      max_tokens: anthropicBody.max_tokens,
      temperature: anthropicBody.temperature,
      top_p: anthropicBody.top_p,
      stop: anthropicBody.stop_sequences
    };
  }
  
  /**
   * 创建 Anthropic 流式响应转换器
   * 将 OpenAI SSE 格式转换为 Anthropic SSE 格式
   */
  _createAnthropicStreamTransformer(model, messageId) {
    let hasStartedContent = false;
    
    return (openaiChunk) => {
      try {
        // 解析 OpenAI chunk
        if (!openaiChunk || openaiChunk === '[DONE]') {
          // 发送结束事件
          const events = [];
          events.push(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`);
          events.push(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n`);
          events.push(`event: message_stop\ndata: {}\n\n`);
          return events.join('');
        }
        
        const data = JSON.parse(openaiChunk);
        const delta = data.choices?.[0]?.delta;
        const finishReason = data.choices?.[0]?.finish_reason;
        
        if (!delta && !finishReason) return null;
        
        const events = [];
        
        // 处理内容
        if (delta?.content) {
          // 首次输出内容时发送 content_block_start
          if (!hasStartedContent) {
            hasStartedContent = true;
            events.push(`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`);
          }
          
          // 转义 JSON 特殊字符
          const escapedContent = delta.content
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\t/g, '\\t');
          
          events.push(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${escapedContent}"}}\n\n`);
        }
        
        // 处理结束
        if (finishReason) {
          if (hasStartedContent) {
            events.push(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`);
          }
          
          const stopReason = finishReason === 'length' ? 'max_tokens' : 'end_turn';
          events.push(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"${stopReason}"},"usage":{"output_tokens":0}}\n\n`);
          events.push(`event: message_stop\ndata: {}\n\n`);
        }
        
        return events.length > 0 ? events.join('') : null;
      } catch (e) {
        this.logger.warn('Stream transform error', { error: e.message });
        return null;
      }
    };
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
