'use strict';

const { isStreamRequest, isStreamResponse, getErrorType } = require('../proxy');

/**
 * 统一代理服务
 * 
 * 职责：
 * - 格式检测与请求转换
 * - 源选择与故障转移
 * - 统一的重试逻辑（消除 _handleProxyRequest / _handleAnthropicRequest 的重复）
 * - 响应转换与流式处理
 * 
 * 所有 API 格式的代理请求都通过此类处理。
 * 添加新格式只需实现 Formatter 并注册到 FormatterRegistry，无需修改此类。
 */
class ProxyService {
  /**
   * @param {Object} deps
   * @param {import('../sourceManager').SourceManager} deps.sourceManager
   * @param {import('../formatters/FormatterRegistry').FormatterRegistry} deps.formatterRegistry
   * @param {import('../proxy').Proxy} deps.proxy - Proxy 实例（用于 forward 方法）
   * @param {Object} deps.failoverConfig
   * @param {import('../logger').Logger} deps.logger
   * @param {import('../statsRecorder').StatsRecorder} [deps.statsRecorder]
   * @param {import('../rateLimiter').RateLimiter} [deps.rateLimiter]
   */
  constructor({ sourceManager, formatterRegistry, proxy, failoverConfig, logger, statsRecorder, rateLimiter }) {
    this.sourceManager = sourceManager;
    this.formatterRegistry = formatterRegistry;
    this.proxy = proxy;
    this.failoverConfig = failoverConfig || { timeoutMs: 15000, maxRetries: 3, retryDelayMs: 1000 };
    this.logger = logger;
    this.statsRecorder = statsRecorder;
    this.rateLimiter = rateLimiter;
  }

  /**
   * 处理代理请求（统一入口）
   * @param {Object} req - Express 请求对象
   * @param {Object} res - Express 响应对象
   */
  async handleRequest(req, res) {
    const startTime = Date.now();

    // 1. 匹配格式化器
    const formatter = this.formatterRegistry.resolve(req);
    if (!formatter) {
      return res.status(400).json({
        error: { type: 'unsupported_format', message: `No formatter found for path: ${req.path}` }
      });
    }

    // 2. 转换请求体
    const requestedModel = req.body?.model;
    const transformedBody = formatter.transformRequest(req.body);
    const isStream = isStreamRequest(transformedBody);

    // 3. 重试循环
    const maxRetries = this.failoverConfig.maxRetries || 3;
    const retryDelayMs = this.failoverConfig.retryDelayMs || 1000;
    let currentSource = null;
    let retryCount = 0;

    while (retryCount < maxRetries) {
      // 选择源
      if (!currentSource) {
        currentSource = this.sourceManager.selectSource(requestedModel);
        if (!currentSource) {
          return res.status(503).json(formatter.formatError(
            'no_available_source',
            'No available source found',
            503
          ));
        }
      }

      // 构建上游请求
      const upstreamHeaders = formatter.getUpstreamHeaders(currentSource.source, req.headers);
      const bodyWithMappedModel = {
        ...transformedBody,
        model: currentSource.mappedModel || transformedBody.model
      };

      try {
        const result = await this.proxy.forward(
          currentSource.source,
          '/chat/completions',
          'POST',
          bodyWithMappedModel,
          { 'content-type': 'application/json', ...upstreamHeaders }
        );

        if (result.success) {
          // 标记源成功
          this.sourceManager.markSuccess(currentSource.source.name);

          // 流式响应
          if (isStream && isStreamResponse(result.response)) {
            const handled = await formatter.handleStream(res, result.response, {
              model: requestedModel,
              sourceName: currentSource.source.name,
              startTime,
              logger: this.logger,
              statsRecorder: this.statsRecorder,
              rateLimiter: this.rateLimiter
            });

            if (!handled) {
              // OpenAI 格式：透传流式响应
              await this._passthroughStream(res, result.response, {
                model: requestedModel,
                sourceName: currentSource.source.name,
                startTime
              });
            }
            return;
          }

          // 非流式响应
          await this._handleNonStreamResponse(res, result.response, formatter, {
            model: requestedModel,
            sourceName: currentSource.source.name,
            startTime
          });
          return;
        }

        // 请求失败
        const errorType = result.errorType || getErrorType(result.response);
        this.sourceManager.markFailure(currentSource.source.name, errorType, {
          error: result.error,
          message: result.message
        });

        // 认证错误不重试
        if (errorType === 'auth_error') {
          this.logger.error('Auth error, not retrying', {
            source: currentSource.source.name,
            error: result.error
          });
          if (!res.headersSent) {
            return res.status(result.response?.status || 502).json(formatter.formatError(
              errorType,
              result.message || result.error || 'Authentication failed',
              result.response?.status || 502
            ));
          }
          return;
        }

        // 选择下一个源
        const nextSource = this.sourceManager.selectNextSource(currentSource.source.name, requestedModel);
        if (!nextSource) {
          this.logger.error('All sources failed', { model: requestedModel });
          if (!res.headersSent) {
            return res.status(503).json(formatter.formatError(
              'all_sources_failed',
              'All sources are unavailable',
              503
            ));
          }
          return;
        }

        currentSource = nextSource;
        retryCount++;

        this.logger.warn('Retrying with next source', {
          from: currentSource.source.name,
          retryCount,
          maxRetries
        });

        if (retryDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        }

      } catch (err) {
        // 网络错误等异常
        this.sourceManager.markFailure(currentSource.source.name, 'network_error', {
          error: err.message
        });

        this.logger.warn('Request error, retrying', {
          source: currentSource.source.name,
          error: err.message,
          retryCount
        });

        const nextSource = this.sourceManager.selectNextSource(currentSource.source.name, requestedModel);
        if (!nextSource) {
          if (!res.headersSent) {
            return res.status(502).json(formatter.formatError(
              'proxy_error',
              err.message,
              502
            ));
          }
          return;
        }

        currentSource = nextSource;
        retryCount++;

        if (retryDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        }
      }
    }

    // 超过最大重试次数
    if (!res.headersSent) {
      return res.status(503).json(formatter.formatError(
        'max_retries_exceeded',
        `Failed after ${maxRetries} retries`,
        503
      ));
    }
  }

  /**
   * 处理非流式响应
   */
  async _handleNonStreamResponse(res, upstreamResponse, formatter, context) {
    try {
      const body = await upstreamResponse.json();
      const clientResponse = formatter.transformResponse(body, context.model);

      const latency = Date.now() - context.startTime;
      const tokens = (body.usage?.prompt_tokens || 0) + (body.usage?.completion_tokens || 0);

      if (this.statsRecorder) {
        this.statsRecorder.recordRequest({
          source: context.sourceName,
          success: true,
          tokens,
          latency
        });
      }

      this.logger.info('Proxy request completed', {
        path: '/v1/chat/completions',
        source: context.sourceName,
        model: context.model,
        isStream: false,
        duration: latency
      });

      res.json(clientResponse);
    } catch (err) {
      this.logger.error('Response parse error', { error: err.message });
      if (!res.headersSent) {
        res.status(502).json(formatter.formatError(
          'response_parse_error',
          err.message,
          502
        ));
      }
    }
  }

  /**
   * 透传流式响应（OpenAI 格式默认行为）
   */
  async _passthroughStream(res, upstreamResponse, context) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    try {
      const reader = upstreamResponse.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';

      const pump = async () => {
        const { done, value } = await reader.read();

        if (done) {
          res.end();

          const latency = Date.now() - context.startTime;
          if (this.statsRecorder) {
            const estimatedTokens = this.rateLimiter?.estimateTokens(fullText) || 0;
            this.statsRecorder.recordRequest({
              source: context.sourceName,
              success: true,
              tokens: estimatedTokens,
              latency
            });
          }

          this.logger.info('Proxy request completed', {
            path: '/v1/chat/completions',
            source: context.sourceName,
            model: context.model,
            isStream: true,
            duration: latency
          });
          return;
        }

        const chunk = decoder.decode(value, { stream: true });
        fullText += chunk;

        if (!res.writableEnded) {
          res.write(chunk);
        }

        await pump();
      };

      await pump();
    } catch (err) {
      this.logger.error('Stream error', { error: err.message });
      if (!res.writableEnded) {
        const errorEvent = `data: ${JSON.stringify({
          error: { message: `APIFriend: Upstream stream interrupted: ${err.message}` }
        })}\n\n`;
        res.write(errorEvent);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
  }
}

module.exports = { ProxyService };
