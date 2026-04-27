/**
 * Proxy Service Module - Chat Completions Route
 * Implements /v1/chat/completions route
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { PassThrough } from 'stream'
import { ChatCompletionRequest, ChatCompletionResponse, ProxyContext } from '../types'
import { loadBalancer } from '../loadbalancer'
import { requestForwarder } from '../forwarder'
import { streamHandler } from '../stream'
import { proxyStatusManager } from '../status'
import { modelMapper } from '../modelMapper'
import { storeManager } from '../../store/store'
import { 
  isAnthropicToolFormat,
  transformResponseToAnthropic
} from '../utils/toolFormatConverter'
import {
  createReasoningContentFilterStream,
  reasoningContentFilterEnabled,
  sanitizeOpenAICompatibleResponseBody,
} from '../utils/reasoningContentFilter'
import {
  classifyProviderError,
  sanitizeRuntimeErrorMessage,
} from '../utils/runtimeError'

const router = new Router({ prefix: '/v1/chat' })

/**
 * Generate Request ID
 */
function generateRequestId(): string {
  return `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Get Client IP
 */
function getClientIP(ctx: Context): string {
  return ctx.headers['x-real-ip'] as string ||
    ctx.headers['x-forwarded-for'] as string ||
    ctx.ip ||
    'unknown'
}

/**
 * Extract user input from messages (last user message, full content)
 */
function extractUserInput(messages: Array<{ role: string; content?: string | any[] | null }>): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user' && msg.content) {
      let content = ''
      if (typeof msg.content === 'string') {
        content = msg.content
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter((p: any) => p.type === 'text')
        if (textParts.length > 0) {
          content = textParts.map((p: any) => p.text || '').join(' ')
        }
      }
      if (content) {
        return content
      }
    }
  }
  return undefined
}

/**
 * Handle Chat Completions Request
 */
router.post('/completions', async (ctx: Context) => {
  const startTime = Date.now()
  const requestId = generateRequestId()
  const clientIP = getClientIP(ctx)

  let request: ChatCompletionRequest
  try {
    request = ctx.request.body as ChatCompletionRequest
  } catch (error) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Invalid request body',
        type: 'invalid_request_error',
        param: null,
        code: null,
      },
    }
    return
  }

  if (!request.model) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Missing required field: model',
        type: 'invalid_request_error',
        param: 'model',
        code: null,
      },
    }
    return
  }

  if (!request.messages || !Array.isArray(request.messages) || request.messages.length === 0) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Missing required field: messages',
        type: 'invalid_request_error',
        param: 'messages',
        code: null,
      },
    }
    return
  }

  // Read feature parameters from Headers (lower priority than request body)
  const webSearchFromHeader = ctx.headers['x-web-search'] === 'true'
  const reasoningEffortFromHeader = ctx.headers['x-reasoning-effort'] as 'low' | 'medium' | 'high' | undefined
  const deepResearchFromHeader = ctx.headers['x-deep-research'] === 'true'

  // Handle reasoningEffort (camelCase) from AI SDK - convert to reasoning_effort (snake_case)
  const requestAny = request as any
  if (requestAny.reasoningEffort && !request.reasoning_effort) {
    request.reasoning_effort = requestAny.reasoningEffort
    console.log('[Chat] Reasoning effort set via reasoningEffort (camelCase):', requestAny.reasoningEffort)
    delete requestAny.reasoningEffort
  }

  // Merge into request (request body parameters take priority)
  if (webSearchFromHeader && request.web_search === undefined) {
    request.web_search = true
    console.log('[Chat] Web search enabled via X-Web-Search header')
  }
  if (reasoningEffortFromHeader && request.reasoning_effort === undefined) {
    request.reasoning_effort = reasoningEffortFromHeader
    console.log('[Chat] Reasoning effort set via X-Reasoning-Effort header:', reasoningEffortFromHeader)
  }
  if (deepResearchFromHeader && request.deep_research === undefined) {
    request.deep_research = true
    console.log('[Chat] Deep research enabled via X-Deep-Research header')
  }

  const config = storeManager.getConfig()
  const preferredProviderId = modelMapper.getPreferredProvider(request.model)
  const preferredAccountId = modelMapper.getPreferredAccount(request.model)

  const selection = loadBalancer.selectAccount(
    request.model,
    config.loadBalanceStrategy,
    preferredProviderId,
    preferredAccountId
  )

  if (!selection) {
    ctx.status = 503
    ctx.body = {
      error: {
        message: `No available account for model: ${request.model}`,
        type: 'service_unavailable_error',
        param: null,
        code: 'no_available_account',
      },
    }
    return
  }

  const { account, provider, actualModel } = selection

  const context: ProxyContext = {
    requestId,
    providerId: provider.id,
    accountId: account.id,
    model: request.model,
    actualModel,
    startTime,
    isStream: request.stream || false,
    clientIP,
  }

  proxyStatusManager.recordRequestStart(request.model, provider.id, account.id)

  try {
    const result = await requestForwarder.forwardChatCompletion(
      request,
      account,
      provider,
      actualModel,
      context
    )

    const latency = Date.now() - startTime

    if (!result.success) {
      proxyStatusManager.recordRequestFailure(latency)
      const sanitizedErrorMessage = sanitizeRuntimeErrorMessage(result.error || 'Request failed')
      const errorCategory = classifyProviderError(provider.id, {
        status: result.status,
        message: sanitizedErrorMessage,
      })

      if (errorCategory === 'credential_error') {
        loadBalancer.markAccountFailed(account.id)
      }

      const now = Date.now()
      const runtimeFailureUpdates = {
        lastRuntimeFailureAt: now,
        lastRuntimeErrorCode: errorCategory,
        lastRuntimeErrorMessage: sanitizedErrorMessage,
        runtimeFailureCount: (account.runtimeFailureCount || 0) + 1,
      }

      if (errorCategory === 'credential_error') {
        storeManager.updateAccount(account.id, {
          ...runtimeFailureUpdates,
          healthStatus: 'invalid',
        })
      } else if (errorCategory === 'model_invalid') {
        storeManager.updateAccount(account.id, runtimeFailureUpdates)
      } else {
        storeManager.updateAccount(account.id, runtimeFailureUpdates)
      }

      storeManager.markModelRuntimeFailure(
        provider.id,
        request.model,
        actualModel,
        errorCategory,
        sanitizedErrorMessage,
      )

      ctx.status = result.status || 500
      ctx.body = {
        error: {
          message: sanitizedErrorMessage,
          type: 'api_error',
          param: null,
          code: errorCategory,
        },
      }

      storeManager.addLog('error', `Request failed: ${sanitizedErrorMessage}`, {
        requestId,
        providerId: provider.id,
        accountId: account.id,
        model: request.model,
        actualModel,
        errorCategory,
        status: result.status,
        errorMessage: sanitizedErrorMessage,
        latency,
      })

      const userInput = extractUserInput(request.messages)
      const errorResponseBody = JSON.stringify({
        error: {
          message: sanitizedErrorMessage,
          type: 'api_error',
          param: null,
          code: errorCategory,
        },
      })
      storeManager.addRequestLog({
        timestamp: startTime,
        status: 'error',
        statusCode: result.status || 500,
        method: 'POST',
        url: '/v1/chat/completions',
        model: request.model,
        actualModel,
        providerId: provider.id,
        providerName: provider.name,
        accountId: account.id,
        accountName: account.name,
        requestBody: JSON.stringify(request),
        userInput,
        webSearch: request.web_search,
        reasoningEffort: request.reasoning_effort,
        responseStatus: result.status || 500,
        responseBody: errorResponseBody,
        latency,
        isStream: request.stream || false,
        errorMessage: sanitizedErrorMessage,
      })

      storeManager.recordRequestInStats(false, latency, request.model, provider.id, account.id)

      return
    }

    loadBalancer.clearAccountFailure(account.id)

    proxyStatusManager.recordRequestSuccess(latency)

    storeManager.updateAccount(account.id, {
      lastUsed: Date.now(),
      requestCount: (account.requestCount || 0) + 1,
      todayUsed: (account.todayUsed || 0) + 1,
      healthStatus: 'active',
      lastRuntimeSuccessAt: Date.now(),
      lastRuntimeErrorCode: undefined,
      lastRuntimeErrorMessage: undefined,
    })
    storeManager.markModelRuntimeSuccess(provider.id, request.model, actualModel)

    storeManager.addLog('info', `Request succeeded`, {
      requestId,
      providerId: provider.id,
      accountId: account.id,
      model: request.model,
      actualModel,
      latency,
      isStream: request.stream,
    })

    const userInput = extractUserInput(request.messages)
    const sanitizedResponseBody = !request.stream && result.body
      ? sanitizeOpenAICompatibleResponseBody(result.body)
      : result.body

    // Prepare response body for logging (only for non-stream requests)
    const responseBodyForLog = !request.stream && sanitizedResponseBody
      ? JSON.stringify(sanitizedResponseBody)
      : undefined

    // For streaming requests, we'll collect content and update the log later
    let logEntryId: string | undefined

    if (!request.stream) {
      // Non-streaming: record log with response body now
      const logEntry = storeManager.addRequestLog({
        timestamp: startTime,
        status: 'success',
        statusCode: 200,
        method: 'POST',
        url: '/v1/chat/completions',
        model: request.model,
        actualModel,
        providerId: provider.id,
        providerName: provider.name,
        accountId: account.id,
        accountName: account.name,
        requestBody: JSON.stringify(request),
        userInput,
        webSearch: request.web_search,
        reasoningEffort: request.reasoning_effort,
        responseStatus: 200,
        responseBody: responseBodyForLog,
        latency,
        isStream: false,
      })
      logEntryId = logEntry.id
    } else {
      // Streaming: record log now, will update response body later
      const logEntry = storeManager.addRequestLog({
        timestamp: startTime,
        status: 'success',
        statusCode: 200,
        method: 'POST',
        url: '/v1/chat/completions',
        model: request.model,
        actualModel,
        providerId: provider.id,
        providerName: provider.name,
        accountId: account.id,
        accountName: account.name,
        requestBody: JSON.stringify(request),
        userInput,
        webSearch: request.web_search,
        reasoningEffort: request.reasoning_effort,
        responseStatus: 200,
        latency,
        isStream: true,
      })
      logEntryId = logEntry.id
    }

    storeManager.recordRequestInStats(true, latency, request.model, provider.id, account.id)

    if (request.stream === true && result.stream) {
      ctx.set('Content-Type', 'text/event-stream')
      ctx.set('Cache-Control', 'no-cache')
      ctx.set('Connection', 'keep-alive')
      ctx.set('X-Accel-Buffering', 'no')

      // Create a wrapper stream to handle errors and collect content
      const wrapperStream = new PassThrough()

      // Collect stream content for logging (raw SSE output)
      let collectedContent = ''

      // Handle stream errors
      result.stream.once('error', (err: Error) => {
        const sanitizedErrorMessage = sanitizeRuntimeErrorMessage(err.message)
        const errorCategory = classifyProviderError(provider.id, {
          message: sanitizedErrorMessage,
        })
        console.error('[Chat] Stream error:', sanitizedErrorMessage)

        // Send error as SSE event
        const errorEvent = {
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: actualModel,
          choices: [{
            index: 0,
            delta: {
              content: `\n\n[Error: ${sanitizedErrorMessage}]`,
            },
            finish_reason: 'stop',
          }],
        }

        wrapperStream.write(`data: ${JSON.stringify(errorEvent)}\n\n`)
        wrapperStream.write('data: [DONE]\n\n')
        wrapperStream.end()

        storeManager.addLog('error', `Stream error: ${sanitizedErrorMessage}`, {
          requestId,
          providerId: provider.id,
          accountId: account.id,
          model: request.model,
          actualModel,
          errorCategory,
          errorMessage: sanitizedErrorMessage,
        })
      })

      const reasoningFilterStream = reasoningContentFilterEnabled
        ? createReasoningContentFilterStream()
        : null

      // Check if stream is already in correct SSE format (from adapters like Kimi, GLM, DeepSeek)
      if (result.skipTransform) {
        // Stream is already formatted
        const outputStream = reasoningFilterStream || result.stream

        outputStream.on('data', (chunk: Buffer) => {
          collectedContent += chunk.toString()
        })

        if (reasoningFilterStream) {
          result.stream.pipe(reasoningFilterStream)
        }
        outputStream.pipe(wrapperStream, { end: false })

        // When source stream ends normally, update log and end wrapper
        outputStream.once('end', () => {
          // Update log with collected response
          if (logEntryId) {
            storeManager.updateRequestLog(logEntryId, {
              responseBody: collectedContent || undefined,
            })
          }
          wrapperStream.end()
        })
      } else {
        // Need to transform the stream
        const transformStream = streamHandler.createTransformStream(
          actualModel,
          requestId,
          () => {
            storeManager.addLog('debug', `Stream response completed`, { requestId })
          }
        )

        const outputStream = reasoningFilterStream || transformStream

        // Collect from transformed stream output
        outputStream.on('data', (chunk: Buffer) => {
          collectedContent += chunk.toString()
        })

        result.stream.pipe(transformStream)
        if (reasoningFilterStream) {
          transformStream.pipe(reasoningFilterStream)
        }
        outputStream.pipe(wrapperStream, { end: false })

        outputStream.once('end', () => {
          // Update log with collected response
          if (logEntryId) {
            storeManager.updateRequestLog(logEntryId, {
              responseBody: collectedContent || undefined,
            })
          }
          wrapperStream.end()
        })
      }

      ctx.body = wrapperStream
    } else {
      ctx.set('Content-Type', 'application/json')

      if (result.body) {
        // Check if we need to transform to Anthropic format
        if (isAnthropicToolFormat(request.tool_format)) {
          ctx.body = transformResponseToAnthropic(sanitizedResponseBody)
          console.log('[Chat] Transformed response to Anthropic tool format')
        } else {
          ctx.body = sanitizedResponseBody
        }
      } else {
        ctx.body = {
          id: requestId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: actualModel,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
            },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        }
      }
    }
  } catch (error) {
    const latency = Date.now() - startTime
    proxyStatusManager.recordRequestFailure(latency)

    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const sanitizedErrorMessage = sanitizeRuntimeErrorMessage(errorMessage)
    const errorCategory = classifyProviderError(provider.id, {
      message: sanitizedErrorMessage,
    })
    const errorStack = error instanceof Error ? error.stack : undefined

    ctx.status = 500
    ctx.body = {
      error: {
        message: sanitizedErrorMessage,
        type: 'api_error',
        param: null,
        code: errorCategory,
      },
    }

    storeManager.updateAccount(account.id, {
      ...(errorCategory === 'credential_error' ? { healthStatus: 'invalid' as const } : {}),
      lastRuntimeFailureAt: Date.now(),
      lastRuntimeErrorCode: errorCategory,
      lastRuntimeErrorMessage: sanitizedErrorMessage,
      runtimeFailureCount: (account.runtimeFailureCount || 0) + 1,
    })
    storeManager.markModelRuntimeFailure(provider.id, request.model, actualModel, errorCategory, sanitizedErrorMessage)

    storeManager.addLog('error', `Request exception: ${sanitizedErrorMessage}`, {
      requestId,
      providerId: provider.id,
      accountId: account.id,
      model: request.model,
      actualModel,
      errorCategory,
      errorMessage: sanitizedErrorMessage,
      latency,
      status: 500,
    })

    const userInput = extractUserInput(request.messages)
    const exceptionResponseBody = JSON.stringify({
      error: {
        message: sanitizedErrorMessage,
        type: 'api_error',
        param: null,
        code: errorCategory,
      },
    })
    storeManager.addRequestLog({
      timestamp: startTime,
      status: 'error',
      statusCode: 500,
      method: 'POST',
      url: '/v1/chat/completions',
      model: request.model,
      actualModel,
      providerId: provider.id,
      providerName: provider.name,
      accountId: account.id,
      accountName: account.name,
      requestBody: JSON.stringify(request),
      userInput,
      webSearch: request.web_search,
      reasoningEffort: request.reasoning_effort,
      responseStatus: 500,
      responseBody: exceptionResponseBody,
      latency,
      isStream: request.stream || false,
      errorMessage: sanitizedErrorMessage,
      errorStack,
    })

    storeManager.recordRequestInStats(false, latency, request.model, provider.id, account.id)
  }
})

export default router
