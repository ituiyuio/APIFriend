'use strict';

const { BaseFormatter } = require('./BaseFormatter');

/**
 * OpenAI 格式化器
 * OpenAI 格式是内部标准格式，无需转换
 * 流式响应直接透传
 */
class OpenAIFormatter extends BaseFormatter {
  get format() {
    return 'openai';
  }

  matches(req) {
    // 注意：当 router 挂载在 /v1 下时，req.path 是相对路径（如 /chat/completions）
    // req.originalUrl 是完整路径（如 /v1/chat/completions）
    // 需要同时支持两种情况
    const path = req.originalUrl || req.path || '';
    // 匹配 /v1/chat/completions 或直接 /chat/completions
    return /(\/v1)?\/(chat\/completions|completions|embeddings)/.test(path);
  }

  // OpenAI 是内部标准格式，所有方法继承默认的透传行为
}

module.exports = { OpenAIFormatter };
