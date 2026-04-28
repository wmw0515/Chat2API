#!/usr/bin/env node

import fs from 'node:fs/promises'
import { URL } from 'node:url'
import { validateHeaderName, validateHeaderValue } from 'node:http'

const DEFAULT_TIMEOUT_MS = 30000
const MAX_PREVIEW_LENGTH = 24

function printUsage() {
  console.log('Usage: node scripts/provider-probe.mjs <probe-input.json> [--show-prompt]')
}

function toLength(value) {
  if (value === null || value === undefined) return 0
  return String(value).length
}

function tryParseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function readPromptPreview(text, allowFullPrompt) {
  if (typeof text !== 'string') {
    return { present: false }
  }

  if (allowFullPrompt) {
    return { present: true, full: text }
  }

  const preview = text.slice(0, MAX_PREVIEW_LENGTH)
  return {
    present: true,
    preview,
    redacted: text.length > MAX_PREVIEW_LENGTH ? `${preview}…` : preview,
    totalLength: text.length,
  }
}

function sanitizeCookie(rawCookie) {
  if (typeof rawCookie !== 'string') {
    return { value: undefined, present: false, length: 0, valid: true, reason: 'missing' }
  }

  const value = rawCookie
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('; ')

  if (!value) {
    return { value: undefined, present: false, length: 0, valid: false, reason: 'empty_after_sanitize' }
  }

  try {
    validateHeaderName('cookie')
    validateHeaderValue('cookie', value)
    return { value, present: true, length: value.length, valid: true }
  } catch {
    return { value: undefined, present: true, length: value.length, valid: false, reason: 'invalid_header_value' }
  }
}

function buildSafeRequestSummary(provider, method, urlObj, headers, body, allowFullPrompt) {
  const queryKeys = [...new Set([...urlObj.searchParams.keys()])]
  const token = urlObj.searchParams.get('token')
  const cookie = sanitizeCookie(headers.cookie)

  const summary = {
    provider,
    method,
    endpoint_path: urlObj.pathname,
    query_keys: queryKeys,
    query: {
      has_token: token !== null,
      token_length: token ? token.length : 0,
      has_uuid: urlObj.searchParams.has('uuid'),
      uuid_length: toLength(urlObj.searchParams.get('uuid')),
      has_device_id: urlObj.searchParams.has('device_id'),
      device_id_length: toLength(urlObj.searchParams.get('device_id')),
      has_user_id: urlObj.searchParams.has('user_id'),
      user_id_length: toLength(urlObj.searchParams.get('user_id')),
    },
    headers: {
      has_cookie: cookie.present,
      cookie_length: cookie.length,
      cookie_valid: cookie.valid,
      has_authorization: typeof headers.authorization === 'string',
      has_user_agent: typeof headers['user-agent'] === 'string',
    },
    body: {
      top_level_keys: isObject(body) ? Object.keys(body) : [],
      msg_type: isObject(body) ? body.msg_type : undefined,
      chat_type: isObject(body) ? body.chat_type : undefined,
      has_chat_id: isObject(body) && Object.prototype.hasOwnProperty.call(body, 'chat_id'),
      chat_id_length: isObject(body) ? toLength(body.chat_id) : 0,
      model_option_display_name:
        isObject(body) && isObject(body.model_option) ? body.model_option.display_name : undefined,
      model_option_model_type:
        isObject(body) && isObject(body.model_option) ? body.model_option.model_type : undefined,
      sub_agent_ids_length:
        isObject(body) && Array.isArray(body.sub_agent_ids) ? body.sub_agent_ids.length : 0,
      selected_mcp_tools_length:
        isObject(body) && Array.isArray(body.selected_mcp_tools) ? body.selected_mcp_tools.length : 0,
      attachments_length: isObject(body) && Array.isArray(body.attachments) ? body.attachments.length : 0,
      text: readPromptPreview(isObject(body) ? body.text : undefined, allowFullPrompt),
    },
  }

  if (!cookie.valid) {
    summary.headers.cookie_invalid_reason = cookie.reason
  }

  return summary
}

function buildRequestHeaders(inputHeaders, cookieInfo) {
  const headers = {}

  const safeHeaderKeys = [
    'accept',
    'accept-language',
    'content-type',
    'origin',
    'referer',
    'user-agent',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
    'x-requested-with',
  ]

  for (const key of safeHeaderKeys) {
    if (typeof inputHeaders[key] === 'string' && inputHeaders[key].trim()) {
      headers[key] = inputHeaders[key]
    }
  }

  if (!headers['content-type']) {
    headers['content-type'] = 'application/json;charset=UTF-8'
  }

  if (!headers.accept) {
    headers.accept = 'application/json, text/plain, */*'
  }

  if (!headers['user-agent']) {
    headers['user-agent'] =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36'
  }

  if (cookieInfo.valid && cookieInfo.value) {
    headers.cookie = cookieInfo.value
  }

  return headers
}

async function runHttpRequest({ method, url, headers, body }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })

    const contentType = response.headers.get('content-type') ?? ''
    const rawText = await response.text()
    const parsed = tryParseJson(rawText)

    const responseTopLevelKeys = isObject(parsed) ? Object.keys(parsed) : []
    const baseResp = isObject(parsed) && isObject(parsed.base_resp) ? parsed.base_resp : undefined

    return {
      ok: response.ok,
      status: response.status,
      contentType,
      responseLength: rawText.length,
      topLevelKeys: responseTopLevelKeys,
      baseRespStatusCode: baseResp?.status_code,
      baseRespStatusMsg: baseResp?.status_msg,
      hasChatId: isObject(parsed) && Object.prototype.hasOwnProperty.call(parsed, 'chat_id'),
      hasMsgId: isObject(parsed) && Object.prototype.hasOwnProperty.call(parsed, 'msg_id'),
      transportError: null,
      cookieRejected: false,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      status: null,
      contentType: null,
      responseLength: 0,
      topLevelKeys: [],
      baseRespStatusCode: undefined,
      baseRespStatusMsg: undefined,
      hasChatId: false,
      hasMsgId: false,
      transportError: message,
      cookieRejected: /header|cookie/i.test(message),
    }
  } finally {
    clearTimeout(timeout)
  }
}

function evaluateResult(item) {
  const businessSuccess =
    item.status !== null &&
    item.status < 400 &&
    (item.baseRespStatusCode === 0 || (item.ok && item.baseRespStatusCode === undefined))

  return businessSuccess ? 'success' : 'failed'
}

function createMinimaxVariants(baseInput) {
  const variants = []

  const baseRequest = baseInput.request
  const baseHeaders = isObject(baseRequest.headers) ? cloneJson(baseRequest.headers) : {}
  const baseBody = isObject(baseRequest.body) ? cloneJson(baseRequest.body) : {}

  variants.push({
    name: 'exact_browser_replay',
    modify({ urlObj, headers, body }) {
      return { urlObj, headers, body }
    },
  })

  variants.push({
    name: 'without_cookie',
    modify({ urlObj, headers, body }) {
      const nextHeaders = { ...headers }
      delete nextHeaders.cookie
      return { urlObj, headers: nextHeaders, body }
    },
  })

  variants.push({
    name: 'without_chat_id',
    modify({ urlObj, headers, body }) {
      const nextBody = cloneJson(body)
      if (isObject(nextBody)) delete nextBody.chat_id
      return { urlObj, headers, body: nextBody }
    },
  })

  for (const key of ['uuid', 'device_id', 'user_id']) {
    variants.push({
      name: `without_${key}`,
      modify({ urlObj, headers, body }) {
        const nextUrl = new URL(urlObj.toString())
        nextUrl.searchParams.delete(key)
        return { urlObj: nextUrl, headers, body }
      },
    })
  }

  variants.push({
    name: 'without_sub_agent_ids',
    modify({ urlObj, headers, body }) {
      const nextBody = cloneJson(body)
      if (isObject(nextBody)) delete nextBody.sub_agent_ids
      return { urlObj, headers, body: nextBody }
    },
  })

  variants.push({
    name: 'without_model_option',
    modify({ urlObj, headers, body }) {
      const nextBody = cloneJson(body)
      if (isObject(nextBody)) delete nextBody.model_option
      return { urlObj, headers, body: nextBody }
    },
  })

  variants.push({
    name: 'token_removed_from_query',
    modify({ urlObj, headers, body }) {
      const nextUrl = new URL(urlObj.toString())
      nextUrl.searchParams.delete('token')
      return { urlObj: nextUrl, headers, body }
    },
  })

  variants.push({
    name: 'chat2api_like_minimal_body',
    modify({ urlObj, headers, body }) {
      const sourceBody = isObject(body) ? body : {}
      const nextBody = {
        msg_type: sourceBody.msg_type ?? 1,
        text: typeof sourceBody.text === 'string' ? sourceBody.text : 'probe-message',
        chat_type: sourceBody.chat_type ?? 2,
      }
      return { urlObj, headers, body: nextBody }
    },
  })

  return {
    method: typeof baseRequest.method === 'string' ? baseRequest.method.toUpperCase() : 'POST',
    url: String(baseRequest.url || ''),
    headers: isObject(baseHeaders) ? baseHeaders : {},
    body: isObject(baseBody) ? baseBody : {},
    variants,
  }
}

function printSafeRequestSummary(summary, allowFullPrompt) {
  console.log('Input Summary:')
  console.log(`  provider: ${summary.provider}`)
  console.log(`  method: ${summary.method}`)
  console.log(`  endpoint_path: ${summary.endpoint_path}`)
  console.log(`  query_keys: ${summary.query_keys.join(', ') || '(none)'}`)
  console.log(`  query.has_token: ${summary.query.has_token}`)
  console.log(`  query.token_length: ${summary.query.token_length}`)
  console.log(`  headers.has_cookie: ${summary.headers.has_cookie}`)
  console.log(`  headers.cookie_length: ${summary.headers.cookie_length}`)
  console.log(`  headers.cookie_valid: ${summary.headers.cookie_valid}`)
  if (summary.headers.cookie_invalid_reason) {
    console.log(`  headers.cookie_invalid_reason: ${summary.headers.cookie_invalid_reason}`)
  }
  console.log(`  body.top_level_keys: ${summary.body.top_level_keys.join(', ') || '(none)'}`)
  console.log(`  body.msg_type: ${summary.body.msg_type ?? '(missing)'}`)
  console.log(`  body.chat_type: ${summary.body.chat_type ?? '(missing)'}`)
  console.log(`  body.has_chat_id: ${summary.body.has_chat_id}`)
  console.log(`  body.chat_id_length: ${summary.body.chat_id_length}`)
  console.log(`  body.model_option.display_name: ${summary.body.model_option_display_name ?? '(missing)'}`)
  console.log(`  body.model_option.model_type: ${summary.body.model_option_model_type ?? '(missing)'}`)
  console.log(`  body.sub_agent_ids_length: ${summary.body.sub_agent_ids_length}`)
  console.log(`  body.selected_mcp_tools_length: ${summary.body.selected_mcp_tools_length}`)
  console.log(`  body.attachments_length: ${summary.body.attachments_length}`)
  if (summary.body.text.present) {
    if (allowFullPrompt) {
      console.log(`  body.text: ${summary.body.text.full}`)
    } else {
      console.log(`  body.text_preview: ${summary.body.text.redacted}`)
      console.log(`  body.text_length: ${summary.body.text.totalLength}`)
    }
  }
  console.log('')
}

function printVariantResult(result) {
  console.log(`Variant ${result.name}:`)
  if (result.skipped) {
    console.log(`  skipped: true`)
    console.log(`  reason: ${result.reason}`)
    console.log('')
    return
  }

  console.log(`  status: ${result.status ?? '(no response)'}`)
  console.log(`  content_type: ${result.contentType ?? '(none)'}`)
  console.log(`  response_length: ${result.responseLength}`)
  console.log(`  response_keys: ${result.topLevelKeys.join(', ') || '(none)'}`)
  if (result.baseRespStatusCode !== undefined) {
    console.log(`  base_resp.status_code: ${result.baseRespStatusCode}`)
  }
  if (typeof result.baseRespStatusMsg === 'string') {
    console.log(`  base_resp.status_msg: ${result.baseRespStatusMsg}`)
  }
  console.log(`  has_chat_id: ${result.hasChatId}`)
  console.log(`  has_msg_id: ${result.hasMsgId}`)
  if (result.transportError) {
    console.log(`  transport_error: ${result.transportError}`)
  }
  console.log(`  result: ${result.result}`)
  console.log('')
}

function printConclusion(results) {
  const exact = results.find((x) => x.name === 'exact_browser_replay')
  const requiredHeaders = []
  const requiredQuery = []
  const requiredBody = []

  if (exact && exact.result === 'success') {
    const lookup = new Map(results.map((item) => [item.name, item]))

    if (lookup.get('without_cookie')?.result === 'failed') {
      requiredHeaders.push('Cookie')
    }

    if (lookup.get('token_removed_from_query')?.result === 'failed') {
      requiredQuery.push('token')
    }

    for (const q of ['uuid', 'device_id', 'user_id']) {
      if (lookup.get(`without_${q}`)?.result === 'failed') {
        requiredQuery.push(q)
      }
    }

    const bodyChecks = [
      ['without_chat_id', 'chat_id'],
      ['without_model_option', 'model_option'],
      ['without_sub_agent_ids', 'sub_agent_ids'],
    ]

    for (const [variantName, fieldName] of bodyChecks) {
      if (lookup.get(variantName)?.result === 'failed') {
        requiredBody.push(fieldName)
      }
    }

    const minimal = lookup.get('chat2api_like_minimal_body')
    if (minimal?.result === 'failed') {
      requiredBody.push('msg_type')
      requiredBody.push('text')
      requiredBody.push('chat_type')
    }
  }

  console.log('Conclusion:')
  console.log(`  required_headers: ${requiredHeaders.join(', ') || '(undetermined)'}`)
  console.log(`  required_query: ${requiredQuery.join(', ') || '(undetermined)'}`)
  console.log(`  required_body: ${requiredBody.join(', ') || '(undetermined)'}`)
  console.log('')

  if (exact && exact.result === 'success') {
    console.log('Suggested profile placeholders (no secrets):')
    console.log('  token: {{credentials.token}}')
    console.log('  cookies: {{credentials.cookies}}')
    console.log('  chatId: {{credentials.chatId}}')
    console.log('  webUuid: {{credentials.webUuid}}')
    console.log('  webDeviceId: {{credentials.webDeviceId}}')
    console.log('  webUserId: {{credentials.webUserId}}')
    console.log('  prompt: {{input.prompt}}')
  }
}

function validateInput(input) {
  const errors = []

  if (!isObject(input)) {
    errors.push('input must be a JSON object')
    return errors
  }

  if (typeof input.provider !== 'string' || !input.provider.trim()) {
    errors.push('provider must be a non-empty string')
  }

  if (!isObject(input.request)) {
    errors.push('request must be an object')
    return errors
  }

  if (typeof input.request.url !== 'string' || !input.request.url.trim()) {
    errors.push('request.url must be a non-empty string')
  } else {
    try {
      new URL(input.request.url)
    } catch {
      errors.push('request.url must be a valid URL')
    }
  }

  if (input.request.method !== undefined && typeof input.request.method !== 'string') {
    errors.push('request.method must be a string if provided')
  }

  if (input.request.headers !== undefined && !isObject(input.request.headers)) {
    errors.push('request.headers must be an object if provided')
  }

  if (input.request.body !== undefined && !isObject(input.request.body)) {
    errors.push('request.body must be an object if provided')
  }

  return errors
}

async function main() {
  const args = process.argv.slice(2)
  const showPrompt = args.includes('--show-prompt')
  const filePath = args.find((x) => !x.startsWith('--'))

  if (!filePath) {
    printUsage()
    process.exitCode = 1
    return
  }

  let raw
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch {
    console.error('Failed to read input file. Ensure the path exists and is readable.')
    process.exitCode = 1
    return
  }

  let input
  try {
    input = JSON.parse(raw)
  } catch {
    console.error('Invalid JSON input file.')
    process.exitCode = 1
    return
  }

  const validationErrors = validateInput(input)
  if (validationErrors.length > 0) {
    console.error('Input validation failed:')
    for (const err of validationErrors) {
      console.error(`  - ${err}`)
    }
    process.exitCode = 1
    return
  }

  const provider = input.provider.toLowerCase()
  if (provider !== 'minimax') {
    console.error(`Unsupported provider '${input.provider}'. Current supported provider: minimax.`)
    process.exitCode = 1
    return
  }

  const plan = createMinimaxVariants(input)
  const urlObj = new URL(plan.url)
  const initialSummary = buildSafeRequestSummary(
    provider,
    plan.method,
    urlObj,
    isObject(plan.headers) ? plan.headers : {},
    plan.body,
    showPrompt,
  )

  console.log(`Provider Probe Report: ${provider}`)
  console.log('')
  printSafeRequestSummary(initialSummary, showPrompt)

  const results = []

  for (const variant of plan.variants) {
    const variantUrl = new URL(plan.url)
    const cookieInfo = sanitizeCookie(plan.headers.cookie)

    if (variant.name === 'exact_browser_replay' && plan.headers.cookie && !cookieInfo.valid) {
      const skipped = {
        name: variant.name,
        skipped: true,
        reason: `cookie is invalid (${cookieInfo.reason}); variant skipped safely`,
      }
      results.push(skipped)
      printVariantResult(skipped)
      continue
    }

    const baseHeaders = buildRequestHeaders(plan.headers, cookieInfo)
    const baseBody = cloneJson(plan.body)

    const mutated = variant.modify({
      urlObj: variantUrl,
      headers: baseHeaders,
      body: baseBody,
    })

    const result = await runHttpRequest({
      method: plan.method,
      url: mutated.urlObj.toString(),
      headers: mutated.headers,
      body: mutated.body,
    })

    const finalResult = {
      name: variant.name,
      ...result,
      result: evaluateResult(result),
    }
    results.push(finalResult)
    printVariantResult(finalResult)
  }

  printConclusion(results)
}

main().catch(() => {
  console.error('Unexpected probe error (details redacted).')
  process.exitCode = 1
})
