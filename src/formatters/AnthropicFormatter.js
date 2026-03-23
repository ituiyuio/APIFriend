'use strict';

const { BaseFormatter } = require('./BaseFormatter');

/**
 * Anthropic 格式化器
 * 负责在 Anthropic Messages API 格式与 OpenAI 格式之间转换
 * 
 * 转换方向：
 * - 请求：Anthropic → OpenAI（发送给上游）
 * - 响应：OpenAI → Anthropic（返回给客户端）
 */
class AnthropicFormatter extends BaseFormatter {
  get format() {
    return 'anthropic';
  }

  matches(req) {
    const path = req.path || req.originalUrl || '';
    return /\/v1\/messages/.test(path);
  }

  getUpstreamHeaders(source, originalHeaders) {
    // Anthropic 请求需要传递 anthropic-version header
    const headers = {};
    if (originalHeaders['anthropic-version']) {
      headers['anthropic-version'] = originalHeaders['anthropic-version'];
    }
    if (originalHeaders['anthropic-beta']) {
      headers['anthropic-beta'] = originalHeaders['anthropic-beta'];
    }
    return headers;
  }

  // ─── 请求转换：Anthropic → OpenAI ───────────────────────────

  transformRequest(anthropicBody) {
    const messages = [];

    // 处理 system
    if (anthropicBody.system) {
      messages.push({
        role: 'system',
        content: anthropicBody.system
      });
    }

    // 处理 messages
    if (anthropicBody.messages && Array.isArray(anthropicBody.messages)) {
      for (const msg of anthropicBody.messages) {
        const content = msg.content;

        if (typeof content === 'string') {
          messages.push({
            role: msg.role,
            content: content
          });
        } else if (Array.isArray(content)) {
          this._convertAnthropicMessageContent(msg, content, messages);
        }
      }
    }

    const openaiBody = {
      model: anthropicBody.model,
      messages: messages,
      stream: anthropicBody.stream || false,
      max_tokens: anthropicBody.max_tokens,
      temperature: anthropicBody.temperature,
      top_p: anthropicBody.top_p,
      stop: anthropicBody.stop_sequences
    };

    // 转换工具定义
    if (anthropicBody.tools && anthropicBody.tools.length > 0) {
      openaiBody.tools = anthropicBody.tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema
        }
      }));
    }

    return openaiBody;
  }

  /**
   * 转换 Anthropic 消息内容（支持多类型内容块）
   */
  _convertAnthropicMessageContent(msg, content, messages) {
    const textParts = content.filter(c => c.type === 'text');
    const toolResults = content.filter(c => c.type === 'tool_result');
    const toolUses = content.filter(c => c.type === 'tool_use');

    // 文本内容
    if (textParts.length > 0) {
      const textContent = textParts.map(c => c.text).join('\n');
      messages.push({
        role: msg.role,
        content: textContent
      });
    }

    // 工具结果 (Anthropic: tool_result → OpenAI: tool role)
    for (const result of toolResults) {
      let resultContent = result.content;
      if (typeof resultContent === 'object') {
        resultContent = JSON.stringify(resultContent);
      }
      messages.push({
        role: 'tool',
        tool_call_id: result.tool_use_id,
        content: resultContent || ''
      });
    }

    // 工具使用 (Anthropic: tool_use in assistant → OpenAI: tool_calls)
    if (toolUses.length > 0 && msg.role === 'assistant') {
      const toolCalls = toolUses.map(tu => ({
        id: tu.id,
        type: 'function',
        function: {
          name: tu.name,
          arguments: typeof tu.input === 'object' ? JSON.stringify(tu.input) : (tu.input || '{}')
        }
      }));

      const assistantMsg = {
        role: 'assistant',
        content: textParts.length > 0 ? textParts.map(c => c.text).join('\n') : null,
        tool_calls: toolCalls
      };
      messages.push(assistantMsg);
    }
  }

  // ─── 响应转换：OpenAI → Anthropic ───────────────────────────

  transformResponse(openaiResponse, requestedModel) {
    const message = openaiResponse.choices?.[0]?.message;
    const inputTokens = openaiResponse.usage?.prompt_tokens || 0;
    const outputTokens = openaiResponse.usage?.completion_tokens || 0;
    const finishReason = openaiResponse.choices?.[0]?.finish_reason;

    const content = [];

    // 添加文本内容
    if (message?.content) {
      content.push({
        type: 'text',
        text: message.content
      });
    }

    // 添加工具调用
    if (message?.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        let input = {};
        try {
          input = JSON.parse(toolCall.function.arguments || '{}');
        } catch (e) {
          input = {};
        }
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input: input
        });
      }
    }

    // 确保至少有一个内容块
    if (content.length === 0) {
      content.push({
        type: 'text',
        text: ''
      });
    }

    // 确定停止原因
    let stopReason = 'end_turn';
    if (finishReason === 'length') {
      stopReason = 'max_tokens';
    } else if (finishReason === 'tool_calls' || message?.tool_calls) {
      stopReason = 'tool_use';
    }

    return {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: requestedModel,
      content: content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens
      }
    };
  }

  formatError(errorType, message, statusCode) {
    return {
      type: 'error',
      error: { type: errorType, message }
    };
  }

  // ─── 流式响应处理 ────────────────────────────────────────────

  async handleStream(res, upstreamResponse, context) {
    const { model, sourceName, startTime, logger, statsRecorder } = context;

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const messageId = `msg_${Date.now()}`;

    // 发送 message_start 事件
    const messageStart = {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: model,
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    };
    res.write(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`);

    let hasStartedContent = false;
    let hasStartedToolUse = false;
    let currentToolCall = null;
    let toolCallIndex = 0;
    let fullText = '';
    let sseBuffer = '';

    try {
      const reader = upstreamResponse.body.getReader();
      const decoder = new TextDecoder();

      const pump = async () => {
        const { done, value } = await reader.read();

        if (done) {
          // 发送结束事件
          if (hasStartedContent) {
            res.write(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`);
          }
          if (hasStartedToolUse) {
            res.write(`event: content_block_stop\ndata: {"type":"content_block_stop","index":${hasStartedContent ? 1 : 0}}\n\n`);
          }
          const stopReason = currentToolCall ? 'tool_use' : 'end_turn';
          res.write(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"${stopReason}"},"usage":{"output_tokens":0}}\n\n`);
          res.write(`event: message_stop\ndata: {}\n\n`);
          res.end();

          const latency = Date.now() - startTime;

          if (statsRecorder) {
            statsRecorder.recordRequest({
              source: sourceName,
              success: true,
              latency: latency
            });
          }

          logger.info('Anthropic proxy request completed', {
            path: '/v1/messages',
            source: sourceName,
            model: model,
            isStream: true,
            duration: latency
          });
          return;
        }

        const chunk = decoder.decode(value, { stream: true });
        fullText += chunk;
        sseBuffer += chunk;

        // 按双换行符分割完整的 SSE 事件，保留最后一个不完整的部分
        const events = sseBuffer.split('\n\n');
        sseBuffer = events.pop() || '';

        // 处理完整的 SSE 事件
        for (const event of events) {
          const lines = event.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (data === '[DONE]') continue;
              if (!data) continue;

              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta;

                // 处理文本内容
                if (delta?.content) {
                  if (!hasStartedContent) {
                    hasStartedContent = true;
                    res.write(`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`);
                  }
                  res.write(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(delta.content)}}}\n\n`);
                }

                // 处理工具调用
                if (delta?.tool_calls && delta.tool_calls.length > 0) {
                  for (const toolCallDelta of delta.tool_calls) {
                    if (toolCallDelta.function?.name) {
                      const blockIndex = hasStartedContent ? 1 : 0;
                      if (!hasStartedToolUse) {
                        hasStartedToolUse = true;
                        toolCallIndex = blockIndex;
                        currentToolCall = {
                          id: toolCallDelta.id || `call_${Date.now()}`,
                          name: toolCallDelta.function.name,
                          arguments: ''
                        };
                        res.write(`event: content_block_start\ndata: ${JSON.stringify({
                          type: "content_block_start",
                          index: blockIndex,
                          content_block: {
                            type: "tool_use",
                            id: currentToolCall.id,
                            name: currentToolCall.name,
                            input: {}
                          }
                        })}\n\n`);
                      }
                    }

                    if (toolCallDelta.function?.arguments) {
                      if (currentToolCall) {
                        currentToolCall.arguments += toolCallDelta.function.arguments;
                      }
                      const blockIndex = hasStartedContent ? 1 : 0;
                      res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                        type: "content_block_delta",
                        index: blockIndex,
                        delta: {
                          type: "input_json_delta",
                          partial_json: toolCallDelta.function.arguments
                        }
                      })}\n\n`);
                    }
                  }
                }
              } catch (e) {
                // 忽略解析错误，可能是不完整的数据
              }
            }
          }
        }

        await pump();
      };

      await pump();

    } catch (err) {
      logger.error('Anthropic stream error', { error: err.message });
      if (!res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: err.message } })}\n\n`);
        res.end();
      }
    }

    return true; // 表示已处理
  }
}

module.exports = { AnthropicFormatter };
