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
      // 返回常见模型名称供 Claude Code 选择
      const defaultModels = [
        // 实际模型名
        'qwen3.5:35b',
        'qwen3.5:9b',
        'minimax-m2.7',
        'stepfun/step-3.5-flash:free',
        'meta-llama/llama-3-8b-instruct:free',
        'meta-llama/llama-3-70b-instruct:free',
        'llama3-8b-8192',
        'mixtral-8x7b-32768',
        // 常见别名
        'claude-3-5-sonnet-20241022',
        'claude-3-5-haiku-20241022',
        'claude-3-sonnet-20240229',
        'claude-3-haiku-20240307',
        'claude-3-opus-20240229',
        'gpt-4o',
        'gpt-4o-mini',
        'gpt-4-turbo',
        'gpt-3.5-turbo',
        'llama-3-8b',
        'llama-3-70b',
        'qwen-2.5-72b',
        'deepseek-chat',
        'deepseek-coder',
        'mistral-large',
        'mixtral-8x7b'
      ];
      
      const sources = this.sourceManager.getAllSources();
      const customModels = new Set();
      
      sources.forEach(source => {
        if (source.enabled) {
          // 添加实际模型名
          Object.entries(source.modelMapping || {}).forEach(([alias, real]) => {
            if (real) customModels.add(real);
            if (alias !== 'default') {
              customModels.add(alias);
            }
          });
        }
      });
      
      // 合并默认模型和自定义模型
      const allModels = [...new Set([...defaultModels, ...customModels])];
      
      res.json({
        object: 'list',
        data: allModels.map(id => ({
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
    
    return router;
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
