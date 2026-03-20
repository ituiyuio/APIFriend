/**
 * 源管理器模块
 * 管理 API 源的状态、选择和模型映射
 */

const EventEmitter = require('events');
const { rateLimiter } = require('./rateLimiter');

// 源状态枚举
const SourceStatus = {
  ENABLED: 'enabled',
  COOLING: 'cooling',
  DISABLED: 'disabled'
};

class SourceManager extends EventEmitter {
  /**
   * @param {Object} config - 配置对象
   * @param {Array} config.sources - 源配置列表
   * @param {Object} config.failover - 故障切换配置
   */
  constructor(config = {}) {
    super();
    
    this.sources = new Map();  // name -> SourceConfig
    this.states = new Map();   // name -> SourceState
    this.failoverConfig = config.failover || {
      timeoutMs: 15000,
      maxRetries: 3,
      retryDelayMs: 1000,
      cooldownMinutes: 5,
      failureThreshold: 3
    };
    
    // 初始化源
    if (config.sources && Array.isArray(config.sources)) {
      config.sources.forEach(source => this.addSource(source));
    }
    
    // 定时检查冷却状态
    this.cooldownCheckInterval = setInterval(() => {
      this.checkCooldowns();
    }, 1000);
  }

  /**
   * 添加源
   * @param {Object} sourceConfig - 源配置
   */
  addSource(sourceConfig) {
    const name = sourceConfig.name;
    
    this.sources.set(name, {
      ...sourceConfig,
      rateLimit: sourceConfig.rateLimit || {}
    });
    
    this.states.set(name, {
      status: sourceConfig.enabled !== false ? SourceStatus.ENABLED : SourceStatus.DISABLED,
      stats: {
        totalRequests: 0,
        successCount: 0,
        failureCount: 0,
        lastSuccess: null,
        lastFailure: null,
        consecutiveFailures: 0
      },
      cooldownUntil: null
    });
  }

  /**
   * 获取源配置
   * @param {string} name - 源名称
   * @returns {Object|null} 源配置
   */
  getSource(name) {
    return this.sources.get(name) || null;
  }

  /**
   * 获取源状态
   * @param {string} name - 源名称
   * @returns {Object|null} 源状态
   */
  getState(name) {
    return this.states.get(name) || null;
  }

  /**
   * 获取所有源列表
   * @returns {Array} 源列表
   */
  getAllSources() {
    const result = [];
    for (const [name, source] of this.sources) {
      const state = this.states.get(name);
      result.push({
        ...source,
        status: state.status,
        stats: { ...state.stats },
        cooldownUntil: state.cooldownUntil
      });
    }
    return result;
  }

  /**
   * 选择最佳可用源
   * @param {string} requestedModel - 请求的模型名称
   * @returns {Object|null} { source, mappedModel } 或 null
   */
  selectSource(requestedModel = null) {
    const availableSources = [];
    
    for (const [name, source] of this.sources) {
      const state = this.states.get(name);
      
      // 检查源是否可用
      if (!this.isSourceAvailable(name)) {
        continue;
      }
      
      // 检查限流
      const rateLimitCheck = rateLimiter.checkAndIncrement(name, source.rateLimit);
      if (!rateLimitCheck.allowed) {
        continue;
      }
      
      // 检查模型映射
      const modelResult = this.mapModel(source, requestedModel);
      if (modelResult.skip) {
        continue;
      }
      
      availableSources.push({
        source,
        mappedModel: modelResult.model,
        priority: source.priority || 999
      });
    }
    
    if (availableSources.length === 0) {
      return null;
    }
    
    // 按优先级排序（数字越小越优先）
    availableSources.sort((a, b) => a.priority - b.priority);
    
    return availableSources[0];
  }

  /**
   * 选择下一个可用源（用于故障切换）
   * @param {string} currentSourceName - 当前源名称
   * @param {string} requestedModel - 请求的模型名称
   * @returns {Object|null} { source, mappedModel } 或 null
   */
  selectNextSource(currentSourceName, requestedModel = null) {
    const currentSource = this.sources.get(currentSourceName);
    const currentPriority = currentSource?.priority || 999;
    
    const availableSources = [];
    
    for (const [name, source] of this.sources) {
      // 跳过当前源
      if (name === currentSourceName) {
        continue;
      }
      
      // 检查源是否可用
      if (!this.isSourceAvailable(name)) {
        continue;
      }
      
      // 检查限流
      const rateLimitCheck = rateLimiter.checkAndIncrement(name, source.rateLimit);
      if (!rateLimitCheck.allowed) {
        continue;
      }
      
      // 检查模型映射
      const modelResult = this.mapModel(source, requestedModel);
      if (modelResult.skip) {
        continue;
      }
      
      availableSources.push({
        source,
        mappedModel: modelResult.model,
        priority: source.priority || 999
      });
    }
    
    if (availableSources.length === 0) {
      return null;
    }
    
    // 按优先级排序
    availableSources.sort((a, b) => a.priority - b.priority);
    
    return availableSources[0];
  }

  /**
   * 检查源是否可用
   * @param {string} name - 源名称
   * @returns {boolean} 是否可用
   */
  isSourceAvailable(name) {
    const source = this.sources.get(name);
    const state = this.states.get(name);
    
    if (!source || !state) {
      return false;
    }
    
    // 检查是否禁用
    if (state.status === SourceStatus.DISABLED) {
      return false;
    }
    
    // 检查是否在冷却中
    if (state.status === SourceStatus.COOLING) {
      if (state.cooldownUntil && Date.now() < state.cooldownUntil) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * 模型映射
   * @param {Object} source - 源配置
   * @param {string} requestedModel - 请求的模型名称
   * @returns {Object} { model: string, skip: boolean }
   */
  mapModel(source, requestedModel) {
    if (!requestedModel) {
      // 无请求模型，使用默认
      const defaultModel = source.modelMapping?.default;
      return {
        model: defaultModel || null,
        skip: !defaultModel && source.modelMappingStrict
      };
    }
    
    const mapping = source.modelMapping?.[requestedModel];
    
    if (mapping) {
      return { model: mapping, skip: false };
    }
    
    // 无映射
    const defaultModel = source.modelMapping?.default;
    
    if (defaultModel) {
      if (source.modelMappingStrict) {
        // 严格模式：无映射时跳过该源
        return { model: null, skip: true };
      }
      return { model: defaultModel, skip: false };
    }
    
    // 无默认映射，原样透传
    return { model: requestedModel, skip: false };
  }

  /**
   * 标记请求成功
   * @param {string} name - 源名称
   */
  markSuccess(name) {
    const state = this.states.get(name);
    if (!state) return;
    
    state.stats.totalRequests++;
    state.stats.successCount++;
    state.stats.lastSuccess = new Date().toISOString();
    state.stats.consecutiveFailures = 0;
    
    // 如果在冷却中且成功，可以提前恢复
    if (state.status === SourceStatus.COOLING) {
      state.status = SourceStatus.ENABLED;
      state.cooldownUntil = null;
      this.emit('source_recovered', { name });
    }
  }

  /**
   * 标记请求失败
   * @param {string} name - 源名称
   * @param {string} reason - 失败原因
   */
  markFailure(name, reason = 'unknown') {
    const state = this.states.get(name);
    if (!state) return;
    
    state.stats.totalRequests++;
    state.stats.failureCount++;
    state.stats.lastFailure = new Date().toISOString();
    state.stats.consecutiveFailures++;
    
    this.emit('source_failure', { name, reason, consecutiveFailures: state.stats.consecutiveFailures });
    
    // 检查是否需要进入冷却
    if (state.stats.consecutiveFailures >= this.failoverConfig.failureThreshold) {
      this.enterCooldown(name);
    }
  }

  /**
   * 进入冷却状态
   * @param {string} name - 源名称
   */
  enterCooldown(name) {
    const state = this.states.get(name);
    if (!state) return;
    
    const cooldownMs = (this.failoverConfig.cooldownMinutes || 5) * 60 * 1000;
    state.status = SourceStatus.COOLING;
    state.cooldownUntil = Date.now() + cooldownMs;
    
    this.emit('cooldown_entered', { name, cooldownUntil: state.cooldownUntil });
  }

  /**
   * 检查冷却状态，自动恢复
   */
  checkCooldowns() {
    const now = Date.now();
    
    for (const [name, state] of this.states) {
      if (state.status === SourceStatus.COOLING && state.cooldownUntil) {
        if (now >= state.cooldownUntil) {
          state.status = SourceStatus.ENABLED;
          state.cooldownUntil = null;
          state.stats.consecutiveFailures = 0;  // 重置连续失败计数
          this.emit('source_recovered', { name });
        }
      }
    }
  }

  /**
   * 手动启用源
   * @param {string} name - 源名称
   */
  enableSource(name) {
    const state = this.states.get(name);
    if (!state) return false;
    
    state.status = SourceStatus.ENABLED;
    state.cooldownUntil = null;
    state.stats.consecutiveFailures = 0;
    
    this.emit('source_enabled', { name });
    return true;
  }

  /**
   * 手动禁用源
   * @param {string} name - 源名称
   */
  disableSource(name) {
    const state = this.states.get(name);
    if (!state) return false;
    
    state.status = SourceStatus.DISABLED;
    
    this.emit('source_disabled', { name });
    return true;
  }

  /**
   * 重置源状态
   * @param {string} name - 源名称
   */
  resetSource(name) {
    const state = this.states.get(name);
    if (!state) return false;
    
    state.status = SourceStatus.ENABLED;
    state.cooldownUntil = null;
    state.stats = {
      totalRequests: 0,
      successCount: 0,
      failureCount: 0,
      lastSuccess: null,
      lastFailure: null,
      consecutiveFailures: 0
    };
    
    rateLimiter.reset(name);
    
    this.emit('source_reset', { name });
    return true;
  }

  /**
   * 获取源状态摘要
   * @param {string} name - 源名称
   * @returns {Object|null} 状态摘要
   */
  getSourceSummary(name) {
    const source = this.sources.get(name);
    const state = this.states.get(name);
    
    if (!source || !state) return null;
    
    const rateLimitCounts = rateLimiter.getCounts(name);
    
    return {
      name: source.name,
      baseUrl: source.baseUrl,
      priority: source.priority,
      status: state.status,
      stats: { ...state.stats },
      cooldownUntil: state.cooldownUntil,
      rateLimit: {
        configured: source.rateLimit,
        current: rateLimitCounts
      }
    };
  }

  /**
   * 导出状态（用于持久化）
   * @returns {Object} 状态数据
   */
  exportState() {
    const data = {};
    for (const [name, state] of this.states) {
      data[name] = {
        status: state.status,
        stats: { ...state.stats },
        cooldownUntil: state.cooldownUntil
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
      if (this.states.has(name)) {
        const currentState = this.states.get(name);
        currentState.status = state.status;
        currentState.stats = { ...state.stats };
        currentState.cooldownUntil = state.cooldownUntil;
      }
    }
  }

  /**
   * 更新配置
   * @param {Object} config - 新配置
   */
  updateConfig(config) {
    if (config.failover) {
      this.failoverConfig = { ...this.failoverConfig, ...config.failover };
    }
    
    // 更新源配置
    if (config.sources && Array.isArray(config.sources)) {
      // 清除现有源
      this.sources.clear();
      this.states.clear();
      
      // 添加新源
      config.sources.forEach(source => this.addSource(source));
    }
  }

  /**
   * 销毁实例
   */
  destroy() {
    if (this.cooldownCheckInterval) {
      clearInterval(this.cooldownCheckInterval);
    }
    this.removeAllListeners();
  }
}

// 导出
module.exports = {
  SourceManager,
  SourceStatus
};
