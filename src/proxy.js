/**
 * 代理核心模块
 * 处理请求转发、响应透传、流式输出
 */

const http = require('http');
const https = require('https');

/**
 * 带超时的 fetch 请求
 * @param {string} url - 请求 URL
 * @param {Object} options - 请求选项
 * @param {number} timeoutMs - 超时时间（毫秒）
 * @returns {Promise<Object>} { success, response, error }
 */
async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeout);
    return { success: true, response };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return {
        success: false,
        error: 'timeout',
        message: `Request timed out after ${timeoutMs}ms`
      };
    }
    return {
      success: false,
      error: err.name || 'unknown',
      message: err.message
    };
  }
}

/**
 * 构建请求头
 * @param {Object} source - 源配置
 * @param {Object} originalHeaders - 原始请求头
 * @returns {Object} 转换后的请求头
 */
function buildHeaders(source, originalHeaders = {}) {
  const headers = {};
  
  // 复制必要的原始头
  const keepHeaders = ['content-type', 'accept'];
  for (const key of keepHeaders) {
    if (originalHeaders[key]) {
      headers[key] = originalHeaders[key];
    }
  }
  
  // 设置认证头（OpenAI 兼容格式）
  headers['Authorization'] = `Bearer ${source.apiKey}`;
  
  // OpenRouter 特定头
  if (source.baseUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://apifriend.local';
    headers['X-Title'] = 'APIFriend';
  }
  
  return headers;
}

/**
 * 构建请求 URL
 * @param {Object} source - 源配置
 * @param {string} path - 请求路径
 * @returns {string} 完整 URL
 */
function buildUrl(source, path) {
  const baseUrl = source.baseUrl.replace(/\/$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${baseUrl}${normalizedPath}`;
}

/**
 * 检查是否为流式请求
 * @param {Object} body - 请求体
 * @returns {boolean}
 */
function isStreamRequest(body) {
  return body && body.stream === true;
}

/**
 * 检查响应是否为流式
 * @param {Response} response - fetch Response
 * @returns {boolean}
 */
function isStreamResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  return contentType.includes('text/event-stream');
}

/**
 * 检查响应是否为错误
 * @param {Response} response - fetch Response
 * @returns {boolean}
 */
function isErrorResponse(response) {
  return response.status >= 400;
}

/**
 * 获取错误类型
 * @param {Response} response - fetch Response
 * @returns {string} 错误类型
 */
function getErrorType(response) {
  if (response.status === 429) return 'rate_limit';
  if (response.status >= 500) return 'server_error';
  if (response.status === 401 || response.status === 403) return 'auth_error';
  return 'client_error';
}

/**
 * 代理请求类
 */
class Proxy {
  /**
   * @param {Object} config - 配置对象
   * @param {Object} config.failover - 故障切换配置
   */
  constructor(config = {}) {
    this.failoverConfig = config.failover || {
      timeoutMs: 15000,
      maxRetries: 3,
      retryDelayMs: 1000
    };
  }

  /**
   * 转发请求到上游源
   * @param {Object} source - 源配置
   * @param {string} path - 请求路径
   * @param {string} method - HTTP 方法
   * @param {Object} body - 请求体
   * @param {Object} headers - 请求头
   * @returns {Promise<Object>} { success, response, error, errorType }
   */
  async forward(source, path, method = 'POST', body = null, headers = {}) {
    const url = buildUrl(source, path);
    const requestHeaders = buildHeaders(source, headers);
    
    const options = {
      method,
      headers: requestHeaders
    };
    
    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }
    
    const result = await fetchWithTimeout(url, options, this.failoverConfig.timeoutMs);
    
    if (!result.success) {
      return {
        success: false,
        error: result.error,
        message: result.message,
        errorType: result.error === 'timeout' ? 'timeout' : 'network_error'
      };
    }
    
    const response = result.response;
    
    if (isErrorResponse(response)) {
      let errorBody;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = { message: await response.text() };
      }
      
      return {
        success: false,
        response,
        error: errorBody,
        errorType: getErrorType(response),
        statusCode: response.status
      };
    }
    
    return {
      success: true,
      response,
      isStream: isStreamResponse(response)
    };
  }

  /**
   * 透传响应给客户端（非流式）
   * @param {Response} upstreamResponse - 上游响应
   * @param {http.ServerResponse} clientResponse - 客户端响应对象
   */
  async pipeResponse(upstreamResponse, clientResponse) {
    const contentType = upstreamResponse.headers.get('content-type') || 'application/json';
    
    // 设置响应头
    clientResponse.setHeader('Content-Type', contentType);
    clientResponse.setHeader('X-Proxy', 'APIFriend');
    
    // 读取并返回响应体
    const body = await upstreamResponse.text();
    clientResponse.end(body);
    
    return body;
  }

  /**
   * 透传流式响应给客户端
   * @param {Response} upstreamResponse - 上游响应
   * @param {http.ServerResponse} clientResponse - 客户端响应对象
   * @param {Object} options - 选项
   * @param {Function} options.onComplete - 完成回调，接收完整响应文本
   * @param {Function} options.onError - 错误回调
   * @returns {Promise<void>}
   */
  async pipeStreamResponse(upstreamResponse, clientResponse, options = {}) {
    const { onComplete, onError } = options;
    
    // 设置 SSE 响应头
    clientResponse.setHeader('Content-Type', 'text/event-stream');
    clientResponse.setHeader('Cache-Control', 'no-cache');
    clientResponse.setHeader('Connection', 'keep-alive');
    clientResponse.setHeader('X-Proxy', 'APIFriend');
    
    let fullText = '';
    
    return new Promise((resolve, reject) => {
      const reader = upstreamResponse.body.getReader();
      const decoder = new TextDecoder();
      
      const pump = async () => {
        try {
          const { done, value } = await reader.read();
          
          if (done) {
            clientResponse.end();
            if (onComplete) onComplete(fullText);
            resolve();
            return;
          }
          
          const chunk = decoder.decode(value, { stream: true });
          fullText += chunk;
          
          // 写入客户端
          if (!clientResponse.writableEnded) {
            clientResponse.write(chunk);
          }
          
          // 继续读取
          pump();
        } catch (err) {
          // 流式中断
          if (!clientResponse.headersSent) {
            // 还没发送头，可以返回错误
            clientResponse.status(500).json({ error: { message: err.message } });
          } else if (!clientResponse.writableEnded) {
            // 已经发送头，注入 SSE 错误事件
            const errorEvent = `data: ${JSON.stringify({
              error: { message: `APIFriend: Upstream stream interrupted: ${err.message}` }
            })}\n\n`;
            clientResponse.write(errorEvent);
            clientResponse.write('data: [DONE]\n\n');
            clientResponse.end();
          }
          
          if (onError) onError(err);
          reject(err);
        }
      };
      
      pump();
    });
  }

  /**
   * 处理代理请求（包含重试逻辑）
   * @param {Object} sourceManager - 源管理器实例
   * @param {string} path - 请求路径
   * @param {string} method - HTTP 方法
   * @param {Object} body - 请求体
   * @param {Object} headers - 请求头
   * @param {http.ServerResponse} clientResponse - 客户端响应对象
   * @returns {Promise<Object>} { success, source, error }
   */
  async handleRequest(sourceManager, path, method = 'POST', body = null, headers = {}, clientResponse = null) {
    const maxRetries = this.failoverConfig.maxRetries || 3;
    const retryDelayMs = this.failoverConfig.retryDelayMs || 1000;
    const requestedModel = body?.model;
    
    let currentSource = null;
    let retryCount = 0;
    
    while (retryCount < maxRetries) {
      // 选择源
      if (!currentSource) {
        const selected = sourceManager.selectSource(requestedModel);
        if (!selected) {
          return {
            success: false,
            error: 'no_available_source',
            message: 'No available source found'
          };
        }
        currentSource = selected;
      }
      
      // 构建请求体（应用模型映射）
      const requestBody = body ? {
        ...body,
        model: currentSource.mappedModel || body.model
      } : null;
      
      // 转发请求
      const result = await this.forward(
        currentSource.source,
        path,
        method,
        requestBody,
        headers
      );
      
      if (result.success) {
        // 成功
        sourceManager.markSuccess(currentSource.source.name);
        
        // 如果提供了客户端响应对象，透传响应
        if (clientResponse && result.response) {
          if (result.isStream) {
            await this.pipeStreamResponse(result.response, clientResponse);
          } else {
            await this.pipeResponse(result.response, clientResponse);
          }
        }
        
        return {
          success: true,
          source: currentSource.source,
          response: result.response,
          isStream: result.isStream
        };
      }
      
      // 失败，标记并尝试切换源
      sourceManager.markFailure(currentSource.source.name, result.errorType);
      
      // 检查是否应该重试
      if (result.errorType === 'auth_error') {
        // 认证错误不重试
        return {
          success: false,
          error: result.error,
          errorType: result.errorType,
          source: currentSource.source
        };
      }
      
      // 选择下一个源
      const nextSource = sourceManager.selectNextSource(currentSource.source.name, requestedModel);
      
      if (!nextSource) {
        // 没有可用源了
        return {
          success: false,
          error: 'all_sources_failed',
          message: 'All sources are unavailable',
          lastError: result.error
        };
      }
      
      // 切换到下一个源
      currentSource = nextSource;
      retryCount++;
      
      // 延迟重试
      if (retryDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
    
    return {
      success: false,
      error: 'max_retries_exceeded',
      message: `Failed after ${maxRetries} retries`
    };
  }
}

module.exports = {
  Proxy,
  fetchWithTimeout,
  buildHeaders,
  buildUrl,
  isStreamRequest,
  isStreamResponse,
  isErrorResponse,
  getErrorType
};
