import axios, { AxiosError } from 'axios'

export type GlmProbeResult = {
  credentialValid: boolean
  connectivityValid: boolean
  sseChunkReceived: boolean
  visibleContentExtracted: boolean
  warning?: string
  errorCode?: string
  errorMessage?: string
}

const GLM_SSE_URL = 'https://bigmodel.cn/api/biz/trial/response/v4/sse/11989'

const GLM_PROBE_BODY = {
  model: 'glm-5.1',
  modelId: 11989,
  stream: true,
  thinking: { type: 'enabled' },
  max_tokens: 65536,
  temperature: 1,
  top_p: 0.95,
  tools: [{
    type: 'web_search',
    web_search: {
      search_engine: 'search_std',
      search_recency_filter: 'noLimit',
      count: 10,
      search_intent: false,
      search_domain_filter: '',
      content_size: 'medium',
    },
    extraMcpData: [],
  }],
  prompt: [{ role: 'user', content: '只回复 glm-ok', fileContentList: [] }],
}

export async function runGlmBigModelSseProbe(
  credentials: Record<string, any>,
  timeoutMs: number,
): Promise<GlmProbeResult> {
  const authorization = credentials.authorization
  const bigmodelOrganization = credentials.bigmodelOrganization
  const bigmodelProject = credentials.bigmodelProject

  if (!authorization || !bigmodelOrganization || !bigmodelProject) {
    return {
      credentialValid: false,
      connectivityValid: false,
      sseChunkReceived: false,
      visibleContentExtracted: false,
      errorCode: 'credential_error',
      errorMessage: 'GLM requires Authorization, Bigmodel Organization, and Bigmodel Project.',
    }
  }

  try {
    const response = await axios.post(GLM_SSE_URL, GLM_PROBE_BODY, {
      headers: {
        Authorization: authorization,
        'Bigmodel-Organization': bigmodelOrganization,
        'Bigmodel-Project': bigmodelProject,
        Origin: 'https://bigmodel.cn',
        Referer: 'https://bigmodel.cn/trialcenter/modeltrial/text?modelCode=glm-5.1',
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'Set-Language': 'zh',
      },
      timeout: timeoutMs,
      responseType: 'stream',
      validateStatus: () => true,
    })

    const contentType = String(response.headers['content-type'] || '')
    if (response.status === 401 || response.status === 403) {
      return { credentialValid: false, connectivityValid: false, sseChunkReceived: false, visibleContentExtracted: false, errorCode: 'credential_error', errorMessage: `Validation failed: HTTP ${response.status}` }
    }
    if (response.status === 500) {
      return { credentialValid: false, connectivityValid: false, sseChunkReceived: false, visibleContentExtracted: false, errorCode: 'credential_error', errorMessage: 'Validation failed: missing Bigmodel-Organization or Bigmodel-Project' }
    }
    if (response.status !== 200 || !contentType.includes('text/event-stream')) {
      return { credentialValid: false, connectivityValid: false, sseChunkReceived: false, visibleContentExtracted: false, errorCode: 'connection_error', errorMessage: `Validation failed: HTTP ${response.status}` }
    }

    const summary = await new Promise<{ received: boolean; hasVisibleContent: boolean; hasThinking: boolean }>((resolve) => {
      let settled = false
      let hasVisibleContent = false
      let hasThinking = false
      let buffer = ''
      const done = (value: boolean) => {
        if (settled) return
        settled = true
        resolve({ received: value, hasVisibleContent, hasThinking })
      }
      const stream = response.data
      stream.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString()
        buffer += text
        if (text.includes('thinking') || text.includes('reasoning')) hasThinking = true
        if (text.includes('"content"') && text.includes('"text"')) hasVisibleContent = true
        if (buffer.includes('data:') || buffer.includes('event:')) done(true)
      })
      stream.once('end', () => done(false))
      stream.once('error', () => done(false))
      setTimeout(() => done(false), Math.min(timeoutMs, 20_000))
    })

    if (!summary.received) {
      return {
        credentialValid: true,
        connectivityValid: false,
        sseChunkReceived: false,
        visibleContentExtracted: false,
        warning: 'GLM 健康检测超时：未在检测窗口内收到 SSE 响应。账号凭证未被判定为无效。',
        errorCode: 'health_timeout',
      }
    }

    return {
      credentialValid: true,
      connectivityValid: true,
      sseChunkReceived: true,
      visibleContentExtracted: summary.hasVisibleContent,
      ...(summary.hasThinking && !summary.hasVisibleContent
        ? { warning: 'GLM 连接正常，已收到思考流，但未解析到最终可见正文。' }
        : {}),
    }
  } catch (error) {
    return {
      credentialValid: true,
      connectivityValid: false,
      sseChunkReceived: false,
      visibleContentExtracted: false,
      errorCode: 'connection_error',
      errorMessage: error instanceof AxiosError ? error.message : 'Connection failed',
    }
  }
}
