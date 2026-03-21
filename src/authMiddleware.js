/**
 * 安全认证中间件模块
 * 提供 API 密钥验证功能
 */

/**
 * 创建认证中间件
 * @param {Object} options - 配置选项
 * @param {string} options.proxyApiKey - 代理 API 密钥
 * @param {string} options.adminApiKey - 管理 API 密钥（可选，默认使用 proxyApiKey）
 * @param {string[]} options.skipPaths - 跳过验证的路径
 * @param {string} options.keyHeader - 自定义密钥头名称
 * @param {Function} options.onLog - 日志回调
 * @returns {Function} Express 中间件
 */
function createAuthMiddleware(options = {}) {
  const {
    proxyApiKey,
    adminApiKey,
    skipPaths = ['/admin/health'],
    skipAdminPanel = true,  // 默认跳过管理面板认证
    keyHeader = 'x-proxy-key',
    onLog = console.log
  } = options;
  
  /**
   * 从请求中提取密钥
   * @param {Object} req - Express 请求对象
   * @returns {string|null} 密钥
   */
  function extractKey(req) {
    // 1. 从 Authorization header 获取 (Bearer token)
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }
    
    // 2. 从 x-api-key header 获取 (Anthropic 标准)
    const xApiKey = req.headers['x-api-key'];
    if (xApiKey) {
      return xApiKey;
    }
    
    // 3. 从自定义 header 获取
    const customKey = req.headers[keyHeader.toLowerCase()];
    if (customKey) {
      return customKey;
    }
    
    // 4. 从查询参数获取
    if (req.query && req.query.key) {
      return req.query.key;
    }
    
    return null;
  }
  
  /**
   * 检查路径是否应该跳过验证
   * @param {string} path - 请求路径
   * @returns {boolean}
   */
  function shouldSkip(path) {
    // 默认跳过静态文件和管理面板 HTML
    const defaultSkips = ['/', '/index.html', '/favicon.ico'];
    if (defaultSkips.includes(path) || path.startsWith('/admin')) {
      return true;
    }
    
    return skipPaths.some(skipPath => {
      if (skipPath.endsWith('*')) {
        return path.startsWith(skipPath.slice(0, -1));
      }
      return path === skipPath;
    });
  }
  
  /**
   * 验证密钥
   * @param {string} providedKey - 提供的密钥
   * @param {string} expectedKey - 期望的密钥
   * @returns {boolean}
   */
  function validateKey(providedKey, expectedKey) {
    if (!expectedKey) return true; // 未配置密钥时跳过验证
    if (!providedKey) return false;
    
    // 使用时间安全比较防止时序攻击
    return timingSafeEqual(providedKey, expectedKey);
  }
  
  /**
   * 时间安全字符串比较
   * @param {string} a - 字符串 a
   * @param {string} b - 字符串 b
   * @returns {boolean}
   */
  function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
      return false;
    }
    
    // 长度不同时仍然比较完整字符串以防止时序攻击
    const lenA = a.length;
    const lenB = b.length;
    const maxLen = Math.max(lenA, lenB);
    
    let result = lenA === lenB ? 0 : 1;
    
    for (let i = 0; i < maxLen; i++) {
      const charA = i < lenA ? a.charCodeAt(i) : 0;
      const charB = i < lenB ? b.charCodeAt(i) : 0;
      result |= charA ^ charB;
    }
    
    return result === 0;
  }
  
  // 返回中间件函数
  return function authMiddleware(req, res, next) {
    // 如果没有配置密钥，跳过验证（开发模式）
    if (!proxyApiKey) {
      return next();
    }
    
    // 检查是否跳过路径
    if (shouldSkip(req.path)) {
      return next();
    }
    
    // 提取密钥
    const providedKey = extractKey(req);
    
    // 确定期望的密钥
    // 管理 API 路径使用独立的 adminApiKey（如果配置了）
    const isAdminPath = req.path.startsWith('/admin');
    const expectedKey = isAdminPath && adminApiKey ? adminApiKey : proxyApiKey;
    
    // 验证密钥
    if (!validateKey(providedKey, expectedKey)) {
      onLog('warn', `Authentication failed for ${req.method} ${req.path}`, {
        ip: req.ip || req.connection?.remoteAddress,
        hasKey: !!providedKey
      });
      
      return res.status(401).json({
        error: {
          type: 'authentication_error',
          message: 'Unauthorized: Invalid or missing API key',
          code: 'UNAUTHORIZED'
        }
      });
    }
    
    // 验证通过
    next();
  };
}

/**
 * 创建可选认证中间件
 * 如果提供了密钥则验证，否则继续
 * @param {Object} options - 配置选项
 * @returns {Function} Express 中间件
 */
function createOptionalAuthMiddleware(options = {}) {
  const {
    proxyApiKey,
    keyHeader = 'x-proxy-key',
    onAuth = () => {}
  } = options;
  
  return function optionalAuthMiddleware(req, res, next) {
    if (!proxyApiKey) {
      return next();
    }
    
    const authHeader = req.headers['authorization'];
    const customKey = req.headers[keyHeader.toLowerCase()];
    
    let providedKey = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      providedKey = authHeader.slice(7);
    } else if (customKey) {
      providedKey = customKey;
    }
    
    if (providedKey === proxyApiKey) {
      req.authenticated = true;
      onAuth(req);
    } else {
      req.authenticated = false;
    }
    
    next();
  };
}

/**
 * 创建 IP 白名单中间件
 * @param {Object} options - 配置选项
 * @param {string[]} options.whitelist - IP 白名单
 * @param {boolean} options.allowLocalhost - 是否允许本地访问
 * @param {Function} options.onLog - 日志回调
 * @returns {Function} Express 中间件
 */
function createIpWhitelistMiddleware(options = {}) {
  const {
    whitelist = [],
    allowLocalhost = true,
    onLog = console.log
  } = options;
  
  const localhostIps = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
  
  return function ipWhitelistMiddleware(req, res, next) {
    // 如果白名单为空，允许所有
    if (whitelist.length === 0) {
      return next();
    }
    
    const clientIp = req.ip || 
                     req.connection?.remoteAddress || 
                     req.socket?.remoteAddress ||
                     req.headers['x-forwarded-for']?.split(',')[0]?.trim();
    
    // 检查本地访问
    if (allowLocalhost && localhostIps.includes(clientIp)) {
      return next();
    }
    
    // 检查白名单
    if (!whitelist.includes(clientIp)) {
      onLog('warn', `IP not in whitelist: ${clientIp}`);
      
      return res.status(403).json({
        error: {
          type: 'forbidden_error',
          message: 'Access denied: IP not in whitelist',
          code: 'FORBIDDEN'
        }
      });
    }
    
    next();
  };
}

/**
 * 创建速率限制中间件（简单的内存实现）
 * @param {Object} options - 配置选项
 * @param {number} options.windowMs - 时间窗口（毫秒）
 * @param {number} options.maxRequests - 最大请求数
 * @param {Function} options.keyGenerator - 生成键的函数
 * @param {Function} options.onLog - 日志回调
 * @returns {Function} Express 中间件
 */
function createRateLimitMiddleware(options = {}) {
  const {
    windowMs = 60000, // 1 分钟
    maxRequests = 100,
    keyGenerator = (req) => req.ip || req.connection?.remoteAddress || 'unknown',
    onLog = console.log
  } = options;
  
  const requests = new Map(); // key -> { count, resetTime }
  
  // 定期清理过期记录
  setInterval(() => {
    const now = Date.now();
    for (const [key, data] of requests) {
      if (now > data.resetTime) {
        requests.delete(key);
      }
    }
  }, windowMs);
  
  return function rateLimitMiddleware(req, res, next) {
    const key = keyGenerator(req);
    const now = Date.now();
    
    let data = requests.get(key);
    
    if (!data || now > data.resetTime) {
      // 新窗口
      data = {
        count: 1,
        resetTime: now + windowMs
      };
      requests.set(key, data);
      return next();
    }
    
    // 增加计数
    data.count++;
    
    if (data.count > maxRequests) {
      const retryAfter = Math.ceil((data.resetTime - now) / 1000);
      
      res.setHeader('Retry-After', retryAfter);
      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.setHeader('X-RateLimit-Reset', data.resetTime);
      
      onLog('warn', `Rate limit exceeded for ${key}`);
      
      return res.status(429).json({
        error: {
          type: 'rate_limit_error',
          message: 'Too many requests',
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfter
        }
      });
    }
    
    // 设置响应头
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', maxRequests - data.count);
    res.setHeader('X-RateLimit-Reset', data.resetTime);
    
    next();
  };
}

/**
 * 安全头中间件
 * 添加安全相关的 HTTP 头
 * @param {Object} options - 配置选项
 * @returns {Function} Express 中间件
 */
function createSecurityHeadersMiddleware(options = {}) {
  const {
    contentSecurityPolicy = true,
    xssProtection = true,
    noSniff = true,
    frameGuard = true
  } = options;
  
  return function securityHeadersMiddleware(req, res, next) {
    // X-Content-Type-Options
    if (noSniff) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    
    // X-XSS-Protection
    if (xssProtection) {
      res.setHeader('X-XSS-Protection', '1; mode=block');
    }
    
    // X-Frame-Options
    if (frameGuard) {
      res.setHeader('X-Frame-Options', 'DENY');
    }
    
    // Content-Security-Policy
    if (contentSecurityPolicy) {
      res.setHeader('Content-Security-Policy', 
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com; " +
        "img-src 'self' data:;"
      );
    }
    
    // 移除可能暴露服务器信息的头
    res.removeHeader('X-Powered-By');
    
    next();
  };
}

module.exports = {
  createAuthMiddleware,
  createOptionalAuthMiddleware,
  createIpWhitelistMiddleware,
  createRateLimitMiddleware,
  createSecurityHeadersMiddleware
};
