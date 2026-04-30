#!/usr/bin/env node

import fs from 'node:fs/promises'
import { validateHeaderName, validateHeaderValue } from 'node:http'
import { URL } from 'node:url'

const DEFAULT_TIMEOUT_MS = 30000
const STREAM_TIMEOUT_MS = 45000
const DONE_MARKERS = ['[done]', 'event: done', '"done":true', '"finish_reason":"stop"']
const SSE_DEBUG_MAX_EVENTS = 20

function printUsage() {
  console.log('Usage: node scripts/provider-probe.mjs <probe-input.json> [--show-prompt]')
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const cloneJson = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const toLength = (v) => (v === null || v === undefined ? 0 : String(v).length)

function tryParseJson(text) { try { return JSON.parse(text) } catch { return null } }
function normalizeHeaderKey(k) { return String(k).toLowerCase() }
function truncateText(text, max = 300) { return text.length > max ? `${text.slice(0, max)}...` : text }

function sanitizeCookie(raw) {
  if (typeof raw !== 'string') return { present: false, valid: true, length: 0 }
  const value = raw.split(';').map((x) => x.trim()).filter(Boolean).join('; ')
  if (!value) return { present: false, valid: false, length: 0, reason: 'empty_after_sanitize' }
  try { validateHeaderValue('cookie', value); return { present: true, valid: true, length: value.length, value } } catch { return { present: true, valid: false, length: value.length, reason: 'invalid_cookie_value' } }
}

function validateHeaders(headers) {
  const valid = {}
  const skipped = []
  for (const [rawKey, rawVal] of Object.entries(headers || {})) {
    const key = normalizeHeaderKey(rawKey)
    if (typeof rawVal !== 'string') continue
    let val = rawVal
    if (key === 'cookie') {
      const c = sanitizeCookie(rawVal)
      if (!c.valid || !c.value) { skipped.push({ key, reason: c.reason || 'invalid_cookie' }); continue }
      val = c.value
    }
    try {
      validateHeaderName(key)
      validateHeaderValue(key, val)
      valid[key] = val
    } catch {
      skipped.push({ key, reason: 'invalid_header_value' })
    }
  }
  return { validHeaders: valid, skipped }
}

function getByPath(obj, path) {
  const parts = path.split('.')
  let cur = obj
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[p]
  }
  return cur
}
function deleteByPath(obj, path) {
  const parts = path.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (cur === null || cur === undefined) return false
    cur = cur[parts[i]]
  }
  if (cur && Object.prototype.hasOwnProperty.call(cur, parts[parts.length - 1])) {
    delete cur[parts[parts.length - 1]]
    return true
  }
  return false
}
function deepMerge(target, src) {
  if (!isObject(src)) return target
  for (const [k, v] of Object.entries(src)) {
    if (isObject(v) && isObject(target[k])) deepMerge(target[k], v)
    else target[k] = cloneJson(v)
  }
  return target
}

function applyVariant(base, variant) {
  const out = { method: base.method, urlObj: new URL(base.urlObj.toString()), headers: { ...base.headers }, body: cloneJson(base.body) }
  for (const key of variant.removeHeaders || []) delete out.headers[normalizeHeaderKey(key)]
  if (isObject(variant.setHeaders)) {
    for (const [k, v] of Object.entries(variant.setHeaders)) if (typeof v === 'string') out.headers[normalizeHeaderKey(k)] = v
  }
  for (const key of variant.removeQuery || []) out.urlObj.searchParams.delete(key)
  if (isObject(variant.setQuery)) for (const [k, v] of Object.entries(variant.setQuery)) out.urlObj.searchParams.set(k, String(v))
  if (isObject(variant.replaceBody)) out.body = cloneJson(variant.replaceBody)
  for (const path of variant.removeBodyPaths || []) if (typeof path === 'string' && isObject(out.body)) deleteByPath(out.body, path)
  for (const key of variant.removeBodyTopLevelKeys || []) if (isObject(out.body)) delete out.body[key]
  if (isObject(variant.setBody)) {
    if (!isObject(out.body)) out.body = {}
    deepMerge(out.body, variant.setBody)
  }
  return out
}

function buildAutoVariants(input) {
  const variants = []
  const headers = Object.fromEntries(Object.entries(input.request.headers || {}).map(([k, v]) => [normalizeHeaderKey(k), v]))
  const urlObj = new URL(input.request.url)
  const body = isObject(input.request.body) ? input.request.body : {}
  if (headers.cookie) variants.push({ name: 'without_cookie', removeHeaders: ['cookie'] })
  if (headers.authorization) variants.push({ name: 'without_authorization', removeHeaders: ['authorization'] })
  if (headers['bigmodel-organization']) variants.push({ name: 'without_bigmodel_organization', removeHeaders: ['bigmodel-organization'] })
  if (headers['bigmodel-project']) variants.push({ name: 'without_bigmodel_project', removeHeaders: ['bigmodel-project'] })
  if (urlObj.searchParams.has('token')) variants.push({ name: 'token_removed_from_query', removeQuery: ['token'] })
  if (urlObj.searchParams.has('uuid')) variants.push({ name: 'without_uuid', removeQuery: ['uuid'] })
  if (urlObj.searchParams.has('device_id')) variants.push({ name: 'without_device_id', removeQuery: ['device_id'] })
  if (urlObj.searchParams.has('user_id')) variants.push({ name: 'without_user_id', removeQuery: ['user_id'] })
  if (Object.prototype.hasOwnProperty.call(body, 'chat_id')) variants.push({ name: 'without_chat_id', removeBodyPaths: ['chat_id'] })
  if (Object.prototype.hasOwnProperty.call(body, 'model_option')) variants.push({ name: 'without_model_option', removeBodyPaths: ['model_option'] })
  if (Object.prototype.hasOwnProperty.call(body, 'model')) variants.push({ name: 'without_model', removeBodyPaths: ['model'] })
  if (Object.prototype.hasOwnProperty.call(body, 'modelId')) variants.push({ name: 'without_modelId', removeBodyPaths: ['modelId'] })
  if (Object.prototype.hasOwnProperty.call(body, 'tools')) variants.push({ name: 'without_tools', removeBodyPaths: ['tools'] })
  if (Object.prototype.hasOwnProperty.call(body, 'thinking')) variants.push({ name: 'without_thinking', removeBodyPaths: ['thinking'] })
  if (body.stream === true) variants.push({ name: 'non_stream', setBody: { stream: false } })
  return variants
}

function safeSummary(input, showPrompt) {
  const method = (input.request.method || 'POST').toUpperCase()
  const urlObj = new URL(input.request.url)
  const headers = Object.fromEntries(Object.entries(input.request.headers || {}).map(([k, v]) => [normalizeHeaderKey(k), v]))
  const body = isObject(input.request.body) ? input.request.body : {}
  const cookie = sanitizeCookie(headers.cookie)
  return {
    provider: input.provider,
    method,
    endpoint_path: urlObj.pathname,
    query_keys: [...new Set([...urlObj.searchParams.keys()])],
    header_keys: Object.keys(headers),
    has_token: urlObj.searchParams.has('token'), token_length: toLength(urlObj.searchParams.get('token')),
    has_cookie: cookie.present, cookie_length: cookie.length,
    has_authorization: typeof headers.authorization === 'string', authorization_length: toLength(headers.authorization),
    has_bigmodel_organization: typeof headers['bigmodel-organization'] === 'string',
    has_bigmodel_project: typeof headers['bigmodel-project'] === 'string',
    body_top_level_keys: Object.keys(body),
    model: body.model, modelId: body.modelId, stream: body.stream,
    thinking_type: isObject(body.thinking) ? body.thinking.type : undefined,
    tools_length: Array.isArray(body.tools) ? body.tools.length : 0,
    prompt_length: Array.isArray(body.prompt) ? body.prompt.length : 0,
    last_user_text_length: (() => {
      if (!Array.isArray(body.prompt)) return 0
      const users = body.prompt.filter((x) => isObject(x) && x.role === 'user' && typeof x.content === 'string')
      if (!users.length) return 0
      const t = users[users.length - 1].content
      return showPrompt ? t : toLength(t)
    })(),
  }
}

async function runHttpRequest(req) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body === undefined ? undefined : JSON.stringify(req.body), signal: controller.signal })
    const contentType = response.headers.get('content-type') || ''
    const isStream = contentType.includes('text/event-stream')
    if (!isStream) {
      const text = await response.text(); const parsed = tryParseJson(text); const baseResp = isObject(parsed?.base_resp) ? parsed.base_resp : undefined
      return { status: response.status, contentType, responseLength: text.length, topLevelKeys: isObject(parsed) ? Object.keys(parsed) : [], baseRespStatusCode: baseResp?.status_code, baseRespStatusMsg: baseResp?.status_msg, hasChatId: !!parsed?.chat_id, hasMsgId: !!parsed?.msg_id, is_event_stream: false }
    }
    const streamController = new AbortController(); const st = setTimeout(() => streamController.abort(), STREAM_TIMEOUT_MS)
    const reader = response.body?.getReader(); const decoder = new TextDecoder(); let chunks = 0; let total = 0; let completion = false; const ev = []
    const sseDebugEvents = []
    let sseBuffer = ''
    let currentEventName = ''
    let currentDataLines = []
    const flushSseEvent = () => {
      if (!currentEventName && !currentDataLines.length) return
      const rawData = currentDataLines.join('\n')
      let parsedKeys = null
      let parsedPreview = null
      const parsed = tryParseJson(rawData)
      if (isObject(parsed) || Array.isArray(parsed)) {
        parsedKeys = Array.isArray(parsed) ? ['<array>'] : Object.keys(parsed)
        parsedPreview = truncateText(JSON.stringify(parsed))
      }
      if (sseDebugEvents.length < SSE_DEBUG_MAX_EVENTS) {
        sseDebugEvents.push({ index: sseDebugEvents.length + 1, event: currentEventName || '<none>', raw_data: rawData, parsed_keys: parsedKeys, parsed_preview: parsedPreview })
      }
      currentEventName = ''
      currentDataLines = []
    }
    while (reader) {
      const { done, value } = await reader.read(); if (done) break
      const txt = decoder.decode(value, { stream: true }); chunks += 1; total += txt.length
      const match = txt.match(/event:\s*([^\n\r]+)/i); if (match && ev.length < 5) ev.push(match[1].trim())
      sseBuffer += txt
      while (true) {
        const boundary = sseBuffer.indexOf('\n\n')
        if (boundary === -1) break
        const rawEvent = sseBuffer.slice(0, boundary)
        sseBuffer = sseBuffer.slice(boundary + 2)
        const normalized = rawEvent.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        const lines = normalized.split('\n')
        currentEventName = ''
        currentDataLines = []
        for (const line of lines) {
          if (line.startsWith('event:')) currentEventName = line.slice('event:'.length).trim()
          else if (line.startsWith('data:')) currentDataLines.push(line.slice('data:'.length).trimStart())
        }
        flushSseEvent()
      }
      if (DONE_MARKERS.some((m) => txt.toLowerCase().includes(m))) { completion = true; break }
    }
    if (sseBuffer.trim()) {
      const normalized = sseBuffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      const lines = normalized.split('\n')
      currentEventName = ''
      currentDataLines = []
      for (const line of lines) {
        if (line.startsWith('event:')) currentEventName = line.slice('event:'.length).trim()
        else if (line.startsWith('data:')) currentDataLines.push(line.slice('data:'.length).trimStart())
      }
      flushSseEvent()
    }
    clearTimeout(st)
    return { status: response.status, contentType, responseLength: total, topLevelKeys: [], hasChatId: false, hasMsgId: false, is_event_stream: true, chunks_seen: chunks, first_event_names: ev, completion_detected: completion, sse_event_debug: sseDebugEvents }
  } catch (e) {
    return { status: null, contentType: null, responseLength: 0, topLevelKeys: [], hasChatId: false, hasMsgId: false, transportError: e instanceof Error ? e.message : String(e), is_event_stream: false }
  } finally { clearTimeout(timeout) }
}

function validateInput(input) {
  const errors = []
  if (!isObject(input)) return ['input must be object']
  if (typeof input.provider !== 'string' || !input.provider.trim()) errors.push('provider must be non-empty string')
  if (!isObject(input.request)) errors.push('request must be object')
  if (typeof input?.request?.url !== 'string') errors.push('request.url must be string')
  if (input?.request?.method !== undefined && typeof input.request.method !== 'string') errors.push('request.method must be string')
  if (input?.request?.headers !== undefined && !isObject(input.request.headers)) errors.push('request.headers must be object')
  if (input?.request?.body !== undefined && !isObject(input.request.body)) errors.push('request.body must be object')
  if (input.variants !== undefined && !Array.isArray(input.variants)) errors.push('variants must be array')
  return errors
}

async function main() {
  const args = process.argv.slice(2); const showPrompt = args.includes('--show-prompt'); const filePath = args.find((x) => !x.startsWith('--'))
  if (!filePath) { printUsage(); process.exitCode = 1; return }
  const raw = await fs.readFile(filePath, 'utf8'); const input = JSON.parse(raw)
  const errors = validateInput(input); if (errors.length) { console.error('Input validation failed:'); errors.forEach((e) => console.error(`  - ${e}`)); process.exitCode = 1; return }

  const summary = safeSummary(input, showPrompt)
  console.log(`Provider Probe Report: ${summary.provider}`)
  console.log('Input Summary:')
  console.log(JSON.stringify(summary, null, 2))

  const method = (input.request.method || 'POST').toUpperCase()
  const baseUrl = new URL(input.request.url)
  const rawHeaders = Object.fromEntries(Object.entries(input.request.headers || {}).map(([k, v]) => [normalizeHeaderKey(k), v]))
  const baseBody = cloneJson(input.request.body || {})
  const variants = [{ name: 'exact_browser_replay' }, ...(Array.isArray(input.variants) && input.variants.length ? input.variants : buildAutoVariants(input))]

  const results = []
  for (const v of variants) {
    const mutated = applyVariant({ method, urlObj: baseUrl, headers: rawHeaders, body: baseBody }, v)
    const hv = validateHeaders(mutated.headers)
    if (!Object.keys(hv.validHeaders).length && Object.keys(mutated.headers).length) {
      const skipped = { name: v.name, skipped: true, reason: 'all headers invalid after validation', headerDiagnostics: hv.skipped }
      results.push(skipped); console.log(JSON.stringify(skipped, null, 2)); continue
    }
    const res = await runHttpRequest({ method, url: mutated.urlObj.toString(), headers: hv.validHeaders, body: mutated.body })
    const item = { name: v.name, skipped: false, headerDiagnostics: hv.skipped, ...res }
    results.push(item); console.log(JSON.stringify(item, null, 2))
    if (Array.isArray(item.sse_event_debug) && item.sse_event_debug.length) {
      console.log('=== SSE EVENT DEBUG ===')
      for (const evt of item.sse_event_debug) {
        console.log(`[SSE EVENT ${evt.index}]`)
        console.log(`event: ${evt.event}`)
        console.log(`raw_data: ${evt.raw_data}`)
        if (Array.isArray(evt.parsed_keys)) {
          console.log(`parsed_keys: ${JSON.stringify(evt.parsed_keys)}`)
          console.log(`parsed_preview: ${evt.parsed_preview}`)
        }
        console.log('')
      }
    }
  }

  console.log('Summary:')
  console.log(JSON.stringify(results.map((r) => ({ name: r.name, skipped: r.skipped, status: r.status, is_event_stream: r.is_event_stream })), null, 2))
}

main().catch(() => { console.error('Unexpected probe error (details redacted).'); process.exitCode = 1 })
