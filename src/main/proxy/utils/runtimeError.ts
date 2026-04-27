import type { RuntimeErrorCode } from '../../store/types'

const CREDENTIAL_TERMS = [
  'credential',
  'token',
  'session',
  'login',
  'auth',
  'unauthorized',
  'forbidden',
]

const MODEL_TERMS = [
  'model not found',
  'invalid model',
  'unsupported model',
  'unavailable model',
  'model removed',
]

const MODEL_HINTS = ['model', '模型']

const CONNECTION_TERMS = [
  'timeout',
  'socket timeout',
  'request timeout',
  'etimedout',
  'econnaborted',
  'econnreset',
  'enotfound',
  'eai_again',
  'network error',
  'connection reset',
  'upstream connect',
  'dns',
]

const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  [/https?:\/\/[^\s"'<>]+/gi, '[redacted_url]'],
  [/(service_token|ph_token|apikey|api_key|refresh_token|ticket|sessiontoken|token|cookie|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]'],
  [/(bearer\s+)[a-z0-9._-]+/gi, '$1[redacted]'],
]

export interface RuntimeErrorContext {
  status?: number
  message?: string
  error?: unknown
}

export function sanitizeRuntimeErrorMessage(message?: string): string {
  if (!message) return 'Request failed'

  let sanitized = message
  for (const [pattern, replacement] of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement)
  }

  return sanitized.slice(0, 500)
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some(term => text.includes(term))
}

export function classifyRuntimeError(ctx: RuntimeErrorContext): RuntimeErrorCode {
  const lowerMessage = (ctx.message || '').toLowerCase()

  if (ctx.status === 401 || ctx.status === 403) return 'credential_error'
  if (containsAny(lowerMessage, CREDENTIAL_TERMS)) return 'credential_error'

  if (ctx.status === 404 && containsAny(lowerMessage, MODEL_HINTS)) return 'model_invalid'
  if (containsAny(lowerMessage, MODEL_TERMS)) return 'model_invalid'

  if (ctx.status === 429) return 'connection_error'
  if (containsAny(lowerMessage, CONNECTION_TERMS)) return 'connection_error'

  return 'unknown_error'
}

export function classifyProviderError(_providerId: string, ctx: RuntimeErrorContext): RuntimeErrorCode {
  return classifyRuntimeError(ctx)
}
