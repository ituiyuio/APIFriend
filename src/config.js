const fs = require('fs');
const path = require('path');

// 默认配置
const DEFAULT_CONFIG = {
  server: {
    port: 3000,
    host: '127.0.0.1'
  },
  security: {
    proxyApiKey: ''
  },
  sources: [],
  failover: {
    timeoutMs: 15000,
    maxRetries: 3,
    retryDelayMs: 1000,
    cooldownMinutes: 5,
    failureThreshold: 3
  },
  persistence: {
    enabled: true,
    file: '.state.json',
    intervalMs: 60000
  },
  logging: {
    level: 'info',
    file: 'logs/apifriend.log'
  }
};

// 默认源配置
const DEFAULT_SOURCE_CONFIG = {
  enabled: true,
  format: 'openai',
  rateLimit: {
    requestsPerMinute: 60,
    tokensPerMinute: 10000,
    requestsPerDay: 1000,
    tokensPerDay: 100000
  },
  modelMapping: {
    default: null
  },
  modelMappingStrict: false
};

// 默认限流配置
const DEFAULT_RATE_LIMIT = {
  requestsPerMinute: 60,
  tokensPerMinute: 10000,
  requestsPerDay: 1000,
  tokensPerDay: 100000
};

/**
 * 验证源配置
 * @param {Object} source - 源配置
 * @param {number} index - 源索引
 * @returns {Object} { valid: boolean, errors: string[] }
 */
function validateSource(source, index) {
  const errors = [];
  
  if (!source.name) {
    errors.push(`Source[${index}]: name is required`);
  }
  
  if (!source.baseUrl) {
    errors.push(`Source[${index}]: baseUrl is required`);
  } else {
    try {
      new URL(source.baseUrl);
    } catch {
      errors.push(`Source[${index}]: baseUrl is not a valid URL`);
    }
  }
  
  if (!source.apiKey) {
    errors.push(`Source[${index}]: apiKey is required`);
  }
  
  if (typeof source.priority !== 'number' || source.priority < 1) {
    errors.push(`Source[${index}]: priority must be a positive number`);
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * 验证完整配置
 * @param {Object} config - 配置对象
 * @returns {Object} { valid: boolean, errors: string[] }
 */
function validateConfig(config) {
  const errors = [];
  
  // 验证服务器配置
  if (config.server) {
    if (typeof config.server.port !== 'number' || config.server.port < 1 || config.server.port > 65535) {
      errors.push('server.port must be a valid port number (1-65535)');
    }
    if (config.server.host && typeof config.server.host !== 'string') {
      errors.push('server.host must be a string');
    }
  }
  
  // 验证故障切换配置
  if (config.failover) {
    if (config.failover.timeoutMs && (typeof config.failover.timeoutMs !== 'number' || config.failover.timeoutMs < 0)) {
      errors.push('failover.timeoutMs must be a non-negative number');
    }
    if (config.failover.maxRetries && (typeof config.failover.maxRetries !== 'number' || config.failover.maxRetries < 0)) {
      errors.push('failover.maxRetries must be a non-negative number');
    }
    if (config.failover.cooldownMinutes && (typeof config.failover.cooldownMinutes !== 'number' || config.failover.cooldownMinutes < 0)) {
      errors.push('failover.cooldownMinutes must be a non-negative number');
    }
    if (config.failover.failureThreshold && (typeof config.failover.failureThreshold !== 'number' || config.failover.failureThreshold < 0)) {
      errors.push('failover.failureThreshold must be a non-negative number');
    }
  }
  
  // 验证源配置
  if (config.sources && Array.isArray(config.sources)) {
    config.sources.forEach((source, index) => {
      const result = validateSource(source, index);
      errors.push(...result.errors);
    });
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * 深度合并对象
 * @param {Object} target - 目标对象
 * @param {Object} source - 源对象
 * @returns {Object} 合并后的对象
 */
function deepMerge(target, source) {
  const result = { ...target };
  
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  
  return result;
}

/**
 * 规范化源配置（填充默认值）
 * @param {Object} source - 源配置
 * @returns {Object} 规范化后的配置
 */
function normalizeSource(source) {
  const normalized = deepMerge(DEFAULT_SOURCE_CONFIG, source);
  normalized.rateLimit = deepMerge(DEFAULT_RATE_LIMIT, source.rateLimit || {});
  return normalized;
}

/**
 * 加载配置文件
 * @param {string} configPath - 配置文件路径
 * @returns {Object} 配置对象
 */
function loadConfig(configPath = 'config.json') {
  const absolutePath = path.resolve(configPath);
  
  // 检查配置文件是否存在
  if (!fs.existsSync(absolutePath)) {
    console.warn(`Config file not found: ${absolutePath}`);
    console.warn('Using default configuration. Please create config.json from config.example.json');
    return { ...DEFAULT_CONFIG };
  }
  
  try {
    const content = fs.readFileSync(absolutePath, 'utf8');
    const userConfig = JSON.parse(content);
    
    // 合并默认配置
    const config = deepMerge(DEFAULT_CONFIG, userConfig);
    
    // 规范化源配置
    if (config.sources && Array.isArray(config.sources)) {
      config.sources = config.sources.map(normalizeSource);
    }
    
    // 验证配置
    const validation = validateConfig(config);
    if (!validation.valid) {
      console.error('Configuration validation failed:');
      validation.errors.forEach(err => console.error(`  - ${err}`));
      throw new Error('Invalid configuration');
    }
    
    return config;
  } catch (err) {
    if (err.message === 'Invalid configuration') {
      throw err;
    }
    throw new Error(`Failed to load config: ${err.message}`);
  }
}

/**
 * 获取配置文件示例路径
 * @returns {string} 示例配置文件路径
 */
function getExampleConfigPath() {
  return path.resolve('config.example.json');
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_SOURCE_CONFIG,
  DEFAULT_RATE_LIMIT,
  loadConfig,
  validateConfig,
  validateSource,
  deepMerge,
  normalizeSource,
  getExampleConfigPath
};
