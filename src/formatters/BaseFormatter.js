'use strict';

/**
 * 格式化器基类
 * 定义了请求/响应格式转换的统一接口
 * 
 * 所有上游源统一使用 OpenAI 格式通信。
 * Formatter 负责在客户端格式与 OpenAI 格式之间进行转换。
 * 
 * 扩展新格式只需继承此类并实现相应方法。
 */
class BaseFormatter {
  /**
   * 格式标识符（子类必须实现）
   * @returns {string} 如 'openai', 'anthropic', 'gemini'
   */
  get format() {
    throw new Error('Formatter must implement format getter');
  }

  /**
   * 检测请求是否匹配此格式
   * @param {Object} req - Express 请求对象
   * @returns {boolean}
   */
  matches(req) {
    return false;
  }

  /**
   * 将客户端请求体转换为 OpenAI 格式（发送给上游）
   * @param {Object} body - 原始请求体
   * @returns {Object} OpenAI 格式的请求体
   */
  transformRequest(body) {
    return body;
  }

  /**
   * 获取上游请求所需的额外 headers
   * @param {Object} source - 源配置
   * @param {Object} originalHeaders - 原始请求 headers
   * @returns {Object} 额外 headers
   */
  getUpstreamHeaders(source, originalHeaders) {
    return {};
  }

  /**
   * 将 OpenAI 响应转换为客户端格式（非流式）
   * @param {Object} openaiResponse - OpenAI 格式的响应体
   * @param {string} requestedModel - 客户端请求的模型名
   * @returns {Object} 客户端格式的响应
   */
  transformResponse(openaiResponse, requestedModel) {
    return openaiResponse;
  }

  /**
   * 格式化错误响应
   * @param {string} errorType - 错误类型
   * @param {string} message - 错误消息
   * @param {number} statusCode - HTTP 状态码
   * @returns {Object} 客户端格式的错误响应
   */
  formatError(errorType, message, statusCode) {
    return {
      error: { type: errorType, message }
    };
  }

  /**
   * 处理流式响应
   * @param {Object} res - Express 响应对象
   * @param {Response} upstreamResponse - 上游 fetch Response
   * @param {Object} context - { model, sourceName, startTime, logger, statsRecorder, rateLimiter }
   * @returns {Promise<boolean>} true 表示已处理，false 表示需要透传
   */
  async handleStream(res, upstreamResponse, context) {
    return false;
  }
}

module.exports = { BaseFormatter };
