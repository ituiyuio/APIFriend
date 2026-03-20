/**
 * 限流器模块
 * 追踪每个 API 源的请求和 Token 使用量
 */

class RateLimiter {
  constructor() {
    // 源状态映射: sourceName -> SourceRateState
    this.states = new Map();
  }

  /**
   * 获取或创建源状态
   * @param {string} sourceName - 源名称
   * @returns {Object} 源状态
   */
  getState(sourceName) {
    if (!this.states.has(sourceName)) {
      this.states.set(sourceName, this.createInitialState());
    }
    return this.states.get(sourceName);
  }

  /**
   * 创建初始状态
   * @returns {Object} 初始状态
   */
  createInitialState() {
    const now = Date.now();
    return {
      requests: {
        minuteCount: 0,
        dayCount: 0,
        minuteReset: this.getNextMinuteReset(now),
        dayReset: this.getNextDayReset(now)
      },
      tokens: {
        minuteCount: 0,
        dayCount: 0,
        minuteReset: this.getNextMinuteReset(now),
        dayReset: this.getNextDayReset(now)
      }
    };
  }

  /**
   * 获取下一分钟重置时间戳
   * @param {number} now - 当前时间戳
   * @returns {number} 下一分钟开始的时间戳
   */
  getNextMinuteReset(now) {
    const date = new Date(now);
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours(),
      date.getMinutes() + 1,
      0, 0
    ).getTime();
  }

  /**
   * 获取下一天重置时间戳
   * @param {number} now - 当前时间戳
   * @returns {number} 下一天 00:00:00 的时间戳
   */
  getNextDayReset(now) {
    const date = new Date(now);
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() + 1,
      0, 0, 0, 0
    ).getTime();
  }

  /**
   * 检查并重置过期的计数器
   * @param {Object} state - 源状态
   * @param {number} now - 当前时间戳
   */
  resetIfNeeded(state, now) {
    // 重置分钟计数器
    if (now >= state.requests.minuteReset) {
      state.requests.minuteCount = 0;
      state.tokens.minuteCount = 0;
      state.requests.minuteReset = this.getNextMinuteReset(now);
      state.tokens.minuteReset = this.getNextMinuteReset(now);
    }

    // 重置天计数器
    if (now >= state.requests.dayReset) {
      state.requests.dayCount = 0;
      state.tokens.dayCount = 0;
      state.requests.dayReset = this.getNextDayReset(now);
      state.tokens.dayReset = this.getNextDayReset(now);
    }
  }

  /**
   * 检查是否允许请求（同步操作，确保原子性）
   * @param {string} sourceName - 源名称
   * @param {Object} limits - 限流配置
   * @param {number} limits.requestsPerMinute - 每分钟请求限制
   * @param {number} limits.tokensPerMinute - 每分钟 Token 限制
   * @param {number} limits.requestsPerDay - 每天请求限制
   * @param {number} limits.tokensPerDay - 每天 Token 限制
   * @returns {Object} { allowed: boolean, reason?: string }
   */
  checkAndIncrement(sourceName, limits) {
    const now = Date.now();
    const state = this.getState(sourceName);

    // 重置过期计数器
    this.resetIfNeeded(state, now);

    // 检查请求限制
    if (limits.requestsPerMinute && state.requests.minuteCount >= limits.requestsPerMinute) {
      return { allowed: false, reason: 'requests_per_minute_limit' };
    }
    if (limits.requestsPerDay && state.requests.dayCount >= limits.requestsPerDay) {
      return { allowed: false, reason: 'requests_per_day_limit' };
    }

    // 检查 Token 限制
    if (limits.tokensPerMinute && state.tokens.minuteCount >= limits.tokensPerMinute) {
      return { allowed: false, reason: 'tokens_per_minute_limit' };
    }
    if (limits.tokensPerDay && state.tokens.dayCount >= limits.tokensPerDay) {
      return { allowed: false, reason: 'tokens_per_day_limit' };
    }

    // 通过检查，递增计数
    state.requests.minuteCount++;
    state.requests.dayCount++;

    return { allowed: true };
  }

  /**
   * 追加 Token 计数（流式响应后调用）
   * @param {string} sourceName - 源名称
   * @param {number} tokens - Token 数量
   */
  addTokens(sourceName, tokens) {
    const state = this.getState(sourceName);
    const now = Date.now();

    this.resetIfNeeded(state, now);

    state.tokens.minuteCount += tokens;
    state.tokens.dayCount += tokens;
  }

  /**
   * 估算 Token 数量（粗略估算）
   * 英文约 4 字符 = 1 token，中文约 1.5 字符 = 1 token
   * @param {string} text - 文本内容
   * @returns {number} 估算的 Token 数量
   */
  estimateTokens(text) {
    if (!text) return 0;
    
    // 简单估算：平均 3 字符 = 1 token
    return Math.ceil(text.length / 3);
  }

  /**
   * 获取源的当前计数状态
   * @param {string} sourceName - 源名称
   * @returns {Object} 计数状态
   */
  getCounts(sourceName) {
    const state = this.getState(sourceName);
    const now = Date.now();

    this.resetIfNeeded(state, now);

    return {
      requests: {
        minuteCount: state.requests.minuteCount,
        dayCount: state.requests.dayCount,
        minuteReset: state.requests.minuteReset,
        dayReset: state.requests.dayReset
      },
      tokens: {
        minuteCount: state.tokens.minuteCount,
        dayCount: state.tokens.dayCount,
        minuteReset: state.tokens.minuteReset,
        dayReset: state.tokens.dayReset
      }
    };
  }

  /**
   * 检查是否接近限制（用于预警）
   * @param {string} sourceName - 源名称
   * @param {Object} limits - 限流配置
   * @param {number} threshold - 预警阈值百分比 (0-1)
   * @returns {Object} { warning: boolean, reasons: string[] }
   */
  checkWarning(sourceName, limits, threshold = 0.8) {
    const counts = this.getCounts(sourceName);
    const reasons = [];

    if (limits.requestsPerMinute && counts.requests.minuteCount >= limits.requestsPerMinute * threshold) {
      reasons.push('requests_per_minute_warning');
    }
    if (limits.requestsPerDay && counts.requests.dayCount >= limits.requestsPerDay * threshold) {
      reasons.push('requests_per_day_warning');
    }
    if (limits.tokensPerMinute && counts.tokens.minuteCount >= limits.tokensPerMinute * threshold) {
      reasons.push('tokens_per_minute_warning');
    }
    if (limits.tokensPerDay && counts.tokens.dayCount >= limits.tokensPerDay * threshold) {
      reasons.push('tokens_per_day_warning');
    }

    return {
      warning: reasons.length > 0,
      reasons
    };
  }

  /**
   * 重置指定源的计数
   * @param {string} sourceName - 源名称
   */
  reset(sourceName) {
    this.states.set(sourceName, this.createInitialState());
  }

  /**
   * 重置所有源的计数
   */
  resetAll() {
    this.states.clear();
  }

  /**
   * 导出状态（用于持久化）
   * @returns {Object} 所有源的状态
   */
  exportState() {
    const data = {};
    for (const [name, state] of this.states) {
      data[name] = {
        requests: { ...state.requests },
        tokens: { ...state.tokens }
      };
    }
    return data;
  }

  /**
   * 导入状态（从持久化恢复）
   * @param {Object} data - 状态数据
   */
  importState(data) {
    for (const [name, state] of Object.entries(data)) {
      this.states.set(name, {
        requests: { ...state.requests },
        tokens: { ...state.tokens }
      });
    }
  }
}

// 单例导出
const rateLimiter = new RateLimiter();

module.exports = {
  RateLimiter,
  rateLimiter
};
