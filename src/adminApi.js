/**
 * 管理 API 路由模块
 * 提供源管理和状态查询接口
 */

const express = require('express');

/**
 * 创建管理 API 路由
 * @param {Object} options - 配置选项
 * @param {Object} options.sourceManager - 源管理器实例
 * @param {Object} options.rateLimiter - 限流器实例
 * @param {Object} options.failoverDetector - 故障检测器实例
 * @param {Object} options.statePersistence - 状态持久化实例
 * @param {Object} options.config - 配置对象
 * @param {Function} options.onLog - 日志回调
 * @returns {express.Router} Express 路由
 */
function createAdminRouter(options = {}) {
  const router = express.Router();
  const {
    sourceManager,
    rateLimiter,
    failoverDetector,
    statePersistence,
    config,
    onLog = console.log
  } = options;
  
  /**
   * GET /admin/sources
   * 获取所有源状态
   */
  router.get('/sources', (req, res) => {
    try {
      const sources = sourceManager?.getAllSources() || [];
      const summaries = sources.map(source => {
        const summary = sourceManager?.getSourceSummary(source.name);
        const rateLimitState = rateLimiter?.getCounts(source.name);
        
        return {
          name: source.name,
          baseUrl: source.baseUrl,
          priority: source.priority,
          enabled: source.enabled,
          status: summary?.status || 'unknown',
          stats: summary?.stats || {},
          rateLimit: rateLimitState || {}
        };
      });
      
      res.json({
        success: true,
        data: summaries,
        count: summaries.length
      });
    } catch (err) {
      onLog('error', `Failed to get sources: ${err.message}`);
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  });
  
  /**
   * GET /admin/sources/:name
   * 获取单个源详情
   */
  router.get('/sources/:name', (req, res) => {
    try {
      const { name } = req.params;
      
      const source = sourceManager?.getSource(name);
      if (!source) {
        return res.status(404).json({
          success: false,
          error: 'Source not found'
        });
      }
      
      const summary = sourceManager?.getSourceSummary(name);
      const rateLimitState = rateLimiter?.getCounts(name);
      const failoverStats = failoverDetector?.getStats(name);
      
      res.json({
        success: true,
        data: {
          name: source.name,
          baseUrl: source.baseUrl,
          priority: source.priority,
          enabled: source.enabled,
          format: source.format,
          modelMapping: source.modelMapping,
          modelMappingStrict: source.modelMappingStrict,
          status: summary?.status,
          stats: summary?.stats,
          rateLimit: {
            config: source.rateLimit,
            current: rateLimitState
          },
          failover: failoverStats,
          cooldownUntil: summary?.cooldownUntil
        }
      });
    } catch (err) {
      onLog('error', `Failed to get source: ${err.message}`);
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  });
  
  /**
   * POST /admin/sources/:name/enable
   * 启用源
   */
  router.post('/sources/:name/enable', async (req, res) => {
    try {
      const { name } = req.params;
      
      const source = sourceManager?.getSource(name);
      if (!source) {
        return res.status(404).json({
          success: false,
          error: 'Source not found'
        });
      }
      
      sourceManager?.enableSource(name);
      
      // 触发状态持久化
      if (statePersistence) {
        await statePersistence.save(true);
      }
      
      onLog('info', `Source enabled: ${name}`);
      
      res.json({
        success: true,
        message: `Source '${name}' enabled`,
        data: sourceManager?.getSourceSummary(name)
      });
    } catch (err) {
      onLog('error', `Failed to enable source: ${err.message}`);
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  });
  
  /**
   * POST /admin/sources/:name/disable
   * 禁用源
   */
  router.post('/sources/:name/disable', async (req, res) => {
    try {
      const { name } = req.params;
      
      const source = sourceManager?.getSource(name);
      if (!source) {
        return res.status(404).json({
          success: false,
          error: 'Source not found'
        });
      }
      
      sourceManager?.disableSource(name);
      
      // 触发状态持久化
      if (statePersistence) {
        await statePersistence.save(true);
      }
      
      onLog('info', `Source disabled: ${name}`);
      
      res.json({
        success: true,
        message: `Source '${name}' disabled`,
        data: sourceManager?.getSourceSummary(name)
      });
    } catch (err) {
      onLog('error', `Failed to disable source: ${err.message}`);
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  });
  
  /**
   * PATCH /admin/sources/:name
   * 更新源配置
   */
  router.patch('/sources/:name', async (req, res) => {
    try {
      const { name } = req.params;
      const updates = req.body;
      
      const source = sourceManager?.getSource(name);
      if (!source) {
        return res.status(404).json({
          success: false,
          error: 'Source not found'
        });
      }
      
      // 可更新的字段
      const allowedFields = ['priority', 'enabled', 'rateLimit', 'modelMapping', 'modelMappingStrict', 'cooldownMinutes'];
      const actualUpdates = {};
      
      for (const field of allowedFields) {
        if (updates[field] !== undefined) {
          actualUpdates[field] = updates[field];
        }
      }
      
      if (Object.keys(actualUpdates).length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No valid fields to update'
        });
      }
      
      // 执行更新
      const updated = sourceManager?.updateSource(name, actualUpdates);
      
      if (!updated) {
        return res.status(500).json({
          success: false,
          error: 'Failed to update source'
        });
      }
      
      // 触发状态持久化
      if (statePersistence) {
        await statePersistence.save(true);
      }
      
      onLog('info', `Source updated: ${name}`, actualUpdates);
      
      res.json({
        success: true,
        message: `Source '${name}' updated`,
        data: sourceManager?.getSourceSummary(name)
      });
    } catch (err) {
      onLog('error', `Failed to update source: ${err.message}`);
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  });
  
  /**
   * POST /admin/sources/:name/reset
   * 重置源状态
   */
  router.post('/sources/:name/reset', async (req, res) => {
    try {
      const { name } = req.params;
      
      const source = sourceManager?.getSource(name);
      if (!source) {
        return res.status(404).json({
          success: false,
          error: 'Source not found'
        });
      }
      
      // 重置源管理器状态
      sourceManager?.resetSource(name);
      
      // 重置限流器计数
      rateLimiter?.reset(name);
      
      // 重置故障检测器统计
      failoverDetector?.resetStats(name);
      
      // 触发状态持久化
      if (statePersistence) {
        await statePersistence.save(true);
      }
      
      onLog('info', `Source reset: ${name}`);
      
      res.json({
        success: true,
        message: `Source '${name}' reset`,
        data: sourceManager?.getSourceSummary(name)
      });
    } catch (err) {
      onLog('error', `Failed to reset source: ${err.message}`);
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  });
  
  /**
   * GET /admin/stats
   * 获取全局统计
   */
  router.get('/stats', (req, res) => {
    try {
      const sources = sourceManager?.getAllSources() || [];
      
      // 汇总统计
      let totalRequests = 0;
      let totalSuccess = 0;
      let totalFailure = 0;
      const sourceStats = [];
      
      for (const source of sources) {
        const summary = sourceManager?.getSourceSummary(source.name);
        const stats = summary?.stats || {};
        
        totalRequests += stats.totalRequests || 0;
        totalSuccess += stats.successCount || 0;
        totalFailure += stats.failureCount || 0;
        
        sourceStats.push({
          name: source.name,
          status: summary?.status,
          totalRequests: stats.totalRequests || 0,
          successCount: stats.successCount || 0,
          failureCount: stats.failureCount || 0
        });
      }
      
      // 持久化状态
      const persistenceStats = statePersistence?.getStats();
      
      res.json({
        success: true,
        data: {
          sources: {
            total: sources.length,
            enabled: sources.filter(s => s.enabled).length,
            disabled: sources.filter(s => !s.enabled).length,
            list: sourceStats
          },
          requests: {
            total: totalRequests,
            success: totalSuccess,
            failure: totalFailure,
            successRate: totalRequests > 0 
              ? ((totalSuccess / totalRequests) * 100).toFixed(2) + '%'
              : 'N/A'
          },
          persistence: persistenceStats || {}
        }
      });
    } catch (err) {
      onLog('error', `Failed to get stats: ${err.message}`);
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  });
  
  /**
   * POST /admin/save
   * 手动触发状态保存
   */
  router.post('/save', async (req, res) => {
    try {
      if (!statePersistence) {
        return res.status(400).json({
          success: false,
          error: 'State persistence not configured'
        });
      }
      
      const success = await statePersistence.save(true);
      
      res.json({
        success,
        message: success ? 'State saved' : 'Failed to save state',
        lastSaveTime: statePersistence.lastSaveTime
      });
    } catch (err) {
      onLog('error', `Failed to save state: ${err.message}`);
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  });
  
  /**
   * GET /admin/config
   * 获取当前配置（脱敏）
   */
  router.get('/config', (req, res) => {
    try {
      // 返回脱敏的配置
      const safeConfig = {
        server: config?.server,
        failover: config?.failover,
        persistence: config?.persistence,
        logging: config?.logging,
        sources: (config?.sources || []).map(s => ({
          name: s.name,
          baseUrl: s.baseUrl,
          priority: s.priority,
          enabled: s.enabled,
          format: s.format,
          rateLimit: s.rateLimit,
          modelMapping: s.modelMapping,
          // 脱敏 API Key
          apiKey: s.apiKey ? `${s.apiKey.slice(0, 8)}...${s.apiKey.slice(-4)}` : null
        }))
      };
      
      res.json({
        success: true,
        data: safeConfig
      });
    } catch (err) {
      onLog('error', `Failed to get config: ${err.message}`);
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  });
  
  /**
   * GET /admin/health
   * 健康检查
   */
  router.get('/health', (req, res) => {
    res.json({
      success: true,
      status: 'healthy',
      timestamp: new Date().toISOString()
    });
  });
  
  return router;
}

module.exports = {
  createAdminRouter
};
