/**
 * DeepSeek Stream Response Handler
 * Converts DeepSeek SSE stream to OpenAI compatible format
 */

import { PassThrough } from 'stream'
import { parseToolCallsFromText } from '../utils/toolParser'
import { 
  createToolCallState, 
  processStreamContent, 
  flushToolCallBuffer,
  createBaseChunk,
  ToolCallState 
} from '../utils/streamToolHandler'

interface StreamChunk {
  p?: string
  v?: any
  response_message_id?: string
  o?: string
}

type FragmentKind = 'thinking' | 'content' | ''

export class DeepSeekStreamHandler {
  private model: string
  private sessionId: string
  private isFirstChunk: boolean = true
  private messageId: string = ''
  private currentPath: string = ''
  private searchResults: any[] = []
  private thinkingStarted: boolean = false
  private accumulatedTokenUsage: number = 2
  private created: number
  private onEnd?: () => void
  private toolCallState: ToolCallState
  private webSearchEnabled: boolean
  private reasoningEffort: string | undefined
  private doneHandled: boolean = false
  private deepSeekUpstreamDebugEnabled: boolean
  private upstreamDataLineIndex: number = 0
  private streamVisibleContentLength: number = 0
  private streamThinkingContentLength: number = 0

  constructor(
    model: string,
    sessionId: string,
    onEnd?: () => void,
    webSearchEnabled: boolean = false,
    reasoningEffort?: string
  ) {
    this.model = model
    this.sessionId = sessionId
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallState = createToolCallState()
    this.webSearchEnabled = webSearchEnabled
    this.reasoningEffort = reasoningEffort
    this.deepSeekUpstreamDebugEnabled = process.env.CHAT2API_DEEPSEEK_UPSTREAM_DEBUG === '1'
  }

  getLastMessageId(): string {
    return this.messageId
  }

  private parseSSE(data: string): StreamChunk | null {
    try {
      return JSON.parse(data)
    } catch {
      return null
    }
  }

  private debugDeepSeekUpstreamSSE(dataLine: string, parsed: StreamChunk | null): void {
    if (!this.deepSeekUpstreamDebugEnabled) return

    this.upstreamDataLineIndex += 1

    const payload: Record<string, any> = {
      line_index: this.upstreamDataLineIndex,
      parse_ok: !!parsed,
    }

    if (!parsed) {
      payload.raw_kind = dataLine.startsWith('{') ? 'json_unparsed' : 'non_json'
      console.log('[DeepSeek][UpstreamSSE]', JSON.stringify(payload))
      return
    }

    const parsedAsRecord = parsed as Record<string, any>
    payload.top_level_keys = Object.keys(parsedAsRecord)
    if (typeof parsed.p === 'string') payload.p = parsed.p
    if (typeof parsed.o === 'string') payload.o = parsed.o
    if (parsed.v !== undefined) {
      payload.v_type = Array.isArray(parsed.v) ? 'array' : typeof parsed.v
    }

    if (parsed.v && typeof parsed.v === 'object' && !Array.isArray(parsed.v)) {
      const vRecord = parsed.v as Record<string, any>
      payload.v_keys = Object.keys(vRecord)
      if (vRecord.response && typeof vRecord.response === 'object') {
        const response = vRecord.response as Record<string, any>
        payload.response_keys = Object.keys(response)
        if (Array.isArray(response.fragments)) {
          payload.response_fragments = {
            count: response.fragments.length,
            types: response.fragments.map((fragment: any) => fragment?.type || 'unknown'),
            content_lengths: response.fragments.map((fragment: any) =>
              typeof fragment?.content === 'string' ? fragment.content.length : 0
            ),
          }
        }
      }
    }

    if (parsed.p === 'response/fragments' && parsed.o === 'APPEND' && Array.isArray(parsed.v)) {
      payload.appended_fragments = parsed.v.map((fragment: any) => ({
        type: fragment?.type || 'unknown',
        content_length: typeof fragment?.content === 'string' ? fragment.content.length : 0,
      }))
    }

    if (parsed.p === 'response/fragments/-1/content' && typeof parsed.v === 'string') {
      payload.content_append_length = parsed.v.length
    }

    if (!parsed.p && typeof parsed.v === 'string') {
      payload.bare_v_length = parsed.v.length
    }

    payload.accumulated_visible_content_length = this.streamVisibleContentLength
    payload.accumulated_thinking_content_length = this.streamThinkingContentLength
    console.log('[DeepSeek][UpstreamSSE]', JSON.stringify(payload))
  }

  private createChunk(delta: { role?: string; content?: string; reasoning_content?: string; tool_calls?: any[] }, finishReason?: string): string {
    return `data: ${JSON.stringify({
      id: `${this.sessionId}@${this.messageId}`,
      model: this.model,
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason || null,
      }],
      created: this.created,
    })}\n\n`
  }

  private normalizeContent(content: string, isSearchSilentModel: boolean): string {
    const cleanedValue = content.replace(/FINISHED/g, '')
    const filteredForSearch = cleanedValue.replace(/^(SEARCH|WEB_SEARCH|SEARCHING)\s*/i, '')
    return isSearchSilentModel
      ? filteredForSearch.replace(/\[citation:(\d+)\]/g, '')
      : filteredForSearch.replace(/\[citation:(\d+)\]/g, '[$1]')
  }

  private extractTextFromValue(value: any): string {
    if (typeof value === 'string') {
      return value
    }
    if (!value || typeof value !== 'object') {
      return ''
    }
    if (Array.isArray(value)) {
      return value.map(item => this.extractTextFromValue(item)).join('')
    }

    const directFields = ['content', 'text', 'answer']
    let text = ''
    for (const field of directFields) {
      if (typeof value[field] === 'string') {
        text += value[field]
      }
    }

    if (Array.isArray(value.chunks)) {
      text += value.chunks.map((chunk: any) => this.extractTextFromValue(chunk)).join('')
    }

    if (value.v !== undefined) {
      text += this.extractTextFromValue(value.v)
    }

    if (value.value !== undefined) {
      text += this.extractTextFromValue(value.value)
    }

    return text
  }

  async handleStream(stream: NodeJS.ReadableStream): Promise<NodeJS.ReadableStream> {
    const transStream = new PassThrough()
    const isThinkingModel = this.model.includes('think') || this.model.includes('r1') || !!this.reasoningEffort
    const isSilentModel = this.model.includes('silent')
    const isFoldModel = (this.model.includes('fold') || this.model.includes('search') || this.webSearchEnabled) && !isThinkingModel
    const isSearchSilentModel = this.model.includes('search-silent')

    let buffer = ''

    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.trim() || !line.startsWith('data:')) continue

        const data = line.slice(5).trim()
        if (data === '[DONE]') {
          if (this.deepSeekUpstreamDebugEnabled) {
            console.log('[DeepSeek][UpstreamSSE]', JSON.stringify({
              line_index: this.upstreamDataLineIndex + 1,
              status: 'done_marker_received',
              accumulated_visible_content_length: this.streamVisibleContentLength,
              accumulated_thinking_content_length: this.streamThinkingContentLength,
            }))
          }
          this.handleDone(transStream, isFoldModel, isSearchSilentModel)
          return
        }

        const parsed = this.parseSSE(data)
        this.debugDeepSeekUpstreamSSE(data, parsed)
        if (!parsed) continue

        this.processChunk(parsed, transStream, isThinkingModel, isSilentModel, isFoldModel, isSearchSilentModel)
      }
    })

    stream.on('end', () => {
      this.handleDone(transStream, isFoldModel, isSearchSilentModel)
    })

    stream.on('error', (err) => {
      transStream.emit('error', err)
    })

    return transStream
  }

  private processChunk(
    chunk: StreamChunk,
    transStream: PassThrough,
    isThinkingModel: boolean,
    isSilentModel: boolean,
    isFoldModel: boolean,
    isSearchSilentModel: boolean
  ): void {
    let handledFragments = false

    if (chunk.response_message_id && !this.messageId) {
      this.messageId = chunk.response_message_id
    }

    if (chunk.v && typeof chunk.v === 'object' && chunk.v.response) {
      const fragments = chunk.v.response.fragments
      if (Array.isArray(fragments) && fragments.length > 0) {
        handledFragments = true
        for (const fragment of fragments) {
          const kind = this.getFragmentKind(fragment?.type)
          if (kind) {
            this.currentPath = kind
          }
          if (fragment?.content && kind) {
            this.sendContent(fragment.content, kind, transStream, isSilentModel, isFoldModel, isSearchSilentModel)
          }
        }
      }
    } else if (chunk.p === 'response/fragments' && chunk.o === 'APPEND') {
      if (Array.isArray(chunk.v)) {
        handledFragments = true
        for (const fragment of chunk.v) {
          const kind = this.getFragmentKind(fragment?.type)
          if (kind) {
            this.currentPath = kind
          }
          if (fragment?.content && kind) {
            this.sendContent(fragment.content, kind, transStream, isSilentModel, isFoldModel, isSearchSilentModel)
          }
        }
      }
    }

    if (chunk.p === 'response/search_status') return

    if (chunk.p === 'response' && Array.isArray(chunk.v)) {
      chunk.v.forEach((e: any) => {
        if (e.p === 'accumulated_token_usage' && typeof e.v === 'number') {
          this.accumulatedTokenUsage = e.v
        }
      })
    }

    if (chunk.p === 'response/search_results' && Array.isArray(chunk.v)) {
      if (chunk.o !== 'BATCH') {
        this.searchResults = chunk.v
      } else {
        chunk.v.forEach((op: any) => {
          const match = op.p?.match(/^(\d+)\/cite_index$/)
          if (match) {
            const index = parseInt(match[1], 10)
            if (this.searchResults[index]) {
              this.searchResults[index].cite_index = op.v
            }
          }
        })
      }
      return
    }

    let content = ''
    if (!handledFragments && this.shouldExtractChunkText(chunk)) {
      content = this.extractTextFromValue(chunk.v)
    }

    if (!content) return

    // For thinking models, default to 'thinking' path if not set
    let effectivePath = this.currentPath
    if (!effectivePath && isThinkingModel) {
      effectivePath = 'thinking'
    }

    this.sendContent(content, effectivePath, transStream, isSilentModel, isFoldModel, isSearchSilentModel)
  }

  private getFragmentKind(fragmentType: unknown): FragmentKind {
    if (fragmentType === 'THINK') return 'thinking'
    if (fragmentType === 'ANSWER' || fragmentType === 'RESPONSE') return 'content'
    return ''
  }

  private shouldExtractChunkText(chunk: StreamChunk): boolean {
    if (!chunk.p) return true
    if (chunk.p === 'response/fragments/-1/content') return true
    return false
  }

  private sendContent(
    content: string,
    path: string,
    transStream: PassThrough,
    isSilentModel: boolean,
    isFoldModel: boolean,
    isSearchSilentModel: boolean
  ): void {
    const processedContent = this.normalizeContent(content, isSearchSilentModel)
    if (path === 'thinking') {
      this.streamThinkingContentLength += processedContent.length
    } else {
      this.streamVisibleContentLength += processedContent.length
    }

    // For 'content' path, check for tool calls using processStreamContent
    if (path === 'content' || path === '') {
      const baseChunk = createBaseChunk(`${this.sessionId}@${this.messageId}`, this.model, this.created)
      const { chunks, shouldFlush } = processStreamContent(
        processedContent,
        this.toolCallState,
        baseChunk,
        this.isFirstChunk,
        'deepseek'
      )
      
      // Send any chunks generated by tool call processing
      for (const chunk of chunks) {
        transStream.write(`data: ${JSON.stringify(chunk)}\n\n`)
        this.isFirstChunk = false
      }
      
      // If we're buffering a tool call or already emitted tool calls, don't send as regular content
      if (this.toolCallState.isBufferingToolCall || this.toolCallState.hasEmittedToolCall) {
        return
      }
      
      // If chunks were sent (regular content), we're done
      if (chunks.length > 0) {
        return
      }
    }

    const delta: { role?: string; content?: string; reasoning_content?: string } = {}
    let shouldSendDelta = true

    if (this.isFirstChunk) {
      delta.role = 'assistant'
    }

    if (path === 'thinking') {
      if (isSilentModel) return

      if (isFoldModel) {
        if (!this.thinkingStarted) {
          this.thinkingStarted = true
          delta.content = `<details><summary>Thinking Process</summary><pre>${processedContent}`
        } else {
          delta.content = processedContent
        }
      } else {
        if (processedContent) {
          delta.reasoning_content = processedContent
        } else {
          shouldSendDelta = false
        }
      }
    } else if (path === 'content') {
      if (isFoldModel && this.thinkingStarted) {
        delta.content = `</pre></details>${processedContent}`
        this.thinkingStarted = false
      } else {
        delta.content = processedContent
      }
    } else {
      delta.content = processedContent
    }

    if (shouldSendDelta && (delta.content !== undefined || delta.reasoning_content !== undefined)) {
      transStream.write(this.createChunk(delta))
      this.isFirstChunk = false
    }
  }

  private handleDone(transStream: PassThrough, isFoldModel: boolean, isSearchSilentModel: boolean): void {
    if (this.doneHandled) {
      return
    }
    this.doneHandled = true
    if (this.deepSeekUpstreamDebugEnabled) {
      console.log('[DeepSeek][UpstreamSSE]', JSON.stringify({
        status: 'stream_close',
        accumulated_visible_content_length: this.streamVisibleContentLength,
        accumulated_thinking_content_length: this.streamThinkingContentLength,
      }))
    }

    // Flush tool call buffer before finishing
    const baseChunk = createBaseChunk(`${this.sessionId}@${this.messageId}`, this.model, this.created)
    const flushChunks = flushToolCallBuffer(this.toolCallState, baseChunk, 'deepseek')
    for (const outChunk of flushChunks) {
      transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
    }

    if (isFoldModel && this.thinkingStarted) {
      transStream.write(this.createChunk({ content: '</pre></details>' }))
    }

    if (this.searchResults.length > 0 && !isSearchSilentModel) {
      const citations = this.searchResults
        .filter(r => r.cite_index)
        .sort((a, b) => a.cite_index - b.cite_index)
        .map(r => `[${r.cite_index}]: [${r.title}](${r.url})`)
        .join('\n')
      
      if (citations) {
        transStream.write(this.createChunk({ content: `\n\n${citations}` }))
      }
    }

    // Determine finish_reason based on whether we had tool calls
    const finishReason = this.toolCallState.hasEmittedToolCall ? 'tool_calls' : 'stop'

    transStream.write(this.createChunk({}, finishReason))
    transStream.write('data: [DONE]\n\n')
    transStream.end()
    
    // Call end callback
    this.onEnd?.()
  }

  async handleNonStream(stream: NodeJS.ReadableStream): Promise<any> {
    let accumulatedContent = ''
    let accumulatedThinkingContent = ''
    let messageId = ''
    let currentPath: FragmentKind = ''
    let accumulatedTokenUsage = 2
    const isThinkingModel = this.model.includes('think') || this.model.includes('r1') || !!this.reasoningEffort
    const isFoldModel = (this.model.includes('fold') || this.model.includes('search') || this.webSearchEnabled) && !isThinkingModel
    const isSearchSilentModel = this.model.includes('search-silent')
    const debugEnabled = this.deepSeekUpstreamDebugEnabled
    let dataLineIndex = 0

    return new Promise((resolve, reject) => {
      let buffer = ''

      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim() || !line.startsWith('data:')) continue

          const data = line.slice(5).trim()
          if (data === '[DONE]') {
            if (debugEnabled) {
              console.log('[DeepSeek][UpstreamSSE][NonStream]', JSON.stringify({
                line_index: dataLineIndex + 1,
                status: 'done_marker_received',
                accumulated_visible_content_length: accumulatedContent.length,
                accumulated_thinking_content_length: accumulatedThinkingContent.length,
              }))
            }
            return
          }

          try {
            const parsed = JSON.parse(data)
            dataLineIndex += 1
            if (debugEnabled) {
              const payload: Record<string, any> = {
                line_index: dataLineIndex,
                parse_ok: true,
                top_level_keys: Object.keys(parsed as Record<string, any>),
                accumulated_visible_content_length: accumulatedContent.length,
                accumulated_thinking_content_length: accumulatedThinkingContent.length,
              }
              if (typeof parsed.p === 'string') payload.p = parsed.p
              if (typeof parsed.o === 'string') payload.o = parsed.o
              if (parsed.v !== undefined) {
                payload.v_type = Array.isArray(parsed.v) ? 'array' : typeof parsed.v
              }
              if (parsed.v && typeof parsed.v === 'object' && !Array.isArray(parsed.v)) {
                payload.v_keys = Object.keys(parsed.v as Record<string, any>)
                if (parsed.v.response && typeof parsed.v.response === 'object') {
                  payload.response_keys = Object.keys(parsed.v.response as Record<string, any>)
                  if (Array.isArray(parsed.v.response.fragments)) {
                    payload.response_fragments = {
                      count: parsed.v.response.fragments.length,
                      types: parsed.v.response.fragments.map((fragment: any) => fragment?.type || 'unknown'),
                      content_lengths: parsed.v.response.fragments.map((fragment: any) =>
                        typeof fragment?.content === 'string' ? fragment.content.length : 0
                      ),
                    }
                  }
                }
              }
              if (parsed.p === 'response/fragments' && parsed.o === 'APPEND' && Array.isArray(parsed.v)) {
                payload.appended_fragments = parsed.v.map((fragment: any) => ({
                  type: fragment?.type || 'unknown',
                  content_length: typeof fragment?.content === 'string' ? fragment.content.length : 0,
                }))
              }
              if (parsed.p === 'response/fragments/-1/content' && typeof parsed.v === 'string') {
                payload.content_append_length = parsed.v.length
              }
              if (!parsed.p && typeof parsed.v === 'string') {
                payload.bare_v_length = parsed.v.length
              }
              console.log('[DeepSeek][UpstreamSSE][NonStream]', JSON.stringify(payload))
            }
            let handledFragments = false
            
            if (parsed.response_message_id && !messageId) {
              messageId = parsed.response_message_id
              this.messageId = parsed.response_message_id
            }

            if (parsed.v && typeof parsed.v === 'object' && parsed.v.response) {
              const fragments = parsed.v.response.fragments
              if (Array.isArray(fragments) && fragments.length > 0) {
                handledFragments = true
                for (const fragment of fragments) {
                  const kind = this.getFragmentKind(fragment?.type)
                  if (kind) {
                    currentPath = kind
                  }
                  if (fragment?.content && kind) {
                    const cleanedFragment = this.normalizeContent(fragment.content, isSearchSilentModel)
                    if (kind === 'thinking') {
                      accumulatedThinkingContent += cleanedFragment
                    } else {
                      accumulatedContent += cleanedFragment
                    }
                  }
                }
              }
            } else if (parsed.p === 'response/fragments' && parsed.o === 'APPEND') {
              if (Array.isArray(parsed.v)) {
                handledFragments = true
                for (const fragment of parsed.v) {
                  const kind = this.getFragmentKind(fragment?.type)
                  if (kind) {
                    currentPath = kind
                  }
                  if (fragment?.content && kind) {
                    const cleanedFragment = this.normalizeContent(fragment.content, isSearchSilentModel)
                    if (kind === 'thinking') {
                      accumulatedThinkingContent += cleanedFragment
                    } else {
                      accumulatedContent += cleanedFragment
                    }
                  }
                }
              }
            }

            // For thinking models, default to 'thinking' path if not set
            if (!currentPath && isThinkingModel) {
              currentPath = 'thinking'
            }
            
            // For fold models (web search only), default to 'content' path if not set
            if (!currentPath && isFoldModel) {
              currentPath = 'content'
            }

            if (typeof parsed.v === 'object' && Array.isArray(parsed.v)) {
              parsed.v.forEach((e: any) => {
                if (e.p === 'accumulated_token_usage' && typeof e.v === 'number') {
                  accumulatedTokenUsage = e.v
                }
              })
            }

            const extractedText = handledFragments || !this.shouldExtractChunkText(parsed) ? '' : this.normalizeContent(this.extractTextFromValue(parsed.v), isSearchSilentModel)
            if (extractedText) {
              if (currentPath === 'thinking') {
                accumulatedThinkingContent += extractedText
              } else {
                accumulatedContent += extractedText
              }
            }
          } catch {
            if (debugEnabled) {
              dataLineIndex += 1
              console.log('[DeepSeek][UpstreamSSE][NonStream]', JSON.stringify({
                line_index: dataLineIndex,
                parse_ok: false,
                raw_kind: data.startsWith('{') ? 'json_unparsed' : 'non_json',
                accumulated_visible_content_length: accumulatedContent.length,
                accumulated_thinking_content_length: accumulatedThinkingContent.length,
              }))
            }
          }
        }
      })

      stream.on('end', () => {
        if (debugEnabled) {
          console.log('[DeepSeek][UpstreamSSE][NonStream]', JSON.stringify({
            status: 'stream_end',
            accumulated_visible_content_length: accumulatedContent.length,
            accumulated_thinking_content_length: accumulatedThinkingContent.length,
          }))
        }
        // Parse tool calls from accumulated content
        const { content: cleanContent, toolCalls } = parseToolCallsFromText(accumulatedContent)

        const message: any = {
          role: 'assistant',
          reasoning_content: accumulatedThinkingContent.trim() || undefined,
          content: toolCalls.length > 0 ? null : cleanContent.trim(),
        }

        if (toolCalls.length > 0) {
          message.tool_calls = toolCalls
        }

        // Log for debugging
        if (isThinkingModel || accumulatedThinkingContent) {
          console.log('[DeepSeek] Non-stream thinking model:', this.model)
          console.log('[DeepSeek] Accumulated thinking content length:', accumulatedThinkingContent.length)
          console.log('[DeepSeek] Accumulated content length:', accumulatedContent.length)
        }

        resolve({
          id: `${this.sessionId}@${messageId}`,
          model: this.model,
          object: 'chat.completion',
          choices: [{
            index: 0,
            message,
            finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: accumulatedTokenUsage },
          created: this.created,
        })
      })

      stream.on('error', reject)
    })
  }
}
