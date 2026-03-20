/**
 * 日志系统模块
 * 提供分级日志、文件写入和日志轮转功能
 */

const fs = require('fs');
const path = require('path');

/**
 * 日志级别
 */
const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 100 // 禁用所有日志
};

/**
 * 日志级别名称映射
 */
const LogLevelNames = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR'
};

/**
 * 日志颜色（终端）
 */
const LogColors = {
  [LogLevel.DEBUG]: '\x1b[36m', // 青色
  [LogLevel.INFO]: '\x1b[32m',  // 绿色
  [LogLevel.WARN]: '\x1b[33m',  // 黄色
  [LogLevel.ERROR]: '\x1b[31m', // 红色
  reset: '\x1b[0m'
};

/**
 * 日志器类
 */
class Logger {
  /**
   * @param {Object} options - 配置选项
   * @param {string} options.name - 日志器名称
   * @param {number} options.level - 最低日志级别
   * @param {boolean} options.console - 是否输出到控制台
   * @param {string} options.file - 日志文件路径
   * @param {boolean} options.colorize - 是否着色
   * @param {string} options.format - 日志格式
   * @param {Object} options.rotation - 日志轮转配置
   */
  constructor(options = {}) {
    this.name = options.name || 'APIFriend';
    this.level = options.level ?? LogLevel.INFO;
    this.console = options.console !== false;
    this.file = options.file || null;
    this.colorize = options.colorize !== false;
    this.format = options.format || 'json';
    
    // 日志轮转
    this.rotation = {
      maxSize: options.rotation?.maxSize || 10 * 1024 * 1024, // 10MB
      maxFiles: options.rotation?.maxFiles || 5,
      ...options.rotation
    };
    
    // 统计
    this.stats = {
      [LogLevel.DEBUG]: 0,
      [LogLevel.INFO]: 0,
      [LogLevel.WARN]: 0,
      [LogLevel.ERROR]: 0
    };
    
    // 文件写入流
    this.fileStream = null;
    
    if (this.file) {
      this._initFileStream();
    }
  }
  
  /**
   * 初始化文件写入流
   */
  _initFileStream() {
    try {
      const dir = path.dirname(this.file);
      if (dir !== '.' && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      this.fileStream = fs.createWriteStream(this.file, {
        flags: 'a',
        encoding: 'utf8'
      });
      
      this.fileStream.on('error', (err) => {
        console.error(`Log file error: ${err.message}`);
      });
    } catch (err) {
      console.error(`Failed to init log file: ${err.message}`);
      this.fileStream = null;
    }
  }
  
  /**
   * 检查日志轮转
   */
  _checkRotation() {
    if (!this.file || !this.fileStream) return;
    
    try {
      const stats = fs.statSync(this.file);
      if (stats.size >= this.rotation.maxSize) {
        this._rotateLog();
      }
    } catch (err) {
      // 文件可能不存在，忽略
    }
  }
  
  /**
   * 执行日志轮转
   */
  _rotateLog() {
    // 关闭当前流
    if (this.fileStream) {
      this.fileStream.end();
      this.fileStream = null;
    }
    
    // 重命名现有文件
    const ext = path.extname(this.file);
    const base = this.file.slice(0, -ext.length);
    
    // 删除最老的文件
    const oldestFile = `${base}.${this.rotation.maxFiles}${ext}`;
    if (fs.existsSync(oldestFile)) {
      fs.unlinkSync(oldestFile);
    }
    
    // 轮转现有文件
    for (let i = this.rotation.maxFiles - 1; i >= 1; i--) {
      const oldFile = `${base}.${i}${ext}`;
      const newFile = `${base}.${i + 1}${ext}`;
      if (fs.existsSync(oldFile)) {
        fs.renameSync(oldFile, newFile);
      }
    }
    
    // 重命名当前文件为 .1
    if (fs.existsSync(this.file)) {
      fs.renameSync(this.file, `${base}.1${ext}`);
    }
    
    // 重新初始化流
    this._initFileStream();
  }
  
  /**
   * 格式化日志条目
   * @param {number} level - 日志级别
   * @param {string} message - 消息
   * @param {Object} data - 附加数据
   * @returns {string} 格式化后的日志
   */
  _format(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const levelName = LogLevelNames[level] || 'UNKNOWN';
    
    if (this.format === 'json') {
      const entry = {
        timestamp,
        level: levelName,
        logger: this.name,
        message
      };
      
      if (data !== null && data !== undefined) {
        entry.data = data;
      }
      
      return JSON.stringify(entry);
    } else {
      // 简单文本格式
      let entry = `[${timestamp}] [${levelName}] [${this.name}] ${message}`;
      if (data !== null && data !== undefined) {
        entry += ` ${typeof data === 'object' ? JSON.stringify(data) : data}`;
      }
      return entry;
    }
  }
  
  /**
   * 写入日志
   * @param {number} level - 日志级别
   * @param {string} message - 消息
   * @param {Object} data - 附加数据
   */
  _log(level, message, data = null) {
    // 检查级别
    if (level < this.level) return;
    
    // 更新统计
    this.stats[level]++;
    
    // 格式化
    const formatted = this._format(level, message, data);
    
    // 控制台输出
    if (this.console) {
      const color = this.colorize ? LogColors[level] : '';
      const reset = this.colorize ? LogColors.reset : '';
      console.log(`${color}${formatted}${reset}`);
    }
    
    // 文件输出
    if (this.fileStream) {
      this._checkRotation();
      this.fileStream.write(formatted + '\n');
    }
  }
  
  /**
   * Debug 级别日志
   */
  debug(message, data = null) {
    this._log(LogLevel.DEBUG, message, data);
  }
  
  /**
   * Info 级别日志
   */
  info(message, data = null) {
    this._log(LogLevel.INFO, message, data);
  }
  
  /**
   * Warn 级别日志
   */
  warn(message, data = null) {
    this._log(LogLevel.WARN, message, data);
  }
  
  /**
   * Error 级别日志
   */
  error(message, data = null) {
    this._log(LogLevel.ERROR, message, data);
  }
  
  /**
   * 获取统计信息
   */
  getStats() {
    return {
      name: this.name,
      level: this.level,
      levelName: LogLevelNames[this.level],
      counts: { ...this.stats },
      total: Object.values(this.stats).reduce((a, b) => a + b, 0),
      file: this.file,
      console: this.console
    };
  }
  
  /**
   * 设置日志级别
   */
  setLevel(level) {
    this.level = level;
  }
  
  /**
   * 关闭日志器
   */
  close() {
    if (this.fileStream) {
      this.fileStream.end();
      this.fileStream = null;
    }
  }
}

/**
 * 创建默认日志器
 */
let defaultLogger = null;

/**
 * 获取默认日志器
 * @param {Object} options - 配置选项
 * @returns {Logger}
 */
function getLogger(options = {}) {
  if (!defaultLogger) {
    defaultLogger = new Logger({
      name: 'APIFriend',
      level: LogLevel.INFO,
      console: true,
      ...options
    });
  }
  return defaultLogger;
}

/**
 * 创建子日志器
 * @param {string} name - 子日志器名称
 * @param {Object} options - 配置选项
 * @returns {Logger}
 */
function createChildLogger(name, options = {}) {
  return new Logger({
    name,
    level: options.level ?? defaultLogger?.level ?? LogLevel.INFO,
    console: options.console ?? defaultLogger?.console ?? true,
    file: options.file ?? defaultLogger?.file,
    colorize: options.colorize ?? defaultLogger?.colorize ?? true,
    format: options.format ?? defaultLogger?.format ?? 'json',
    ...options
  });
}

/**
 * 创建请求日志中间件
 * @param {Logger} logger - 日志器实例
 * @returns {Function} Express 中间件
 */
function createRequestLogMiddleware(logger = null) {
  const log = logger || getLogger();
  
  return function requestLogMiddleware(req, res, next) {
    const startTime = Date.now();
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    
    // 请求开始
    log.info(`Request started`, {
      requestId,
      method: req.method,
      path: req.path,
      query: req.query,
      ip: req.ip || req.connection?.remoteAddress
    });
    
    // 响应结束
    const originalEnd = res.end;
    res.end = function(...args) {
      const duration = Date.now() - startTime;
      
      log.info(`Request completed`, {
        requestId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration: `${duration}ms`
      });
      
      return originalEnd.apply(this, args);
    };
    
    next();
  };
}

/**
 * 创建错误日志中间件
 * @param {Logger} logger - 日志器实例
 * @returns {Function} Express 错误处理中间件
 */
function createErrorLogMiddleware(logger = null) {
  const log = logger || getLogger();
  
  return function errorLogMiddleware(err, req, res, next) {
    log.error(`Request error`, {
      method: req.method,
      path: req.path,
      error: err.message,
      stack: err.stack
    });
    
    next(err);
  };
}

module.exports = {
  Logger,
  LogLevel,
  LogLevelNames,
  LogColors,
  getLogger,
  createChildLogger,
  createRequestLogMiddleware,
  createErrorLogMiddleware
};
