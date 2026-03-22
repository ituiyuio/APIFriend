/**
 * 管理 API 路由模块
 * 提供源管理和状态查询接口
 */

const express = require('express');
const { saveConfig, reloadConfig } = require('./config');

/**
 * 保存源配置到 config.json
 * @param {Object} sourceManager - 源管理器
 * @param {Object} config - 配置对象
 */
function saveSourcesToConfig(sourceManager, config) {
  if (!sourceManager || !config) return;
  
  // 从 sourceManager 获取所有源
  const sources = sourceManager.getAllSources();
  
  // 更新 config 对象
  config.sources = sources.map(source => ({
    name: source.name,
    baseUrl: source.baseUrl,
    apiKey: source.apiKey,
    priority: source.priority,
    enabled: source.enabled,
    format: source.format,
    rateLimit: source.rateLimit,
    modelMapping: source.modelMapping,
    modelMappingStrict: source.modelMappingStrict,
    cooldownMinutes: source.cooldownMinutes
  }));
  
  // 保存到文件
  saveConfig(config);
}

/**
 * 创建管理 API 路由
 * @param {Object} options - 配置选项
 * @param {Object} options.sourceManager - 源管理器实例
 * @param {Object} options.rateLimiter - 限流器实例
 * @param {Object} options.failoverDetector - 故障检测器实例
 * @param {Object} options.statePersistence - 状态持久化实例
 * @param {Object} options.statsRecorder - 统计记录器实例
 * @param {Object} options.config - 配置对象
 * @param {Function} options.onLog - 日志回调
 * @param {Function} options.onReloadConfig - 重载配置回调
 * @returns {express.Router} Express 路由
 */
function createAdminRouter(options = {}) {
  const router = express.Router();
  const {
    sourceManager,
    rateLimiter,
    failoverDetector,
    statePersistence,
    statsRecorder,
    config,
    startTime,
    onLog = console.log,
    onReloadConfig
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
          modelMapping: source.modelMapping || {},
          modelMappingStrict: source.modelMappingStrict || false,
          rateLimit: {
            config: source.rateLimit || {},
            current: rateLimitState || {}
          }
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
   * POST /admin/sources
   * 创建新源
   */
  router.post('/sources', async (req, res) => {
    try {
      const { name, baseUrl, apiKey, priority, enabled, rateLimit, modelMapping, modelMappingStrict } = req.body;
      
      // 验证必填字段
      if (!name || !baseUrl || !apiKey) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: name, baseUrl, apiKey'
        });
      }
      
      // 检查源是否已存在
      const existing = sourceManager?.getSource(name);
      if (existing) {
        return res.status(409).json({
          success: false,
          error: `Source '${name}' already exists`
        });
      }
      
      // 创建源配置
      const sourceConfig = {
        name,
        baseUrl,
        apiKey,
        priority: priority ?? 100,
        enabled: enabled ?? true,
        rateLimit: rateLimit || {},
        modelMapping: modelMapping || {},
        modelMappingStrict: modelMappingStrict ?? false
      };
      
      // 添加源
      const added = sourceManager?.addSource(sourceConfig);
      
      if (!added) {
        return res.status(500).json({
          success: false,
          error: 'Failed to add source'
        });
      }
      
      // 保存到 config.json
      saveSourcesToConfig(sourceManager, config);
      
      // 触发状态持久化
      if (statePersistence) {
        await statePersistence.save(true);
      }
      
      onLog('info', `Source created: ${name}`);
      
      res.status(201).json({
        success: true,
        message: `Source '${name}' created`,
        data: sourceManager?.getSourceSummary(name)
      });
    } catch (err) {
      onLog('error', `Failed to create source: ${err.message}`);
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  });
  
  /**
   * DELETE /admin/sources/:name
   * 删除源
   */
  router.delete('/sources/:name', async (req, res) => {
    try {
      const { name } = req.params;
      
      const source = sourceManager?.getSource(name);
      if (!source) {
        return res.status(404).json({
          success: false,
          error: 'Source not found'
        });
      }
      
      // 删除源
      const removed = sourceManager?.removeSource(name);
      
      if (!removed) {
        return res.status(500).json({
          success: false,
          error: 'Failed to remove source'
        });
      }
      
      // 清理限流器
      rateLimiter?.reset(name);
      
      // 保存到 config.json
      saveSourcesToConfig(sourceManager, config);
      
      // 触发状态持久化
      if (statePersistence) {
        await statePersistence.save(true);
      }
      
      onLog('info', `Source deleted: ${name}`);
      
      res.json({
        success: true,
        message: `Source '${name}' deleted`
      });
    } catch (err) {
      onLog('error', `Failed to delete source: ${err.message}`);
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  });
  
  /**
   * POST /admin/sources/:name/toggle
   * 切换源状态
   */
  router.post('/sources/:name/toggle', async (req, res) => {
    try {
      const { name } = req.params;
      
      const source = sourceManager?.getSource(name);
      if (!source) {
        return res.status(404).json({
          success: false,
          error: 'Source not found'
        });
      }
      
      // 保存原始状态
      const wasEnabled = source.enabled;
      
      // 切换状态
      if (wasEnabled) {
        sourceManager?.disableSource(name);
        onLog('info', `Source disabled: ${name}`);
      } else {
        sourceManager?.enableSource(name);
        onLog('info', `Source enabled: ${name}`);
      }
      
      // 保存到 config.json
      saveSourcesToConfig(sourceManager, config);
      
      // 触发状态持久化
      if (statePersistence) {
        await statePersistence.save(true);
      }
      
      res.json({
        success: true,
        message: `Source '${name}' ${wasEnabled ? 'disabled' : 'enabled'}`,
        data: sourceManager?.getSourceSummary(name)
      });
    } catch (err) {
      onLog('error', `Failed to toggle source: ${err.message}`);
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
      
      // 保存到 config.json
      saveSourcesToConfig(sourceManager, config);
      
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
      
      // 保存到 config.json
      saveSourcesToConfig(sourceManager, config);
      
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
      const allowedFields = ['priority', 'enabled', 'rateLimit', 'modelMapping', 'modelMappingStrict', 'cooldownMinutes', 'apiKey', 'baseUrl'];
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
      
      // 保存到 config.json
      saveSourcesToConfig(sourceManager, config);
      
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
   * GET /admin/stats/history
   * 获取历史统计数据
   */
  router.get('/stats/history', (req, res) => {
    try {
      const hours = parseInt(req.query.hours) || 24;
      const days = parseInt(req.query.days) || 7;
      
      res.json({
        success: true,
        data: {
          hourly: statsRecorder?.getHourlyStats(hours) || [],
          daily: statsRecorder?.getDailyStats(days) || [],
          summary: statsRecorder?.getSummary() || {}
        }
      });
    } catch (err) {
      onLog('error', `Failed to get stats history: ${err.message}`);
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
    const uptime = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
    
    res.json({
      success: true,
      status: 'healthy',
      uptime,
      startTime: startTime ? new Date(startTime).toISOString() : null,
      timestamp: new Date().toISOString()
    });
  });
  
  /**
   * POST /admin/reload
   * 手动重载配置
   */
  router.post('/reload', (req, res) => {
    try {
      const newConfig = reloadConfig();
      
      if (newConfig) {
        res.json({
          success: true,
          message: 'Configuration reloaded',
          sourcesCount: newConfig.sources?.length || 0
        });
      } else {
        res.status(500).json({
          success: false,
          error: 'Failed to reload configuration'
        });
      }
    } catch (err) {
      onLog('error', `Failed to reload config: ${err.message}`);
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  });
  
  return router;
}

module.exports = {
  createAdminRouter
};
