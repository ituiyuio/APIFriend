/**
 * 故障检测器模块
 * 提供更详细的错误检测、分析和统计功能
 */

const EventEmitter = require('events');

// 错误类型枚举
const ErrorType = {
  RATE_LIMIT: 'rate_limit',           // 429 - 限流
  SERVER_ERROR: 'server_error',       // 5xx - 服务器错误
  AUTH_ERROR: 'auth_error',           // 401/403 - 认证错误
  CLIENT_ERROR: 'client_error',       // 4xx - 客户端错误
  TIMEOUT: 'timeout',                 // 超时
  NETWORK_ERROR: 'network_error',     // 网络错误
  STREAM_ERROR: 'stream_error',       // 流式传输错误
  UNKNOWN: 'unknown'                  // 未知错误
};

// 错误严重级别
const ErrorSeverity = {
  LOW: 'low',           // 可恢复，继续使用
  MEDIUM: 'medium',     // 需要切换源
  HIGH: 'high',         // 需要冷却
  CRITICAL: 'critical'  // 需要禁用
};

// HTTP 状态码到错误类型的映射
const STATUS_TO_ERROR_TYPE = {
  429: ErrorType.RATE_LIMIT,
  500: ErrorType.SERVER_ERROR,
  502: ErrorType.SERVER_ERROR,
  503: ErrorType.SERVER_ERROR,
  504: ErrorType.SERVER_ERROR,
  401: ErrorType.AUTH_ERROR,
  403: ErrorType.AUTH_ERROR,
  400: ErrorType.CLIENT_ERROR,
  404: ErrorType.CLIENT_ERROR,
  422: ErrorType.CLIENT_ERROR
};

// 错误类型到严重级别的映射
const ERROR_TYPE_TO_SEVERITY = {
  [ErrorType.RATE_LIMIT]: ErrorSeverity.MEDIUM,
  [ErrorType.SERVER_ERROR]: ErrorSeverity.MEDIUM,
  [ErrorType.AUTH_ERROR]: ErrorSeverity.HIGH,
  [ErrorType.CLIENT_ERROR]: ErrorSeverity.LOW,
  [ErrorType.TIMEOUT]: ErrorSeverity.MEDIUM,
  [ErrorType.NETWORK_ERROR]: ErrorSeverity.MEDIUM,
  [ErrorType.STREAM_ERROR]: ErrorSeverity.LOW,
  [ErrorType.UNKNOWN]: ErrorSeverity.MEDIUM
};

class FailoverDetector extends EventEmitter {
  /**
   * @param {Object} config - 配置对象
   * @param {Object} config.failover - 故障切换配置
   */
  constructor(config = {}) {
    super();
    
    this.config = config.failover || {
      timeoutMs: 15000,
      maxRetries: 3,
      retryDelayMs: 1000,
      cooldownMinutes: 5,
      failureThreshold: 3
    };
    
    // 错误统计
    this.errorStats = new Map();  // sourceName -> ErrorStats
  }

  /**
   * 根据 HTTP 状态码获取错误类型
   * @param {number} statusCode - HTTP 状态码
   * @returns {string} 错误类型
   */
  getErrorTypeFromStatus(statusCode) {
    return STATUS_TO_ERROR_TYPE[statusCode] || ErrorType.UNKNOWN;
  }

  /**
   * 获取错误的严重级别
   * @param {string} errorType - 错误类型
   * @returns {string} 严重级别
   */
  getErrorSeverity(errorType) {
    return ERROR_TYPE_TO_SEVERITY[errorType] || ErrorSeverity.MEDIUM;
  }

  /**
   * 分析错误
   * @param {Object} error - 错误对象
   * @param {number} statusCode - HTTP 状态码（可选）
   * @returns {Object} 分析结果 { type, severity, shouldRetry, shouldCool, shouldDisable }
   */
  analyzeError(error, statusCode = null) {
    let errorType;
    
    if (statusCode) {
      errorType = this.getErrorTypeFromStatus(statusCode);
    } else if (error.error === 'timeout' || error.name === 'AbortError') {
      errorType = ErrorType.TIMEOUT;
    } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      errorType = ErrorType.NETWORK_ERROR;
    } else if (error.errorType) {
      errorType = error.errorType;
    } else {
      errorType = ErrorType.UNKNOWN;
    }
    
    const severity = this.getErrorSeverity(errorType);
    
    return {
      type: errorType,
      severity,
      shouldRetry: severity !== ErrorSeverity.CRITICAL && errorType !== ErrorType.AUTH_ERROR,
      shouldCool: severity === ErrorSeverity.HIGH || severity === ErrorSeverity.CRITICAL,
      shouldDisable: severity === ErrorSeverity.CRITICAL
    };
  }

  /**
   * 记录错误
   * @param {string} sourceName - 源名称
   * @param {Object} errorInfo - 错误信息
   */
  recordError(sourceName, errorInfo) {
    if (!this.errorStats.has(sourceName)) {
      this.errorStats.set(sourceName, this.createEmptyStats());
    }
    
    const stats = this.errorStats.get(sourceName);
    stats.totalErrors++;
    stats.lastError = {
      ...errorInfo,
      timestamp: new Date().toISOString()
    };
    
    // 按类型统计
    const errorType = errorInfo.type || ErrorType.UNKNOWN;
    stats.byType[errorType] = (stats.byType[errorType] || 0) + 1;
    
    // 按严重级别统计
    const severity = errorInfo.severity || ErrorSeverity.MEDIUM;
    stats.bySeverity[severity] = (stats.bySeverity[severity] || 0) + 1;
    
    this.emit('error_recorded', { sourceName, errorInfo, stats });
  }

  /**
   * 记录成功
   * @param {string} sourceName - 源名称
   */
  recordSuccess(sourceName) {
    if (!this.errorStats.has(sourceName)) {
      this.errorStats.set(sourceName, this.createEmptyStats());
    }
    
    const stats = this.errorStats.get(sourceName);
    stats.totalSuccess++;
    stats.lastSuccess = new Date().toISOString();
  }

  /**
   * 创建空统计对象
   * @returns {Object} 统计对象
   */
  createEmptyStats() {
    return {
      totalErrors: 0,
      totalSuccess: 0,
      lastError: null,
      lastSuccess: null,
      byType: {},
      bySeverity: {}
    };
  }

  /**
   * 获取源的统计信息
   * @param {string} sourceName - 源名称
   * @returns {Object|null} 统计信息
   */
  getStats(sourceName) {
    return this.errorStats.get(sourceName) || null;
  }

  /**
   * 获取所有统计信息
   * @returns {Object} 统计信息映射
   */
  getAllStats() {
    const result = {};
    for (const [name, stats] of this.errorStats) {
      result[name] = { ...stats };
    }
    return result;
  }

  /**
   * 计算错误率
   * @param {string} sourceName - 源名称
   * @returns {number} 错误率 (0-1)
   */
  getErrorRate(sourceName) {
    const stats = this.errorStats.get(sourceName);
    if (!stats || stats.totalErrors + stats.totalSuccess === 0) {
      return 0;
    }
    return stats.totalErrors / (stats.totalErrors + stats.totalSuccess);
  }

  /**
   * 判断源是否健康
   * @param {string} sourceName - 源名称
   * @param {number} threshold - 错误率阈值 (0-1)
   * @returns {boolean} 是否健康
   */
  isHealthy(sourceName, threshold = 0.5) {
    const errorRate = this.getErrorRate(sourceName);
    const stats = this.errorStats.get(sourceName);
    
    // 请求数太少时不判断
    if (!stats || stats.totalErrors + stats.totalSuccess < 5) {
      return true;
    }
    
    return errorRate < threshold;
  }

  /**
   * 获取建议的切换策略
   * @param {string} sourceName - 源名称
   * @param {Object} analysis - 错误分析结果
   * @returns {Object} 策略建议
   */
  getStrategy(sourceName, analysis) {
    const strategies = [];
    
    if (analysis.shouldDisable) {
      strategies.push({
        action: 'disable',
        reason: 'Critical error detected',
        immediate: true
      });
    } else if (analysis.shouldCool) {
      strategies.push({
        action: 'cooldown',
        reason: 'High severity error detected',
        duration: this.config.cooldownMinutes * 60 * 1000,
        immediate: true
      });
    } else if (analysis.shouldRetry) {
      strategies.push({
        action: 'retry',
        reason: 'Transient error, retry with different source',
        immediate: false
      });
    }
    
    // 检查错误率
    const errorRate = this.getErrorRate(sourceName);
    if (errorRate > 0.3 && strategies.length === 0) {
      strategies.push({
        action: 'cooldown',
        reason: `High error rate: ${(errorRate * 100).toFixed(1)}%`,
        duration: this.config.cooldownMinutes * 60 * 1000,
        immediate: false
      });
    }
    
    return {
      sourceName,
      analysis,
      strategies,
      recommendedAction: strategies[0]?.action || 'continue'
    };
  }

  /**
   * 重置统计
   * @param {string} sourceName - 源名称（可选，不提供则重置所有）
   */
  resetStats(sourceName = null) {
    if (sourceName) {
      this.errorStats.delete(sourceName);
    } else {
      this.errorStats.clear();
    }
  }

  /**
   * 导出状态
   * @returns {Object} 状态数据
   */
  exportState() {
    const data = {};
    for (const [name, stats] of this.errorStats) {
      data[name] = { ...stats };
    }
    return data;
  }

  /**
   * 导入状态
   * @param {Object} data - 状态数据
   */
  importState(data) {
    for (const [name, stats] of Object.entries(data)) {
      this.errorStats.set(name, { ...stats });
    }
  }
}

module.exports = {
  FailoverDetector,
  ErrorType,
  ErrorSeverity,
  STATUS_TO_ERROR_TYPE,
  ERROR_TYPE_TO_SEVERITY
};
