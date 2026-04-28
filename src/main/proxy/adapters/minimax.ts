/**
 * MiniMax Adapter
 * Based on MiniMax-Free-API implementation
 * https://github.com/LLM-Red-Team/MiniMax-Free-API
 */

import { PassThrough } from 'stream'
import http2, { ClientHttp2Session, ClientHttp2Stream } from 'http2'
import axios, { AxiosResponse } from 'axios'
import crypto from 'crypto'
import { createParser, EventSourceMessage } from 'eventsource-parser'
import FormData from 'form-data'
import { Account, Provider } from '../../store/types'
import { toolsToSystemPrompt, TOOL_WRAP_HINT, hasToolPromptInjected, shouldInjectToolPrompt } from '../utils/tools'
import { parseToolCallsFromText } from '../utils/toolParser'
import { 
  createToolCallState, 
  processStreamContent, 
  flushToolCallBuffer,
  createBaseChunk,
  ToolCallState 
} from '../utils/streamToolHandler'

const AGENT_BASE_URL = 'https://agent.minimaxi.com'

const FAKE_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Cache-Control': 'no-cache',
  Origin: 'https://agent.minimaxi.com',
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Firefox";v="125", "Not_A Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
}

const WEB_QUERY_BASE: Record<string, any> = {
  device_platform: 'web',
  biz_id: '3',
  app_id: '3001',
  version_code: '22201',
  os_name: 'Windows',
  browser_name: 'firefox',
  cpu_core_num: 8,
  browser_language: 'zh-CN',
  browser_platform: 'Win32',
  screen_width: 1920,
  screen_height: 1080,
  lang: 'zh',
  timezone_offset: 28800,
  sys_language: 'zh',
  client: 'web',
}

const LEGACY_QUERY_BASE: Record<string, any> = {
  device_platform: 'web',
  biz_id: '3',
  app_id: '3001',
  version_code: '22201',
  os_name: 'Mac',
  browser_name: 'chrome',
  device_memory: 8,
  cpu_core_num: 11,
  browser_language: 'zh-CN',
  browser_platform: 'MacIntel',
  screen_width: 1920,
  screen_height: 1080,
  lang: 'zh',
}

const DEFAULT_SUB_AGENT_IDS = [
  340123961561242,
  340123961561243,
  340123961561244,
  340123961561245,
  355305220752206,
  386069372367665,
]

const MODEL_OPTIONS: Record<string, { display_name: string; model_type: number }> = {
  'MiniMax-M2.7': { display_name: 'MiniMax-M2.7', model_type: 501 },
}

interface MiniMaxMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | any[] | null
  tool_call_id?: string
  tool_calls?: any[]
}

interface ChatCompletionRequest {
  model: string
  messages: MiniMaxMessage[]
  stream?: boolean
  temperature?: number
  tools?: any[]
  tool_choice?: any
  chatId?: string
}

interface DeviceInfo {
  deviceId: string
  userId: string
  realUserID: string
  jwtToken: string
  refreshTime: number
  uuid: string // Device registration uuid
}

interface CreditInfo {
  totalCredits: number
  usedCredits: number
  remainingCredits: number
  expiresAt?: number // Credit reset timestamp (milliseconds)
}

interface ChatListItem {
  chat_id: number
  chat_name: string
  update_time: number
  create_time: number
}

const deviceInfoMap = new Map<string, DeviceInfo>()
const DEVICE_INFO_EXPIRES = 10800
const MINIMAX_SEND_DEBUG = process.env.CHAT2API_MINIMAX_SEND_DEBUG === '1'

function sanitizeCookieHeaderValue(rawValue: string): string {
  return rawValue
    .trim()
    .replace(/[\r\n\t]+/g, '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function normalizeMiniMaxChatId(rawValue: unknown): string | number | undefined {
  if (rawValue === undefined || rawValue === null) {
    return undefined
  }

  if (typeof rawValue === 'number') {
    if (!Number.isFinite(rawValue) || !Number.isInteger(rawValue) || rawValue < 0) {
      return undefined
    }
    return Number.isSafeInteger(rawValue) ? rawValue : undefined
  }

  const normalized = String(rawValue).trim()
  if (!normalized || !/^\d+$/.test(normalized)) {
    return undefined
  }

  const asNumber = Number(normalized)
  if (Number.isSafeInteger(asNumber)) {
    return asNumber
  }

  return normalized
}

function summarizeMiniMaxSendMsgRequest(
  method: string,
  uri: string,
  userData: Record<string, any>,
  headers: Record<string, string>,
  data: any,
  configuredChatId?: string | number
): Record<string, any> {
  const queryKeys = Object.keys(userData).filter((key) => userData[key] !== undefined && userData[key] !== null)
  const cookieHeader = headers.Cookie || ''
  const tokenInQuery = typeof userData.token === 'string' ? userData.token : ''
  const modelOption = data?.model_option && typeof data.model_option === 'object' ? data.model_option : {}
  return {
    method,
    path: uri,
    queryKeys,
    hasTokenInQuery: Boolean(tokenInQuery),
    tokenLength: tokenInQuery.length,
    hasCookieHeader: Boolean(cookieHeader),
    cookieLength: cookieHeader.length,
    hasConfiguredChatId: configuredChatId !== undefined,
    hasTokenHeader: Boolean(headers.token),
    hasAuthorizationHeader: Boolean(headers.Authorization),
    hasReferer: Boolean(headers.Referer),
    uuidPresent: Boolean(userData.uuid),
    deviceIdPresent: Boolean(userData.device_id),
    userIdPresent: Boolean(userData.user_id),
    version_code: userData.version_code,
    app_id: userData.app_id,
    biz_id: userData.biz_id,
    browser_name: userData.browser_name,
    os_name: userData.os_name,
    client: userData.client,
    bodyTopLevelKeys: data && typeof data === 'object' ? Object.keys(data) : [],
    body_chat_type: data?.chat_type,
    body_msg_type: data?.msg_type,
    bodyHasChatId: data?.chat_id !== undefined && data?.chat_id !== null,
    chatIdType: data?.chat_id === undefined || data?.chat_id === null ? 'none' : typeof data.chat_id,
    chatIdLength: data?.chat_id === undefined || data?.chat_id === null ? 0 : String(data.chat_id).length,
    body_model_option_display_name: modelOption.display_name,
    body_model_option_model_type: modelOption.model_type,
    sub_agent_ids_length: Array.isArray(data?.sub_agent_ids) ? data.sub_agent_ids.length : 0,
    selected_mcp_tools_length: Array.isArray(data?.selected_mcp_tools) ? data.selected_mcp_tools.length : 0,
    attachments_length: Array.isArray(data?.attachments) ? data.attachments.length : 0,
    user_text_length: typeof data?.text === 'string' ? data.text.length : 0,
  }
}

function summarizeMiniMaxSendMsgResponse(status: number, headers: Record<string, any>, data: any): Record<string, any> {
  const responseBody = data && typeof data === 'object' ? data : {}
  return {
    httpStatus: status,
    contentType: headers?.['content-type'] || headers?.['Content-Type'] || 'unknown',
    topLevelResponseKeys: Object.keys(responseBody),
    baseRespStatusCode: responseBody?.base_resp?.status_code,
    baseRespStatusMsg: responseBody?.base_resp?.status_msg,
    statusInfoCode: responseBody?.statusInfo?.code,
    statusInfoMessage: responseBody?.statusInfo?.message,
    hasChatId: responseBody?.chat_id !== undefined && responseBody?.chat_id !== null,
    hasMsgId: responseBody?.msg_id !== undefined && responseBody?.msg_id !== null,
    responseBodyLength: (() => {
      try {
        return JSON.stringify(data ?? {}).length
      } catch {
        return -1
      }
    })(),
  }
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function md5(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex')
}

function unixTimestamp(): number {
  return Math.floor(Date.now() / 1000)
}

function parseMiniMaxError(data: any): { code?: number; message?: string } {
  return {
    code: data?.base_resp?.status_code ?? data?.statusInfo?.code,
    message: data?.base_resp?.status_msg ?? data?.statusInfo?.message,
  }
}

function tokenSplit(authorization: string): string[] {
  const token = authorization.replace('Bearer ', '')
  
  // Check if it's realUserID+JWTtoken format (contains +)
  if (token.includes('+')) {
    // Return the full token for parsing in constructor
    return [token]
  }
  
  // If no +, use the JWT token directly
  return [token]
}

/**
 * Parse JWT token to extract user ID
 * MiniMax JWT payload contains: { user: { id: string, name: string, ... } }
 */
function parseJWTUserID(jwtToken: string): string {
  try {
    // JWT format: header.payload.signature
    const parts = jwtToken.split('.')
    if (parts.length !== 3) {
      return ''
    }
    
    // Base64 decode the payload
    const payload = parts[1]
    // Add padding if needed
    const padding = 4 - (payload.length % 4)
    const paddedPayload = padding !== 4 ? payload + '='.repeat(padding) : payload
    
    const decoded = Buffer.from(paddedPayload, 'base64').toString('utf8')
    const payloadObj = JSON.parse(decoded)
    
    // MiniMax JWT contains user.id
    const userID = payloadObj?.user?.id || ''
    return userID
  } catch (error) {
    console.error('[MiniMax] Failed to parse JWT user id')
    return ''
  }
}

function checkResult(result: AxiosResponse): any {
  if (!result.data) return null
  const { statusInfo, data } = result.data
  if (typeof statusInfo !== 'object') return result.data
  const { code, message } = statusInfo as any
  if (code === 0) return data
  throw new Error(`[请求hailuo失败]: ${message}`)
}

function buildQuery(userData: Record<string, any>): string {
  return Object.keys(userData)
    .filter((key) => userData[key] !== undefined && userData[key] !== null)
    .map((key) => `${key}=${userData[key]}`)
    .join('&')
}

export class MiniMaxAdapter {
  private provider: Provider
  private account: Account
  private rawToken: string
  private jwtToken: string
  private realUserID: string
  private cookies: string
  private configuredChatId?: string | number
  private model: string
  private created: number

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
    this.rawToken = account.credentials.token || ''
    this.cookies = sanitizeCookieHeaderValue(String(account.credentials.cookies || ''))
    this.configuredChatId = normalizeMiniMaxChatId(account.credentials.chatId)
    if (account.credentials.chatId !== undefined && this.configuredChatId === undefined) {
      console.warn('[MiniMax] Ignoring invalid chatId credential: expected numeric or numeric string')
    }
    this.model = 'MiniMax-M2.7'
    this.created = unixTimestamp()

    // Check if realUserID is provided separately in credentials
    const providedRealUserID = account.credentials.realUserID as string | undefined
    
    if (providedRealUserID && providedRealUserID.trim()) {
      // User provided realUserID separately, use it directly
      this.realUserID = providedRealUserID.trim()
      this.jwtToken = this.rawToken
    } else {
      // No separate realUserID, check if token is in realUserID+JWTtoken format
      const tokens = tokenSplit(this.rawToken)
      const fullToken = tokens[0]

      // Check if token is in realUserID+JWTtoken format
      if (fullToken.includes('+')) {
        const parts = fullToken.split('+')
        this.realUserID = parts[0]
        this.jwtToken = parts[1]
      } else {
        // Just JWT token, parse userID from it
        this.jwtToken = fullToken
        this.realUserID = parseJWTUserID(this.jwtToken)
      }
    }
  }

  private async requestDeviceInfo(): Promise<DeviceInfo> {
    const cacheKey = this.rawToken
    let result = deviceInfoMap.get(cacheKey)
    
    if (result && result.refreshTime > unixTimestamp()) {
      return result
    }

    const randomUuid = uuid()
    const unix = `${Date.now()}`
    const timestamp = unixTimestamp()
    
    const userData = { ...LEGACY_QUERY_BASE }
    userData.uuid = randomUuid
    userData.device_id = undefined
    userData.user_id = this.realUserID
    userData.unix = unix
    userData.token = this.jwtToken
    const queryStr = buildQuery(userData)
    
    const dataJson = JSON.stringify({ uuid: randomUuid })
    const fullUri = `/v1/api/user/device/register?${queryStr}`
    const yy = md5(`${encodeURIComponent(fullUri)}_${dataJson}${md5(unix)}ooui`)
    const signature = md5(`${timestamp}${this.jwtToken}${dataJson}`)

    const response = await axios.post(
      `${AGENT_BASE_URL}${fullUri}`,
      { uuid: randomUuid },
      {
        headers: {
          ...FAKE_HEADERS,
          'Content-Type': 'application/json',
          'Referer': `${AGENT_BASE_URL}/`,
          'token': this.jwtToken,
          'x-timestamp': String(timestamp),
          'x-signature': signature,
          'yy': yy,
        },
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    if (response.status !== 200 || response.data?.statusInfo?.code !== 0) {
      throw new Error(`Failed to register device: ${response.data?.statusInfo?.message || response.status}`)
    }

    const data = checkResult(response)

    result = {
      deviceId: data?.deviceIDStr || '',
      userId: this.realUserID,
      realUserID: data?.realUserID || this.realUserID,
      jwtToken: this.jwtToken,
      refreshTime: unixTimestamp() + DEVICE_INFO_EXPIRES,
      uuid: randomUuid,
    }

    deviceInfoMap.set(cacheKey, result)
    return result
  }

  private async requestLegacySigned(
    method: string,
    uri: string,
    data: any,
    deviceInfo: DeviceInfo
  ): Promise<AxiosResponse> {
    const userData = { ...LEGACY_QUERY_BASE }
    const realUserID = deviceInfo.realUserID || deviceInfo.userId
    userData.uuid = deviceInfo.uuid || uuid()
    userData.device_id = deviceInfo.deviceId || undefined
    userData.user_id = realUserID
    const unix = `${Date.now()}`
    const timestamp = unixTimestamp()
    userData.unix = unix
    userData.token = this.jwtToken
    const queryStr = buildQuery(userData)
    const fullUri = `${uri}${uri.lastIndexOf('?') != -1 ? '&' : '?'}${queryStr}`
    const dataJson = JSON.stringify(data || {})
    const yy = md5(`${encodeURIComponent(fullUri)}_${dataJson}${md5(unix)}ooui`)
    const signature = md5(`${timestamp}${this.jwtToken}${dataJson}`)

    return await axios.request({
      method,
      url: `${AGENT_BASE_URL}${fullUri}`,
      data,
      timeout: 15000,
      validateStatus: () => true,
      headers: {
        Referer: `${AGENT_BASE_URL}/`,
        ...FAKE_HEADERS,
        'Content-Type': 'application/json',
        token: this.jwtToken,
        'x-timestamp': String(timestamp),
        'x-signature': signature,
        yy,
      },
    })
  }

  private async requestWebSendMsg(
    method: string,
    uri: string,
    data: any,
    deviceInfo: DeviceInfo
  ): Promise<AxiosResponse> {
    const userData = { ...WEB_QUERY_BASE }
    const realUserID = deviceInfo.realUserID || deviceInfo.userId
    userData.uuid = deviceInfo.uuid || uuid()
    userData.device_id = deviceInfo.deviceId || undefined
    userData.user_id = realUserID
    userData.unix = `${Date.now()}`
    userData.token = this.jwtToken
    const queryStr = buildQuery(userData)
    const fullUri = `${uri}${uri.lastIndexOf('?') != -1 ? '&' : '?'}${queryStr}`
    const requestHeaders: Record<string, string> = {
      Referer: `${AGENT_BASE_URL}/`,
      ...FAKE_HEADERS,
      'Content-Type': 'application/json',
    }

    if (this.cookies) {
      requestHeaders.Cookie = this.cookies
    }

    if (MINIMAX_SEND_DEBUG) {
      console.log('[MiniMax][send_msg][request]', summarizeMiniMaxSendMsgRequest(method, uri, userData, requestHeaders, data, this.configuredChatId))
    }

    const response = await axios.request({
      method,
      url: `${AGENT_BASE_URL}${fullUri}`,
      data,
      timeout: 15000,
      validateStatus: () => true,
      headers: requestHeaders,
    })

    if (MINIMAX_SEND_DEBUG) {
      console.log('[MiniMax][send_msg][response]', summarizeMiniMaxSendMsgResponse(response.status, response.headers || {}, response.data))
    }

    return response
  }

  private resolveModelOption(model: string): { display_name: string; model_type: number } {
    return MODEL_OPTIONS[model] || { display_name: model, model_type: 501 }
  }

  private extractFinalUserText(messages: MiniMaxMessage[], toolsPrompt?: string): string {
    let finalText = ''
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        finalText = typeof messages[i].content === 'string' ? messages[i].content : ''
        break
      }
    }
    if (toolsPrompt) {
      finalText = finalText.trim() ? `${finalText}\n\n${toolsPrompt}` : toolsPrompt
    }
    return finalText
  }

  private messagesPrepare(messages: MiniMaxMessage[], model: string, toolsPrompt?: string): any {
    return {
      msg_type: 1,
      text: this.extractFinalUserText(messages, toolsPrompt),
      chat_type: 2,
      attachments: [],
      selected_mcp_tools: [],
      sub_agent_ids: DEFAULT_SUB_AGENT_IDS,
      model_option: this.resolveModelOption(model),
    }
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{ response: AxiosResponse | null; stream: { session: ClientHttp2Session; stream: ClientHttp2Stream } | null; chatId: string }> {
    this.model = request.model || 'MiniMax-M2.7'
    this.created = unixTimestamp()
    
    const deviceInfo = await this.requestDeviceInfo()
    
    const messages = [...request.messages]
    
    let toolsPrompt = ''
    // Only inject if tools are provided and not already injected by client
    if (request.tools && request.tools.length > 0 && !hasToolPromptInjected(request.messages)) {
      toolsPrompt = toolsToSystemPrompt(request.tools)
      
      // Find and update the last user message
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          const currentContent = messages[i].content
          if (typeof currentContent === 'string') {
            messages[i] = { ...messages[i], content: currentContent + TOOL_WRAP_HINT }
          }
          break
        }
      }
    }
    
    const requestBody = this.messagesPrepare(messages, this.model, toolsPrompt)
    
    let msgId: string = ''
    const effectiveChatId = request.chatId || (this.configuredChatId !== undefined ? String(this.configuredChatId) : '')
    let chatId: string = effectiveChatId

    if (effectiveChatId) {
      const sendResponse = await this.requestWebSendMsg('POST', '/matrix/api/v1/chat/send_msg', {
        ...requestBody,
        chat_id: this.configuredChatId !== undefined && !request.chatId ? this.configuredChatId : effectiveChatId,
      }, deviceInfo)
      const { code, message } = parseMiniMaxError(sendResponse.data)
      if (sendResponse.status !== 200 || code !== 0) {
        throw new Error(`MiniMax send_msg failed (HTTP ${sendResponse.status}, code ${code ?? 'unknown'}): ${message || 'Unknown error'}`)
      }
      const { msg_id } = sendResponse.data
      msgId = msg_id
    } else {
      const sendResponse = await this.requestWebSendMsg('POST', '/matrix/api/v1/chat/send_msg', requestBody, deviceInfo)
      const result = sendResponse.data
      const { code, message } = parseMiniMaxError(result)
      if (sendResponse.status !== 200 || code !== 0) {
        throw new Error(`MiniMax send_msg failed (HTTP ${sendResponse.status}, code ${code ?? 'unknown'}): ${message || 'Unknown error'}`)
      }
      chatId = result.chat_id
      msgId = result.msg_id
    }
    
    if (request.stream === true) {
      // Only delete chat in single-turn mode with deleteAfterChat enabled
      // Import shouldDeleteSession from forwarder
      const shouldDeleteSession = () => {
        const config = (global as any).storeManager?.getConfig()
        return config?.mode === 'single' && config?.deleteAfterTimeout
      }
      
      const onEnd = shouldDeleteSession() ? async (chatId: string) => {
        await this.deleteChat(chatId)
      } : undefined
      
      const transStream = this.createPollingStream(chatId, deviceInfo, this.model, onEnd)
      return { 
        response: null, 
        stream: { session: null as any, stream: transStream as any }, 
        chatId 
      }
    }
    
    const aiMessage = await this.pollForResponse(chatId, deviceInfo)
    
    // Delete chat after response if in single-turn mode with deleteAfterChat enabled
    const shouldDeleteSession = () => {
      const config = (global as any).storeManager?.getConfig()
      return config?.mode === 'single' && config?.deleteAfterTimeout
    }
    
    if (shouldDeleteSession()) {
      await this.deleteChat(chatId).catch(err => console.error('[MiniMax] Failed to delete chat:', err))
    }
    
    const content = aiMessage?.msg_content || ''
    const thinkingContent = aiMessage?.extra_info?.thinking_content || ''
    const { content: cleanContent, toolCalls } = parseToolCallsFromText(content, 'minimax')
    
    const response = {
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
      data: {
        id: String(chatId),
        model: this.model,
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: toolCalls.length > 0 ? null : cleanContent,
            ...(thinkingContent ? { reasoning_content: thinkingContent } : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
          },
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        created: this.created,
      },
    }
    
    return { response, stream: null, chatId }
  }

  private async pollForResponse(chatId: string, deviceInfo: DeviceInfo, maxPolls = 120, pollInterval = 1000): Promise<any> {
    let pollCount = 0
    
    while (pollCount < maxPolls) {
      await new Promise(resolve => setTimeout(resolve, pollInterval))
      pollCount++
      
      const detailResponse = await this.requestLegacySigned('POST', '/matrix/api/v1/chat/get_chat_detail', { chat_id: chatId }, deviceInfo)
      
      if (detailResponse.status !== 200) {
        console.log('[MiniMax] Poll failed, status:', detailResponse.status)
        continue
      }
      
      const { messages, base_resp } = detailResponse.data
      
      if (base_resp?.status_code !== 0) {
        console.log('[MiniMax] Poll failed, status_code:', base_resp?.status_code)
        continue
      }
      
      // Find AI response (msg_type === 2)
      const aiMessage = messages?.find((msg: any) => msg.msg_type === 2)
      
      if (aiMessage && aiMessage.msg_content) {
        console.log('[MiniMax] AI response received after', pollCount, 'polls')
        return aiMessage
      }
    }
    
    throw new Error(`No AI response after ${maxPolls} polls`)
  }

  private createPollingStream(chatId: string, deviceInfo: DeviceInfo, model: string, onEnd?: (chatId: string) => Promise<void>): PassThrough {
    const transStream = new PassThrough()
    const created = this.created
    let lastContent = ''
    let lastThinkingContent = ''
    let pollCount = 0
    const maxPolls = 120
    const pollInterval = 500
    const toolCallState = createToolCallState()
    let sentRole = false
    let sentThinkingRole = false
    let lastMsgId = ''
    
    const poll = async () => {
      try {
        while (pollCount < maxPolls) {
          await new Promise(resolve => setTimeout(resolve, pollInterval))
          pollCount++
          
          const detailResponse = await this.requestLegacySigned('POST', '/matrix/api/v1/chat/get_chat_detail', { chat_id: chatId }, deviceInfo)
          
          if (detailResponse.status !== 200) {
            console.log('[MiniMax] Poll status:', detailResponse.status)
            continue
          }
          
          const { messages, chat, base_resp } = detailResponse.data
          if (base_resp?.status_code !== 0) {
            console.log('[MiniMax] Poll base_resp:', base_resp)
            continue
          }
          
          const chatStatus = chat?.chat_status || 0
          
          console.log('[MiniMax] Poll #' + pollCount + ' - chat_status:', chatStatus, 'messages count:', messages?.length)
          
          if (messages && messages.length > 0) {
            console.log('[MiniMax] Message details:', messages.map((m: any) => ({ 
              msg_id: m.msg_id, 
              msg_type: m.msg_type, 
              content_len: m.msg_content?.length || 0,
              has_thinking: !!m.extra_info?.thinking_content,
              thinking_len: m.extra_info?.thinking_content?.length || 0
            })))
          }
          
          const aiMessages = messages?.filter((msg: any) => msg.msg_type === 2)
          const aiMessage = aiMessages?.length > 0 ? aiMessages[aiMessages.length - 1] : null
          
          console.log('[MiniMax] AI messages count:', aiMessages?.length, 'using last message')
          
          if (aiMessage && aiMessage.msg_content) {
            const currentContent = aiMessage.msg_content
            const currentThinkingContent = aiMessage?.extra_info?.thinking_content || ''
            const currentMsgId = aiMessage.msg_id || ''
            
            if (currentMsgId !== lastMsgId && lastMsgId !== '') {
              console.log('[MiniMax] New AI message detected, msg_id changed from', lastMsgId, 'to', currentMsgId)
              lastContent = ''
              lastThinkingContent = ''
            }
            
            console.log('[MiniMax] AI message found - msg_id:', currentMsgId, 
              'content_len:', currentContent.length, 
              'thinking_len:', currentThinkingContent.length,
              'last_content_len:', lastContent.length,
              'last_thinking_len:', lastThinkingContent.length)
            
            if (currentThinkingContent && currentThinkingContent.length > lastThinkingContent.length) {
              const newThinkingChunk = currentThinkingContent.substring(lastThinkingContent.length)
              
              if (newThinkingChunk.trim()) {
                if (!sentThinkingRole) {
                  transStream.write(`data: ${JSON.stringify({
                    id: chatId.toString(),
                    model,
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
                    created,
                  })}\n\n`)
                  sentThinkingRole = true
                }
                
                transStream.write(`data: ${JSON.stringify({
                  id: chatId.toString(),
                  model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { reasoning_content: newThinkingChunk }, finish_reason: null }],
                  created,
                })}\n\n`)
              }
              
              lastThinkingContent = currentThinkingContent
            }
            
            if (currentContent.length > lastContent.length) {
              const newChunk = currentContent.substring(lastContent.length)
              
              const baseChunk = createBaseChunk(chatId.toString(), model, created)
              const { chunks: outputChunks } = processStreamContent(
                newChunk, 
                toolCallState, 
                baseChunk, 
                !sentRole,
                'minimax'
              )

              for (const outChunk of outputChunks) {
                transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
              }

              if (outputChunks.length > 0) sentRole = true
              
              lastContent = currentContent
            }
            
            lastMsgId = currentMsgId
            
            if (chatStatus === 2 && aiMessage.msg_content) {
              console.log('[MiniMax] Stream completed - chat_status: 2, polls:', pollCount, 'content length:', lastContent.length, 'thinking length:', lastThinkingContent.length)
              
              const baseChunk = createBaseChunk(chatId.toString(), model, created)
              const flushChunks = flushToolCallBuffer(toolCallState, baseChunk, 'minimax')
              
              for (const outChunk of flushChunks) {
                transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
              }
              
              const finishReason = toolCallState.hasEmittedToolCall ? 'tool_calls' : 'stop'
              
              transStream.write(
                `data: ${JSON.stringify({
                  id: chatId.toString(),
                  model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                  created,
                })}\n\n`
              )
              transStream.end('data: [DONE]\n\n')
              if (onEnd) {
                onEnd(chatId).catch(err => console.error('[MiniMax] Failed to delete chat:', err))
              }
              return
            }
            
            lastMsgId = currentMsgId
          }
        }
        
        console.log('[MiniMax] Stream timeout after', maxPolls, 'polls')
        transStream.end('data: [DONE]\n\n')
      } catch (err) {
        console.error('[MiniMax] Polling error:', err)
        transStream.end('data: [DONE]\n\n')
      }
    }
    
    poll()
    
    return transStream
  }

  async deleteChat(chatId: string): Promise<boolean> {
    const maxRetries = 3
    const retryDelay = 2000
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const deviceInfo = await this.requestDeviceInfo()
        const response = await this.requestLegacySigned('POST', '/matrix/api/v1/chat/delete_chat', { chat_id: parseInt(chatId, 10) }, deviceInfo)
        console.log('[MiniMax] Chat deleted attempt', attempt, ':', chatId, 'Status:', response.status, 'Response:', JSON.stringify(response.data))
        
        if (response.status === 200 && response.data?.base_resp?.status_code === 0) {
          return true
        }
        
        const errorMsg = response.data?.base_resp?.status_msg || 'Unknown error'
        
        if (errorMsg.includes('chat is running') && attempt < maxRetries) {
          console.log(`[MiniMax] Chat still running, waiting ${retryDelay}ms before retry...`)
          await new Promise(resolve => setTimeout(resolve, retryDelay))
          continue
        }
        
        console.warn('[MiniMax] Delete chat failed:', errorMsg)
        return false
      } catch (error) {
        console.error('[MiniMax] Failed to delete chat:', error)
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryDelay))
          continue
        }
        return false
      }
    }
    
    return false
  }

  async getUserInfo(): Promise<any> {
    const deviceInfo = await this.requestDeviceInfo()
    const response = await this.requestLegacySigned('GET', '/v1/api/user/info', {}, deviceInfo)
    if (response.status !== 200 || response.data?.statusInfo?.code !== 0) {
      throw new Error(`Failed to get user info: ${response.data?.statusInfo?.message || response.status}`)
    }
    return response.data.data
  }

  async getCredits(): Promise<CreditInfo> {
    try {
      const deviceInfo = await this.requestDeviceInfo()
      
      const response = await this.requestLegacySigned('POST', '/matrix/api/v1/commerce/get_membership_info', {}, deviceInfo)
      
      console.log('[MiniMax] get_membership_info status:', response.status)
      
      if (response.status === 200 && response.data?.base_resp?.status_code === 0) {
        const data = response.data
        const remainingCredits = data?.daily_login_gift_credit_remaining || 0
        
        // Get credit expires timestamp (resets at next day 00:00)
        let expiresAt: number | undefined = undefined
        const creditsData = data?.credits?.['4']?.[0]
        if (creditsData?.expires_at) {
          // expires_at is in milliseconds, use it directly
          expiresAt = creditsData.expires_at
        }
        
        if (expiresAt) {
          console.log('[MiniMax] Credit expires at:', new Date(expiresAt).toISOString())
        }
        console.log('[MiniMax] Credits:', { remainingCredits, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined })
        
        return {
          totalCredits: 0, // Not available
          usedCredits: 0, // Not available
          remainingCredits,
          expiresAt,
        }
      }
      
      console.warn('[MiniMax] Failed to get membership info, token may be expired or invalid')
      return { totalCredits: 0, usedCredits: 0, remainingCredits: 0 }
    } catch (error) {
      console.error('[MiniMax] Failed to get credits:', error instanceof Error ? error.message : 'Unknown error')
      return { totalCredits: 0, usedCredits: 0, remainingCredits: 0 }
    }
  }

  async getChatList(): Promise<ChatListItem[]> {
    const allChats: ChatListItem[] = []
    let nextPageIndexId: number | undefined = undefined
    const pageSize = 100
    
    try {
      const deviceInfo = await this.requestDeviceInfo()
      
      while (true) {
        const requestBody: any = {
          page_size: pageSize,
          workspace_storage_mode: 0,
        }
        
        if (nextPageIndexId !== undefined) {
          requestBody.next_page_index_id = nextPageIndexId
        }
        
        const response = await this.requestLegacySigned('POST', '/matrix/api/v1/chat/list_chat', requestBody, deviceInfo)
        
        console.log('[MiniMax] list_chat response status:', response.status)
        
        if (response.status !== 200 || response.data?.base_resp?.status_code !== 0) {
          console.error('[MiniMax] Failed to get chat list:', response.data?.base_resp?.status_msg)
          break
        }
        
        const chatList = response.data?.chats || response.data?.chat_list || []
        console.log('[MiniMax] Received chats count:', chatList.length)
        if (chatList.length === 0) {
          break
        }
        
        allChats.push(...chatList)
        
        if (chatList.length < pageSize) {
          break
        }
        
        nextPageIndexId = chatList[chatList.length - 1]?.chat_id
      }
      
      console.log('[MiniMax] Got chat list, total:', allChats.length)
      return allChats
    } catch (error) {
      console.error('[MiniMax] Failed to get chat list:', error)
      return []
    }
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      console.log('[MiniMax] Starting to delete all chats...')
      
      const chatList = await this.getChatList()
      if (chatList.length === 0) {
        console.log('[MiniMax] No chats to delete')
        return true
      }
      
      console.log('[MiniMax] Found', chatList.length, 'chats to delete')
      
      let successCount = 0
      let failCount = 0
      
      for (const chat of chatList) {
        const result = await this.deleteChat(String(chat.chat_id))
        if (result) {
          successCount++
        } else {
          failCount++
        }
        
        if (successCount % 10 === 0) {
          console.log(`[MiniMax] Deleted ${successCount}/${chatList.length} chats...`)
        }
      }
      
      console.log(`[MiniMax] Delete all chats completed. Success: ${successCount}, Failed: ${failCount}`)
      return failCount === 0
    } catch (error) {
      console.error('[MiniMax] Failed to delete all chats:', error)
      return false
    }
  }

  static isMiniMaxProvider(provider: Provider): boolean {
    return provider.id === 'minimax' || 
           provider.apiEndpoint.includes('minimaxi.com') ||
           provider.apiEndpoint.includes('hailuoai.com')
  }
}

export class MiniMaxStreamHandler {
  private chatId: string = ''
  private model: string
  private created: number
  private onEnd?: (chatId: string) => void
  private toolCallState: ToolCallState
  private sentRole: boolean = false

  constructor(model: string, onEnd?: (chatId: string) => void) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallState = createToolCallState()
  }

  setChatId(chatId: string) {
    this.chatId = chatId
  }

  getChatId(): string {
    return this.chatId
  }

  handleStream(stream: ClientHttp2Stream): PassThrough {
    const transStream = new PassThrough()
    let content = ''
    let hasReceivedData = false
    let httpStatus: number | null = null
    let buffer = ''

    console.log('[MiniMax] Starting stream handler...')

    // Listen for HTTP/2 response headers to check status code
    stream.once('response', (headers: http2.IncomingHttpHeaders) => {
      const statusValue = headers[':status']
      httpStatus = 200
      if (typeof statusValue === 'string') {
        httpStatus = parseInt(statusValue, 10)
      } else if (typeof statusValue === 'number') {
        httpStatus = statusValue
      }

      console.log('[MiniMax] HTTP/2 response status:', httpStatus)

      // If status is not 200, emit error and close stream
      if (httpStatus >= 400) {
        const errorMessage = `MiniMax API error: HTTP ${httpStatus}`
        console.error('[MiniMax]', errorMessage)

        // Emit error event on the transform stream for the client to handle
        transStream.emit('error', new Error(errorMessage))
        transStream.end()
        return
      }
    })

    // Use SSE parser for event stream format
    const parser = createParser({
      onEvent: (event: EventSourceMessage) => {
        try {
          hasReceivedData = true
          const eventName = event.event
          if (event.data === '[DONE]') return

          console.log('[MiniMax] SSE event:', eventName, 'data:', event.data?.substring(0, 100))

          const result = JSON.parse(event.data)
          const { type, base_resp, statusInfo, data: _data } = result

          if (type === 8) {
            // Flush any remaining tool calls
            const baseChunk = createBaseChunk(this.chatId, this.model, this.created)
            const flushChunks = flushToolCallBuffer(this.toolCallState, baseChunk, 'minimax')
            
            for (const outChunk of flushChunks) {
              transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
            }
            
            const finishReason = this.toolCallState.hasEmittedToolCall ? 'tool_calls' : 'stop'
            transStream.write(
              `data: ${JSON.stringify({
                id: this.chatId,
                model: this.model,
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                created: this.created,
              })}\n\n`
            )
            transStream.end('data: [DONE]\n\n')
            if (this.onEnd) this.onEnd(this.chatId)
            return
          }

          const respCode = base_resp?.status_code ?? statusInfo?.code
          const respMessage = base_resp?.status_msg ?? statusInfo?.message
          if (respCode !== 0 && respCode !== undefined && type !== 3) {
            throw new Error(`Stream response error: ${respMessage}`)
          }

          const { messageResult } = _data || {}
          if (eventName === 'message_result' && messageResult) {
            const { chatID, chat_id, isEnd, content: text } = messageResult
            const finalChatId = chat_id || chatID

            if (isEnd !== 0 && !text) return

            if (!this.chatId && finalChatId) this.chatId = finalChatId

            const exceptCharIndex = text.indexOf('')
            const chunk = text.substring(
              exceptCharIndex !== -1
                ? Math.min(content.length, exceptCharIndex)
                : content.length,
              exceptCharIndex === -1 ? text.length : exceptCharIndex
            )
            content += chunk

            console.log('[MiniMax] Stream chunk:', chunk.substring(0, 50), 'isEnd:', isEnd)

            // Process tool call interception
            const baseChunk = createBaseChunk(this.chatId, this.model, this.created)
            const { chunks: outputChunks } = processStreamContent(
              chunk, 
              this.toolCallState, 
              baseChunk, 
              !this.sentRole,
              'minimax'
            )

            for (const outChunk of outputChunks) {
              transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
            }

            if (outputChunks.length > 0) this.sentRole = true

            if (isEnd === 0) {
              // Flush any remaining tool calls
              const flushChunks = flushToolCallBuffer(this.toolCallState, baseChunk, 'minimax')
              
              for (const outChunk of flushChunks) {
                transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
              }
              
              const finishReason = this.toolCallState.hasEmittedToolCall ? 'tool_calls' : 'stop'
              transStream.write(
                `data: ${JSON.stringify({
                  id: this.chatId,
                  model: this.model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                  created: this.created,
                })}\n\n`
              )
              transStream.end('data: [DONE]\n\n')
              if (this.onEnd) this.onEnd(this.chatId)
            }
          }
        } catch (err) {
          console.error('[MiniMax] Stream parse error:', err)
          transStream.emit('error', err instanceof Error ? err : new Error(String(err)))
          transStream.end()
        }
      }
    })

    stream.on('data', (chunk: Buffer) => {
      hasReceivedData = true
      const chunkStr = chunk.toString()
      console.log('[MiniMax] Raw chunk:', chunkStr.substring(0, 200))

      // Try to parse as SSE first
      if (chunkStr.includes('event:') || chunkStr.includes('data:')) {
        parser.feed(chunkStr)
      } else {
        // Try to parse as direct JSON (non-SSE format)
        buffer += chunkStr
        const lines = buffer.split('\n')
        buffer = lines.pop() || '' // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const result = JSON.parse(line)
            console.log('[MiniMax] Parsed JSON:', result)

            const { type, base_resp, statusInfo, data: _data, chat_id, msg_id } = result

            // Handle initial response with chat_id
            if (chat_id && !this.chatId) {
              this.chatId = chat_id
              console.log('[MiniMax] Set chatId:', this.chatId)
              continue
            }

            // Handle type 8 (end of stream)
            if (type === 8) {
              transStream.write(
                `data: ${JSON.stringify({
                  id: this.chatId,
                  model: this.model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  created: this.created,
                })}\n\n`
              )
              transStream.end('data: [DONE]\n\n')
              if (this.onEnd) this.onEnd(this.chatId)
              return
            }

            // Check for errors
            const respCode = base_resp?.status_code ?? statusInfo?.code
            const respMessage = base_resp?.status_msg ?? statusInfo?.message
            if (respCode !== 0 && respCode !== undefined && type !== 3) {
              console.error('[MiniMax] Stream response error:', respMessage)
              continue
            }

            // Handle message result
            const { messageResult } = _data || {}
            if (messageResult) {
              const { chatID, chat_id: agentChatId, isEnd, content: text } = messageResult
              const finalChatId = agentChatId || chatID

              if (isEnd !== 0 && !text) continue

              if (!this.chatId && finalChatId) this.chatId = finalChatId

              const exceptCharIndex = text.indexOf('')
              const chunk = text.substring(
                exceptCharIndex !== -1
                  ? Math.min(content.length, exceptCharIndex)
                  : content.length,
                exceptCharIndex === -1 ? text.length : exceptCharIndex
              )
              content += chunk

              console.log('[MiniMax] Stream chunk:', chunk.substring(0, 50), 'isEnd:', isEnd)

              transStream.write(
                `data: ${JSON.stringify({
                  id: this.chatId,
                  model: this.model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { content: chunk }, finish_reason: isEnd === 0 ? 'stop' : null }],
                  created: this.created,
                })}\n\n`
              )

              if (isEnd === 0) {
                transStream.end('data: [DONE]\n\n')
                if (this.onEnd) this.onEnd(this.chatId)
              }
            }
          } catch (err) {
            // Not valid JSON, might be SSE format
            parser.feed(line + '\n')
          }
        }
      }
    })

    stream.once('error', (err: Error) => {
      console.error('[MiniMax] Stream error:', err)
      transStream.emit('error', err)
      transStream.end()
    })

    stream.once('close', () => {
      console.log('[MiniMax] Stream closed, hasReceivedData:', hasReceivedData, 'httpStatus:', httpStatus)
      // Process any remaining data in buffer
      if (buffer.trim()) {
        try {
          const result = JSON.parse(buffer.trim())
          console.log('[MiniMax] Processing remaining buffer:', result)
        } catch (e) {
          parser.feed(buffer)
        }
      }
      // Only end gracefully if we received data successfully
      if (hasReceivedData || (httpStatus && httpStatus < 400)) {
        transStream.end('data: [DONE]\n\n')
      }
    })

    return transStream
  }

  async handleNonStream(stream: any): Promise<any> {
    // Parameter 'stream' is response.data from forwarder.ts (the actual stream/data)
    return new Promise((resolve, reject) => {
      const data = {
        id: '',
        model: this.model,
        object: 'chat.completion',
        choices: [{ 
          index: 0, 
          message: { 
            role: 'assistant', 
            content: '', 
            reasoning_content: '' 
          }, 
          finish_reason: 'stop' 
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        created: this.created,
      }

      const parser = createParser({
        onEvent: (event: EventSourceMessage) => {
          try {
            if (event.data === '[DONE]') return
            const result = JSON.parse(event.data)
            const { type, base_resp, statusInfo, data: _data } = result
            const respCode = base_resp?.status_code ?? statusInfo?.code
            const respMessage = base_resp?.status_msg ?? statusInfo?.message
            if (respCode !== 0 && respCode !== undefined && type !== 3) {
              throw new Error(`Stream response error: ${respMessage}`)
            }
            const { messageResult } = _data || {}
            if (event.event === 'message_result' && messageResult) {
              const { chatID, chat_id, isEnd, content: text, extra_info } = messageResult
              const finalChatId = chat_id || chatID
              if (!data.id && finalChatId) data.id = finalChatId
              if (isEnd !== 0 && text) data.choices[0].message.content += text
              // Extract thinking_content from extra_info
              if (extra_info?.thinking_content) {
                data.choices[0].message.reasoning_content = extra_info.thinking_content
              }
              if (isEnd === 0) resolve(data)
            }
          } catch (err) {
            reject(err)
          }
        },
      })

      stream.on('data', (buffer: Buffer) => parser.feed(buffer.toString()))
      stream.once('error', reject)
      stream.once('close', () => resolve(data))
    })
  }
}

export const minimaxAdapter = {
  MiniMaxAdapter,
  MiniMaxStreamHandler,
}
