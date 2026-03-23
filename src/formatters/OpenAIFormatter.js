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
    // OpenAI 格式：/v1/chat/completions, /v1/completions, /v1/embeddings
    const path = req.path || req.originalUrl || '';
    return /\/v1\/(chat\/completions|completions|embeddings)/.test(path);
  }

  // OpenAI 是内部标准格式，所有方法继承默认的透传行为
}

module.exports = { OpenAIFormatter };
