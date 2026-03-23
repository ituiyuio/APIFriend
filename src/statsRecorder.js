/**
 * 统计记录器模块
 * 自动收集和记录请求频率、总量等历史数据
 */

class StatsRecorder {
  /**
   * @param {Object} options - 配置选项
   * @param {number} options.maxHours - 保留小时数据的小时数
   * @param {number} options.maxDays - 保留天数
   */
  constructor(options = {}) {
    this.maxHours = options.maxHours || 24;  // 保留24小时
    this.maxDays = options.maxDays || 30;    // 保留30天
    
    // 历史数据
    this.hourlyStats = new Map();  // timestamp -> Stats
    this.dailyStats = new Map();   // date -> Stats
    
    // 当前小时/天的缓存
    this.currentHourKey = null;
    this.currentDayKey = null;
    
    // 启动定时任务
    this.startPeriodicTasks();
  }

  /**
   * 获取当前小时键
   */
  getCurrentHourKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:00`;
  }

  /**
   * 获取当前天键
   */
  getCurrentDayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  /**
   * 记录请求
   * @param {Object} data - 请求数据
   * @param {string} data.source - 源名称
   * @param {boolean} data.success - 是否成功
   * @param {number} data.tokens - Token 数量
   * @param {number} data.latency - 延迟（毫秒）
   */
  recordRequest(data) {
    const hourKey = this.getCurrentHourKey();
    const dayKey = this.getCurrentDayKey();
    
    // 更新小时统计
    if (!this.hourlyStats.has(hourKey)) {
      this.hourlyStats.set(hourKey, this.createEmptyStats());
    }
    const hourStats = this.hourlyStats.get(hourKey);
    this.incrementStats(hourStats, data);
    
    // 更新天统计
    if (!this.dailyStats.has(dayKey)) {
      this.dailyStats.set(dayKey, this.createEmptyStats());
    }
    const dayStats = this.dailyStats.get(dayKey);
    this.incrementStats(dayStats, data);
    
    this.currentHourKey = hourKey;
    this.currentDayKey = dayKey;
  }

  /**
   * 创建空统计对象
   */
  createEmptyStats() {
    return {
      totalRequests: 0,
      successCount: 0,
      failureCount: 0,
      totalTokens: 0,
      totalLatency: 0,
      bySource: {}
    };
  }

  /**
   * 增量统计
   */
  incrementStats(stats, data) {
    stats.totalRequests++;
    
    if (data.success) {
      stats.successCount++;
    } else {
      stats.failureCount++;
    }
    
    if (data.tokens) {
      stats.totalTokens += data.tokens;
    }
    
    if (data.latency) {
      stats.totalLatency += data.latency;
    }
    
    // 按源统计
    if (data.source) {
      if (!stats.bySource[data.source]) {
        stats.bySource[data.source] = {
          requests: 0,
          success: 0,
          failure: 0,
          tokens: 0
        };
      }
      stats.bySource[data.source].requests++;
      if (data.success) {
        stats.bySource[data.source].success++;
      } else {
        stats.bySource[data.source].failure++;
      }
      if (data.tokens) {
        stats.bySource[data.source].tokens += data.tokens;
      }
    }
  }

  /**
   * 获取小时统计数据
   * @param {number} hours - 获取最近 N 小时
   */
  getHourlyStats(hours = 24) {
    const result = [];
    const now = new Date();
    
    for (let i = hours - 1; i >= 0; i--) {
      const hour = new Date(now.getTime() - i * 60 * 60 * 1000);
      const key = `${hour.getFullYear()}-${String(hour.getMonth() + 1).padStart(2, '0')}-${String(hour.getDate()).padStart(2, '0')} ${String(hour.getHours()).padStart(2, '0')}:00`;
      
      result.push({
        time: key,
        hour: hour.getHours(),
        ...(this.hourlyStats.get(key) || this.createEmptyStats())
      });
    }
    
    return result;
  }

  /**
   * 获取天统计数据
   * @param {number} days - 获取最近 N 天
   */
  getDailyStats(days = 7) {
    const result = [];
    const now = new Date();
    
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
      
      result.push({
        date: key,
        dayOfWeek: day.getDay(),
        ...(this.dailyStats.get(key) || this.createEmptyStats())
      });
    }
    
    return result;
  }

  /**
   * 获取汇总统计
   */
  getSummary() {
    const now = new Date();
    const hourKey = this.getCurrentHourKey();
    const dayKey = this.getCurrentDayKey();
    
    const hourStats = this.hourlyStats.get(hourKey) || this.createEmptyStats();
    const dayStats = this.dailyStats.get(dayKey) || this.createEmptyStats();
    
    // 计算总请求量
    let totalRequests = 0;
    let totalSuccess = 0;
    let totalFailure = 0;
    
    for (const stats of this.dailyStats.values()) {
      totalRequests += stats.totalRequests;
      totalSuccess += stats.successCount;
      totalFailure += stats.failureCount;
    }
    
    return {
      currentHour: {
        requests: hourStats.totalRequests,
        success: hourStats.successCount,
        failure: hourStats.failureCount,
        tokens: hourStats.totalTokens,
        avgLatency: hourStats.totalRequests > 0 
          ? Math.round(hourStats.totalLatency / hourStats.totalRequests) 
          : 0
      },
      today: {
        requests: dayStats.totalRequests,
        success: dayStats.successCount,
        failure: dayStats.failureCount,
        tokens: dayStats.totalTokens,
        avgLatency: dayStats.totalRequests > 0 
          ? Math.round(dayStats.totalLatency / dayStats.totalRequests) 
          : 0
      },
      allTime: {
        requests: totalRequests,
        success: totalSuccess,
        failure: totalFailure
      }
    };
  }

  /**
   * 启动定时任务
   */
  startPeriodicTasks() {
    // 每小时清理旧数据
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldData();
    }, 60 * 60 * 1000);  // 每小时检查一次
    
    // 注意：不在此处执行首次清理，等待 import 完成后再清理
  }

  /**
   * 清理过期数据
   */
  cleanupOldData() {
    const now = new Date();
    
    // 清理小时数据
    const cutoffHour = new Date(now.getTime() - this.maxHours * 60 * 60 * 1000);
    for (const [key] of this.hourlyStats) {
      // 使用本地时区解析时间字符串
      const hourDate = this.parseLocalDateTime(key);
      if (hourDate < cutoffHour) {
        this.hourlyStats.delete(key);
      }
    }
    
    // 清理天数据
    const cutoffDay = new Date(now.getTime() - this.maxDays * 24 * 60 * 60 * 1000);
    for (const [key] of this.dailyStats) {
      // 使用本地时区解析日期字符串
      const dayDate = this.parseLocalDate(key);
      if (dayDate < cutoffDay) {
        this.dailyStats.delete(key);
      }
    }
  }

  /**
   * 解析本地日期时间字符串 (格式: "2026-03-22 05:00")
   * @param {string} key - 时间键
   * @returns {Date} 本地时间的 Date 对象
   */
  parseLocalDateTime(key) {
    const match = key.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
    if (!match) return new Date(key);
    const [, year, month, day, hour, minute] = match.map(Number);
    return new Date(year, month - 1, day, hour, minute);
  }

  /**
   * 解析本地日期字符串 (格式: "2026-03-22")
   * @param {string} key - 日期键
   * @returns {Date} 本地时间的 Date 对象
   */
  parseLocalDate(key) {
    const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return new Date(key);
    const [, year, month, day] = match.map(Number);
    return new Date(year, month - 1, day, 0, 0, 0);
  }

  /**
   * 导出数据（用于持久化）
   */
  export() {
    return {
      hourly: Object.fromEntries(this.hourlyStats),
      daily: Object.fromEntries(this.dailyStats)
    };
  }

  /**
   * 导入数据（用于恢复）
   */
  import(data) {
    if (data.hourly) {
      this.hourlyStats = new Map(Object.entries(data.hourly));
    }
    if (data.daily) {
      this.dailyStats = new Map(Object.entries(data.daily));
    }
    
    // 导入后执行一次清理，移除过期数据
    this.cleanupOldData();
  }

  /**
   * 停止定时任务
   */
  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

module.exports = { StatsRecorder };
