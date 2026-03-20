/**
 * 流式输出错误处理模块
 * 处理 SSE 流式传输中的错误和中断
 */

/**
 * SSE 事件类型
 */
const SSEEventType = {
  MESSAGE: 'message',
  ERROR: 'error',
  DONE: 'done'
};

/**
 * 流式错误类型
 */
const StreamErrorType = {
  CONNECTION_RESET: 'connection_reset',
  TIMEOUT: 'timeout',
  PARSE_ERROR: 'parse_error',
  UPSTREAM_ERROR: 'upstream_error',
  NETWORK_ERROR: 'network_error',
  UNKNOWN: 'unknown'
};

/**
 * 流式错误类
 */
class StreamError extends Error {
  constructor(type, message, originalError = null) {
    super(message);
    this.name = 'StreamError';
    this.type = type;
    this.originalError = originalError;
    this.timestamp = new Date().toISOString();
  }
}

/**
 * 创建 SSE 格式的错误事件
 * @param {Object} error - 错误信息
 * @param {string} error.message - 错误消息
 * @param {string} error.type - 错误类型
 * @param {string} error.source - 源名称
 * @param {string} error.code - 错误代码
 * @returns {string} SSE 格式的事件字符串
 */
function createSSEErrorEvent(error) {
  const errorData = {
    id: `error-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: error.model || 'unknown',
    choices: [{
      index: 0,
      delta: {},
      finish_reason: 'error'
    }],
    error: {
      message: error.message || 'Stream interrupted',
      type: error.type || 'stream_error',
      code: error.code || 'STREAM_ERROR',
      source: error.source
    }
  };
  
  return `data: ${JSON.stringify(errorData)}\n\n`;
}

/**
 * 创建 SSE [DONE] 事件
 * @returns {string} SSE 格式的完成事件
 */
function createSSEDoneEvent() {
  return 'data: [DONE]\n\n';
}

/**
 * 创建完整的 SSE 错误响应（包含错误事件和完成事件）
 * @param {Object} error - 错误信息
 * @returns {string} 完整的 SSE 响应字符串
 */
function createSSEErrorResponse(error) {
  return createSSEErrorEvent(error) + createSSEDoneEvent();
}

/**
 * 解析 SSE 数据行
 * @param {string} line - SSE 数据行
 * @returns {Object|null} 解析后的数据对象
 */
function parseSSELine(line) {
  if (!line.startsWith('data: ')) {
    return null;
  }
  
  const data = line.slice(6).trim();
  
  if (data === '[DONE]') {
    return { done: true };
  }
  
  try {
    return JSON.parse(data);
  } catch (err) {
    return { parseError: true, raw: data };
  }
}

/**
 * 从错误对象判断流式错误类型
 * @param {Error} error - 错误对象
 * @returns {string} 流式错误类型
 */
function classifyStreamError(error) {
  const message = error.message?.toLowerCase() || '';
  const code = error.code?.toLowerCase() || '';
  
  // 连接重置
  if (
    message.includes('connection reset') ||
    message.includes('connection aborted') ||
    code === 'econnreset' ||
    code === 'econnaborted'
  ) {
    return StreamErrorType.CONNECTION_RESET;
  }
  
  // 超时
  if (
    message.includes('timeout') ||
    message.includes('timed out') ||
    code === 'etimedout' ||
    code === 'econnrefused'
  ) {
    return StreamErrorType.TIMEOUT;
  }
  
  // 网络错误
  if (
    message.includes('network') ||
    message.includes('enotfound') ||
    message.includes('eai_again') ||
    code === 'enotfound'
  ) {
    return StreamErrorType.NETWORK_ERROR;
  }
  
  // 解析错误
  if (
    message.includes('parse') ||
    message.includes('json') ||
    message.includes('syntax') ||
    error instanceof SyntaxError
  ) {
    return StreamErrorType.PARSE_ERROR;
  }
  
  // 上游错误
  if (
    message.includes('upstream') ||
    message.includes('502') ||
    message.includes('503') ||
    message.includes('504')
  ) {
    return StreamErrorType.UPSTREAM_ERROR;
  }
  
  return StreamErrorType.UNKNOWN;
}

/**
 * 流式错误处理器
 */
class StreamErrorHandler {
  /**
   * @param {Object} options - 配置选项
   * @param {Function} options.onLog - 日志回调
   */
  constructor(options = {}) {
    this.onLog = options.onLog || console.log;
    this.errorCounts = new Map(); // source -> count
    this.lastErrors = new Map(); // source -> last error
  }
  
  /**
   * 处理流式错误
   * @param {Error} error - 错误对象
   * @param {Object} context - 上下文信息
   * @param {string} context.source - 源名称
   * @param {http.ServerResponse} context.response - 客户端响应对象
   * @param {number} context.bytesTransferred - 已传输字节数
   * @param {number} context.chunksReceived - 已接收的块数
   * @param {string} context.model - 请求的模型
   * @returns {Object} 处理结果
   */
  handleError(error, context = {}) {
    const { source, response, bytesTransferred = 0, chunksReceived = 0, model } = context;
    
    // 分类错误
    const errorType = classifyStreamError(error);
    
    // 更新统计
    this._updateStats(source, error, errorType);
    
    // 记录日志
    this._logError(error, errorType, context);
    
    // 构建错误响应
    const sseError = {
      message: `APIFriend: Stream interrupted - ${error.message}`,
      type: errorType,
      source: source,
      code: this._getErrorCode(errorType)
    };
    
    if (model) {
      sseError.model = model;
    }
    
    // 如果响应对象可用且未结束，发送错误事件
    let injected = false;
    if (response && !response.writableEnded) {
      try {
        const errorResponse = createSSEErrorResponse(sseError);
        response.write(errorResponse);
        response.end();
        injected = true;
      } catch (writeError) {
        // 无法写入，可能是连接已断开
        this.onLog('warn', `Failed to inject SSE error: ${writeError.message}`);
      }
    }
    
    return {
      errorType,
      injected,
      bytesTransferred,
      chunksReceived,
      streamError: new StreamError(errorType, error.message, error)
    };
  }
  
  /**
   * 更新错误统计
   */
  _updateStats(source, error, errorType) {
    if (!source) return;
    
    // 增加错误计数
    const count = this.errorCounts.get(source) || 0;
    this.errorCounts.set(source, count + 1);
    
    // 记录最后的错误
    this.lastErrors.set(source, {
      type: errorType,
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
  
  /**
   * 记录错误日志
   */
  _logError(error, errorType, context) {
    const logData = {
      event: 'stream_error',
      type: errorType,
      message: error.message,
      source: context.source,
      bytesTransferred: context.bytesTransferred,
      chunksReceived: context.chunksReceived,
      timestamp: new Date().toISOString()
    };
    
    this.onLog('error', 'Stream error occurred', logData);
  }
  
  /**
   * 获取错误代码
   */
  _getErrorCode(errorType) {
    const codes = {
      [StreamErrorType.CONNECTION_RESET]: 'ECONNRESET',
      [StreamErrorType.TIMEOUT]: 'ETIMEDOUT',
      [StreamErrorType.NETWORK_ERROR]: 'ENETWORK',
      [StreamErrorType.PARSE_ERROR]: 'EPARSE',
      [StreamErrorType.UPSTREAM_ERROR]: 'EUPSTREAM',
      [StreamErrorType.UNKNOWN]: 'EUNKNOWN'
    };
    return codes[errorType] || 'EUNKNOWN';
  }
  
  /**
   * 获取源的错误统计
   * @param {string} source - 源名称
   * @returns {Object} 统计数据
   */
  getStats(source) {
    return {
      errorCount: this.errorCounts.get(source) || 0,
      lastError: this.lastErrors.get(source) || null
    };
  }
  
  /**
   * 重置源的统计
   * @param {string} source - 源名称
   */
  resetStats(source) {
    this.errorCounts.delete(source);
    this.lastErrors.delete(source);
  }
  
  /**
   * 导出状态
   */
  exportState() {
    return {
      errorCounts: Object.fromEntries(this.errorCounts),
      lastErrors: Object.fromEntries(this.lastErrors)
    };
  }
  
  /**
   * 导入状态
   */
  importState(state) {
    if (state.errorCounts) {
      this.errorCounts = new Map(Object.entries(state.errorCounts));
    }
    if (state.lastErrors) {
      this.lastErrors = new Map(Object.entries(state.lastErrors));
    }
  }
}

module.exports = {
  StreamError,
  StreamErrorType,
  SSEEventType,
  StreamErrorHandler,
  createSSEErrorEvent,
  createSSEDoneEvent,
  createSSEErrorResponse,
  parseSSELine,
  classifyStreamError
};
