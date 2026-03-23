'use strict';

/**
 * 格式化器注册表
 * 管理所有 API 格式化器，根据请求自动匹配对应的格式化器
 * 
 * 使用方式：
 *   const registry = new FormatterRegistry();
 *   registry.register(new OpenAIFormatter());
 *   registry.register(new AnthropicFormatter());
 *   
 *   const formatter = registry.resolve(req);
 */
class FormatterRegistry {
  constructor() {
    /** @type {Map<string, BaseFormatter>} */
    this._formatters = new Map();
  }

  /**
   * 注册格式化器
   * @param {BaseFormatter} formatter
   */
  register(formatter) {
    if (!formatter.format) {
      throw new Error('Formatter must have a format identifier');
    }
    this._formatters.set(formatter.format, formatter);
  }

  /**
   * 根据格式名获取格式化器
   * @param {string} format - 格式标识符
   * @returns {BaseFormatter|undefined}
   */
  get(format) {
    return this._formatters.get(format);
  }

  /**
   * 根据请求自动匹配格式化器
   * @param {Object} req - Express 请求对象
   * @returns {BaseFormatter|null}
   */
  resolve(req) {
    for (const formatter of this._formatters.values()) {
      if (formatter.matches(req)) {
        return formatter;
      }
    }
    return null;
  }

  /**
   * 获取所有已注册的格式标识符
   * @returns {string[]}
   */
  getRegisteredFormats() {
    return Array.from(this._formatters.keys());
  }
}

module.exports = { FormatterRegistry };
