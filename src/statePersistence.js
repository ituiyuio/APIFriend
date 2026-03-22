/**
 * 状态持久化模块
 * 负责将运行时状态保存到文件，以及从文件恢复状态
 */

const fs = require('fs');
const path = require('path');

/**
 * 持久化事件类型
 */
const PersistenceEvent = {
  SAVE_START: 'save_start',
  SAVE_COMPLETE: 'save_complete',
  SAVE_ERROR: 'save_error',
  LOAD_START: 'load_start',
  LOAD_COMPLETE: 'load_complete',
  LOAD_ERROR: 'load_error'
};

/**
 * 状态持久化管理器
 */
class StatePersistence {
  /**
   * @param {Object} options - 配置选项
   * @param {string} options.file - 状态文件路径
   * @param {number} options.intervalMs - 自动保存间隔（毫秒）
   * @param {boolean} options.saveOnExit - 是否在退出时保存
   * @param {Function} options.onLog - 日志回调
   */
  constructor(options = {}) {
    this.filePath = options.file || '.state.json';
    this.intervalMs = options.intervalMs || 60000; // 默认 1 分钟
    this.saveOnExit = options.saveOnExit !== false;
    this.onLog = options.onLog || console.log;
    
    this.providers = new Map(); // name -> { getState, setState }
    this.intervalId = null;
    this.lastSaveTime = null;
    this.lastLoadTime = null;
    this.pendingImmediateSave = false;
    
    // 事件监听器
    this.eventListeners = new Map();
    
    // 绑定退出处理
    this._setupExitHandlers();
  }
  
  /**
   * 注册状态提供者
   * @param {string} name - 提供者名称
   * @param {Function} getState - 获取状态的函数
   * @param {Function} setState - 设置状态的函数
   */
  register(name, getState, setState) {
    this.providers.set(name, { getState, setState });
    this.onLog('debug', `State provider registered: ${name}`);
  }
  
  /**
   * 注销状态提供者
   * @param {string} name - 提供者名称
   */
  unregister(name) {
    this.providers.delete(name);
    this.onLog('debug', `State provider unregistered: ${name}`);
  }
  
  /**
   * 收集所有状态
   * @returns {Object} 完整状态对象
   */
  collectState() {
    const state = {
      version: 1,
      savedAt: new Date().toISOString(),
      providers: {}
    };
    
    for (const [name, provider] of this.providers) {
      try {
        const providerState = provider.getState();
        if (providerState !== null && providerState !== undefined) {
          state.providers[name] = providerState;
        }
      } catch (err) {
        this.onLog('warn', `Failed to get state from provider ${name}: ${err.message}`);
      }
    }
    
    return state;
  }
  
  /**
   * 分发状态到各提供者
   * @param {Object} state - 状态对象
   */
  distributeState(state) {
    if (!state || !state.providers) {
      this.onLog('warn', 'Invalid state object to distribute');
      return;
    }
    
    for (const [name, providerState] of Object.entries(state.providers)) {
      const provider = this.providers.get(name);
      if (provider && provider.setState) {
        try {
          provider.setState(providerState);
        } catch (err) {
          this.onLog('warn', `Failed to set state for provider ${name}: ${err.message}`);
        }
      }
    }
  }
  
  /**
   * 保存状态到文件
   * @param {boolean} immediate - 是否立即保存（跳过防抖）
   * @returns {Promise<boolean>} 是否成功
   */
  async save(immediate = false) {
    // 防抖：如果已有待处理的立即保存，跳过
    if (immediate && this.pendingImmediateSave) {
      return false;
    }
    
    if (immediate) {
      this.pendingImmediateSave = true;
    }
    
    this._emit(PersistenceEvent.SAVE_START);
    
    try {
      const state = this.collectState();
      const content = JSON.stringify(state, null, 2);
      
      // 确保目录存在
      const dir = path.dirname(this.filePath);
      if (dir !== '.' && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      // 写入文件
      fs.writeFileSync(this.filePath, content, 'utf8');
      
      this.lastSaveTime = new Date();
      this._emit(PersistenceEvent.SAVE_COMPLETE, { state });
      
      this.onLog('debug', `State saved to ${this.filePath}`);
      
      return true;
    } catch (err) {
      this._emit(PersistenceEvent.SAVE_ERROR, { error: err });
      this.onLog('error', `Failed to save state: ${err.message}`);
      return false;
    } finally {
      if (immediate) {
        this.pendingImmediateSave = false;
      }
    }
  }
  
  /**
   * 从文件加载状态
   * @returns {Promise<Object|null>} 加载的状态对象
   */
  async load() {
    this._emit(PersistenceEvent.LOAD_START);
    
    try {
      if (!fs.existsSync(this.filePath)) {
        this.onLog('debug', `State file not found: ${this.filePath}`);
        return null;
      }
      
      const content = fs.readFileSync(this.filePath, 'utf8');
      const state = JSON.parse(content);
      
      // 验证版本
      if (!state.version) {
        this.onLog('warn', 'State file has no version, may be incompatible');
      }
      
      // 分发状态
      this.distributeState(state);
      
      this.lastLoadTime = new Date();
      this._emit(PersistenceEvent.LOAD_COMPLETE, { state });
      
      this.onLog('debug', `State loaded from ${this.filePath}`);
      
      return state;
    } catch (err) {
      this._emit(PersistenceEvent.LOAD_ERROR, { error: err });
      this.onLog('error', `Failed to load state: ${err.message}`);
      return null;
    }
  }
  
  /**
   * 启动自动保存
   */
  startAutoSave() {
    if (this.intervalId) {
      this.onLog('warn', 'Auto save already running');
      return;
    }
    
    this.intervalId = setInterval(() => {
      this.save(false);
    }, this.intervalMs);
    
    // 防止阻止进程退出
    if (this.intervalId.unref) {
      this.intervalId.unref();
    }
    
    this.onLog('info', `Auto save started with interval ${this.intervalMs}ms`);
  }
  
  /**
   * 停止自动保存
   */
  stopAutoSave() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.onLog('info', 'Auto save stopped');
    }
  }
  
  /**
   * 设置退出处理
   */
  _setupExitHandlers() {
    if (!this.saveOnExit) return;
    
    const exitHandler = async (signal) => {
      this.onLog('info', `Process ${signal}, saving state...`);
      await this.save(true);
      process.exit(0);
    };
    
    // 正常退出
    process.on('SIGINT', () => exitHandler('SIGINT'));
    process.on('SIGTERM', () => exitHandler('SIGTERM'));
    
    // Windows 支持
    if (process.platform === 'win32') {
      // Windows 下 SIGINT 已经被上面的处理器捕获
    }
    
    this.onLog('debug', 'Exit handlers registered');
  }
  
  /**
   * 添加事件监听器
   * @param {string} event - 事件名称
   * @param {Function} listener - 监听器函数
   */
  on(event, listener) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(listener);
  }
  
  /**
   * 移除事件监听器
   * @param {string} event - 事件名称
   * @param {Function} listener - 监听器函数
   */
  off(event, listener) {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
  }
  
  /**
   * 发射事件
   * @param {string} event - 事件名称
   * @param {Object} data - 事件数据
   */
  _emit(event, data = {}) {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(data);
        } catch (err) {
          this.onLog('warn', `Event listener error: ${err.message}`);
        }
      }
    }
  }
  
  /**
   * 获取状态文件路径
   * @returns {string} 文件路径
   */
  getFilePath() {
    return path.resolve(this.filePath);
  }
  
  /**
   * 检查状态文件是否存在
   * @returns {boolean}
   */
  exists() {
    return fs.existsSync(this.filePath);
  }
  
  /**
   * 删除状态文件
   * @returns {boolean} 是否成功
   */
  delete() {
    try {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
        this.onLog('debug', `State file deleted: ${this.filePath}`);
      }
      return true;
    } catch (err) {
      this.onLog('error', `Failed to delete state file: ${err.message}`);
      return false;
    }
  }
  
  /**
   * 获取统计信息
   * @returns {Object}
   */
  getStats() {
    return {
      filePath: this.filePath,
      exists: this.exists(),
      lastSaveTime: this.lastSaveTime,
      lastLoadTime: this.lastLoadTime,
      intervalMs: this.intervalMs,
      autoSaveRunning: this.intervalId !== null,
      providerCount: this.providers.size
    };
  }
  
  /**
   * 清理资源
   */
  destroy() {
    this.stopAutoSave();
    this.providers.clear();
    this.eventListeners.clear();
    this.onLog('debug', 'StatePersistence destroyed');
  }
}

/**
 * 创建用于 SourceManager 的状态提供者
 * @param {SourceManager} sourceManager - 源管理器实例
 * @returns {Object} 状态提供者
 */
function createSourceManagerProvider(sourceManager) {
  return {
    getState: () => sourceManager.exportState(),
    setState: (state) => sourceManager.importState(state)
  };
}

/**
 * 创建用于 RateLimiter 的状态提供者
 * @param {RateLimiter} rateLimiter - 限流器实例
 * @returns {Object} 状态提供者
 */
function createRateLimiterProvider(rateLimiter) {
  return {
    getState: () => rateLimiter.exportState(),
    setState: (state) => rateLimiter.importState(state)
  };
}

/**
 * 创建用于 FailoverDetector 的状态提供者
 * @param {FailoverDetector} detector - 故障检测器实例
 * @returns {Object} 状态提供者
 */
function createFailoverDetectorProvider(detector) {
  return {
    getState: () => detector.exportState(),
    setState: (state) => detector.importState(state)
  };
}

/**
 * 创建用于 StreamErrorHandler 的状态提供者
 * @param {StreamErrorHandler} handler - 流式错误处理器实例
 * @returns {Object} 状态提供者
 */
function createStreamErrorHandlerProvider(handler) {
  return {
    getState: () => handler.exportState(),
    setState: (state) => handler.importState(state)
  };
}

/**
 * 创建用于 StatsRecorder 的状态提供者
 * @param {StatsRecorder} statsRecorder - 统计记录器实例
 * @returns {Object} 状态提供者
 */
function createStatsRecorderProvider(statsRecorder) {
  return {
    getState: () => statsRecorder.export(),
    setState: (state) => statsRecorder.import(state)
  };
}

module.exports = {
  StatePersistence,
  PersistenceEvent,
  createSourceManagerProvider,
  createRateLimiterProvider,
  createFailoverDetectorProvider,
  createStreamErrorHandlerProvider,
  createStatsRecorderProvider
};
