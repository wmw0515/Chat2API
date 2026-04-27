import { Transform } from 'stream'
import { SSEParser, SSEFormatter } from '../stream'

function shouldIncludeReasoningContent(): boolean {
  return process.env.CHAT2API_INCLUDE_REASONING_CONTENT === '1'
}

export function sanitizeOpenAICompatibleResponseBody<T = any>(body: T): T {
  if (shouldIncludeReasoningContent()) {
    return body
  }

  if (!body || typeof body !== 'object') {
    return body
  }

  const response = body as any
  if (!Array.isArray(response.choices)) {
    return body
  }

  let changed = false
  const nextChoices = response.choices.map((choice: any) => {
    if (!choice?.message || typeof choice.message !== 'object' || choice.message.reasoning_content === undefined) {
      return choice
    }

    changed = true
    const { reasoning_content, ...messageWithoutReasoning } = choice.message
    return {
      ...choice,
      message: messageWithoutReasoning,
    }
  })

  if (!changed) {
    return body
  }

  return {
    ...response,
    choices: nextChoices,
  }
}

function sanitizeChunkObject(chunk: any): { chunk: any | null; changed: boolean } {
  if (!chunk || typeof chunk !== 'object' || !Array.isArray(chunk.choices)) {
    return { chunk, changed: false }
  }

  let changed = false
  let hadReasoningOnlyDelta = false

  const nextChoices = chunk.choices.map((choice: any) => {
    const delta = choice?.delta
    if (!delta || typeof delta !== 'object' || delta.reasoning_content === undefined) {
      return choice
    }

    changed = true

    const {
      reasoning_content,
      content,
      tool_calls,
      function_call,
      role,
      ...deltaRest
    } = delta

    const hasUsefulDelta =
      content !== undefined ||
      role !== undefined ||
      !!tool_calls ||
      !!function_call ||
      Object.keys(deltaRest).length > 0

    const hasFinishReason = choice.finish_reason !== null && choice.finish_reason !== undefined

    if (!hasUsefulDelta && !hasFinishReason) {
      hadReasoningOnlyDelta = true
      return {
        ...choice,
        delta: {},
      }
    }

    return {
      ...choice,
      delta: {
        ...deltaRest,
        ...(role !== undefined ? { role } : {}),
        ...(content !== undefined ? { content } : {}),
        ...(tool_calls ? { tool_calls } : {}),
        ...(function_call ? { function_call } : {}),
      },
    }
  })

  if (!changed) {
    return { chunk, changed: false }
  }

  if (hadReasoningOnlyDelta) {
    const hasAnyMeaningfulChoice = nextChoices.some((choice: any) => {
      const delta = choice?.delta || {}
      const hasDeltaFields = Object.keys(delta).length > 0
      const hasFinishReason = choice?.finish_reason !== null && choice?.finish_reason !== undefined
      return hasDeltaFields || hasFinishReason
    })

    if (!hasAnyMeaningfulChoice) {
      return { chunk: null, changed: true }
    }
  }

  return {
    chunk: {
      ...chunk,
      choices: nextChoices,
    },
    changed: true,
  }
}

export function createReasoningContentFilterStream(): Transform {
  const parser = new SSEParser()
  const formatter = new SSEFormatter()

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        const events = parser.parse(chunk.toString())

        for (const event of events) {
          if (event.data === '[DONE]') {
            this.push(formatter.formatDone())
            continue
          }

          try {
            const parsed = JSON.parse(event.data)
            const { chunk: sanitizedChunk } = sanitizeChunkObject(parsed)

            if (sanitizedChunk === null) {
              continue
            }

            this.push(formatter.format({
              event: event.event,
              id: event.id,
              retry: event.retry,
              data: JSON.stringify(sanitizedChunk),
            }))
          } catch {
            // Not JSON data, keep original event untouched
            this.push(formatter.format(event))
          }
        }

        callback()
      } catch {
        // Fallback: pass raw chunk if parsing failed
        this.push(chunk)
        callback()
      }
    },
  })
}

export const reasoningContentFilterEnabled = !shouldIncludeReasoningContent()
