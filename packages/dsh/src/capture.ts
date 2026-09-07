import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { isAppendSurfaceEvent, type SessionEvent } from '@deepseek-ai/dsh-session'
import { truncateUnicode } from '@memtensor/memos-cloud-plugin-core'
import type {
  MemosMessage,
  MemosTextContentBlock,
  MemosToolCall,
} from '@memtensor/memos-cloud-plugin-core'

export interface CaptureTurnOptions {
  includeAssistant: boolean
  includeToolMemory: boolean
  maxMessageChars: number
}

const NON_TEXT_TOOL_RESULT = '[non-text tool result omitted]'

const textContent = (content: readonly ContentBlock[], maxChars: number): string | undefined => {
  const text = content
    .filter((block) => block.type === 'text')
    .map((block) => block.text.trim())
    .filter((value) => value.length > 0)
    .join('\n')
  if (text.length === 0) return undefined
  return truncateUnicode(text, maxChars)
}

const toolCalls = (
  content: readonly ContentBlock[],
  maxChars: number,
  resultCallIds: ReadonlySet<string>,
  emittedCallIds: Set<string>,
): MemosToolCall[] => content
  .filter((block) => block.type === 'tool-call')
  .flatMap((block) => {
    if (emittedCallIds.has(block.id) || !resultCallIds.has(block.id)) return []
    // function.arguments is raw JSON. Truncating it would produce invalid JSON,
    // so omit the whole correlated pair when the argument budget is exceeded.
    if (truncateUnicode(block.arguments, maxChars) !== block.arguments) return []
    emittedCallIds.add(block.id)
    return [{
      id: block.id,
      type: 'function' as const,
      function: {
        name: block.name,
        arguments: block.arguments,
      },
    }]
  })

const toolResultContent = (
  content: readonly ContentBlock[],
  maxChars: number,
): MemosTextContentBlock[] | undefined => {
  const text = textContent(content, maxChars)
    ?? truncateUnicode(NON_TEXT_TOOL_RESULT, maxChars)
  return text.length === 0 ? undefined : [{ type: 'text', text }]
}

const startIndexFor = (
  events: readonly SessionEvent[],
  endIndex: number,
  turn: number,
): number => {
  for (let index = endIndex - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start' && event.data.turn === turn) return index
  }
  return -1
}

export const captureTurn = (
  events: readonly SessionEvent[],
  turnEndSeq: number,
  options: CaptureTurnOptions,
): MemosMessage[] | undefined => {
  const endIndex = events.findIndex((event) => event.seq === turnEndSeq)
  const end = events[endIndex]
  if (end?.type !== 'turn/end' || end.data.reason.kind !== 'completed') return undefined
  const turn = end.data.turn
  const startIndex = startIndexFor(events, endIndex, turn)
  if (startIndex < 0) return undefined

  const turnEvents = events.slice(startIndex + 1, endIndex)
  const resultCallIds = new Set<string>()
  if (options.includeToolMemory) {
    for (const event of turnEvents) {
      if (event.type !== 'tool/result' || event.data.turn !== turn || !isAppendSurfaceEvent(event)) continue
      const block = event.data.message.content.find((value) => value.type === 'tool-result')
      if (block !== undefined) resultCallIds.add(block.toolCallId)
    }
  }

  const messages: MemosMessage[] = []
  const emittedCallIds = new Set<string>()
  const emittedResultIds = new Set<string>()
  let hasDirectUser = false
  for (const event of turnEvents) {
    if (
      (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result')
      && !isAppendSurfaceEvent(event)
    ) continue
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      const content = textContent(event.data.content, options.maxMessageChars)
      if (content === undefined) continue
      hasDirectUser = true
      messages.push({
        id: event.data.id,
        role: 'user',
        content,
        chat_time: new Date(event.time).toISOString(),
      })
      continue
    }
    if (event.type === 'assistant/message' && event.data.turn === turn) {
      const content = options.includeAssistant
        ? textContent(event.data.message.content, options.maxMessageChars)
        : undefined
      const calls = options.includeToolMemory
        ? toolCalls(
            event.data.message.content,
            options.maxMessageChars,
            resultCallIds,
            emittedCallIds,
          )
        : []
      if (content === undefined && calls.length === 0) continue
      messages.push({
        id: event.data.message.id,
        role: 'assistant',
        ...(content === undefined ? {} : { content }),
        ...(calls.length === 0 ? {} : { tool_calls: calls }),
        chat_time: new Date(event.time).toISOString(),
      })
      continue
    }
    if (event.type !== 'tool/result' || event.data.turn !== turn || !options.includeToolMemory) continue
    const block = event.data.message.content.find((value) => value.type === 'tool-result')
    if (
      block === undefined
      || !emittedCallIds.has(block.toolCallId)
      || emittedResultIds.has(block.toolCallId)
    ) continue
    const content = toolResultContent(block.content, options.maxMessageChars)
    if (content === undefined) continue
    emittedResultIds.add(block.toolCallId)
    messages.push({
      id: event.data.message.id,
      role: 'tool',
      tool_call_id: block.toolCallId,
      content,
      chat_time: new Date(event.time).toISOString(),
    })
  }
  return hasDirectUser ? messages : undefined
}
