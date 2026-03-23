#!/usr/bin/env node
/**
 * APIFriend - API 中转路由服务入口文件
 * 整合所有模块，启动 Express 服务
 */

const express = require('express');
const http = require('http');
const path = require('path');

// 导入模块
const { loadConfig, validateConfig, DEFAULT_CONFIG, watchConfig, reloadConfig } = require('./src/config');
const { RateLimiter, rateLimiter } = require('./src/rateLimiter');
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
  createRequestLogMiddleware,
  createErrorLogMiddleware
} = require('./src/logger');

// 新模块：格式化器 + 统一代理服务
const { FormatterRegistry } = require('./src/formatters/FormatterRegistry');
const { OpenAIFormatter } = require('./src/formatters/OpenAIFormatter');
const { AnthropicFormatter } = require('./src/formatters/AnthropicFormatter');
const { ProxyService } = require('./src/proxy/ProxyService');

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
    this.formatterRegistry = null;
    this.proxyService = null;

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

    // 3. 使用限流器单例
    this.rateLimiter = rateLimiter;
    this.logger.debug('RateLimiter initialized (singleton)');


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

    // 6. 初始化代理核心（仅用于 forward 单次请求）
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

    // 9. 初始化格式化器注册表
    this.formatterRegistry = new FormatterRegistry();
    this.formatterRegistry.register(new OpenAIFormatter());
    this.formatterRegistry.register(new AnthropicFormatter());
    this.logger.info('FormatterRegistry initialized', {
      formats: this.formatterRegistry.getRegisteredFormats()
    });

    // 10. 初始化统一代理服务
    this.proxyService = new ProxyService({
      sourceManager: this.sourceManager,
      formatterRegistry: this.formatterRegistry,
      proxy: this.proxy,
      failoverConfig: this.config.failover,
      logger: this.logger,
      statsRecorder: this.statsRecorder,
      rateLimiter: this.rateLimiter
    });
    this.logger.debug('ProxyService initialized');

    // 11. 初始化状态持久化
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

    // 12. 设置事件监听
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
      this.statePersistence?.save(true);
    });

    this.sourceManager.on('cooldown_exited', ({ source }) => {
      this.logger.info('Source exited cooldown', { source });
    });

    // 监听配置文件变化
    this._onConfigChange = (newConfig) => {
      this.logger.info('Config file changed, reloading sources...');

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
    app.use(express.static(path.join(__dirname, 'public')));

    // 代理路由 - 所有 API 格式统一由 ProxyService 处理
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
   * 所有代理请求统一走 ProxyService，无需为每种格式写单独的处理函数
   */
  _createProxyRouter() {
    const router = express.Router();

    // GET /v1/models - 列出可用模型
    router.get('/models', (req, res) => {
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
      res.json({
        id: req.params.model,
        object: 'model',
        created: Date.now(),
        owned_by: 'apifriend'
      });
    });

    // 所有 POST 代理请求统一由 ProxyService 处理
    // ProxyService 会自动根据请求路径匹配对应的 Formatter
    router.post('/chat/completions', async (req, res) => {
      await this.proxyService.handleRequest(req, res);
    });

    router.post('/completions', async (req, res) => {
      await this.proxyService.handleRequest(req, res);
    });

    router.post('/embeddings', async (req, res) => {
      await this.proxyService.handleRequest(req, res);
    });

    router.post('/messages', async (req, res) => {
      await this.proxyService.handleRequest(req, res);
    });

    return router;
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
