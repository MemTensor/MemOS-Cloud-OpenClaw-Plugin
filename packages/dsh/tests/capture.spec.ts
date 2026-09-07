import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { captureTurn } from '../src/capture.ts'

const priorUser = createUserMessage({
  source: { kind: 'user' },
  content: [{ type: 'text', text: 'earlier turn' }],
})
const directUser = createUserMessage({
  source: { kind: 'user' },
  content: [
    { type: 'text', text: 'current question' },
    { type: 'reasoning', text: 'hidden user reasoning' },
  ],
})
const recall = createUserMessage({
  source: { kind: 'plugin', plugin: 'memos-cloud', form: 'recall' },
  content: [{ type: 'text', text: 'recalled context' }],
})
const firstAssistant = createAssistantMessage({
  source: { provider: 'fixture', model: 'model' },
  content: [
    { type: 'reasoning', text: 'hidden assistant reasoning' },
    { type: 'text', text: 'first answer' },
    { type: 'tool-call', id: 'call-1' as never, name: 'read', arguments: '{}' },
  ],
})
const secondAssistant = createAssistantMessage({
  source: { provider: 'fixture', model: 'model' },
  content: [{ type: 'text', text: 'second answer' }],
})
const emptyAssistant = createAssistantMessage({
  source: { provider: 'fixture', model: 'model' },
  content: [{ type: 'reasoning', text: 'reasoning only' }],
})
const toolResult = createToolResultMessage({
  callId: 'call-1' as never,
  content: [{ type: 'text', text: 'tool output' }],
  isError: false,
})

const events: SessionEvent[] = [
  { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: 1100, data: priorUser, surfaceOp: 'append' },
  { type: 'turn/end', seq: 2, time: 1200, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 3, time: 2000, data: { turn: 2 } },
  { type: 'user/message', seq: 4, time: 2100, data: recall, surfaceOp: 'append' },
  { type: 'user/message', seq: 5, time: 2200, data: directUser, surfaceOp: 'append' },
  { type: 'assistant/message', seq: 6, time: 2300, data: { turn: 2, step: 1, message: firstAssistant }, surfaceOp: 'append' },
  { type: 'tool/result', seq: 7, time: 2400, data: { turn: 2, step: 1, message: toolResult }, surfaceOp: 'append' },
  { type: 'assistant/message', seq: 8, time: 2500, data: { turn: 2, step: 2, message: secondAssistant }, surfaceOp: 'append' },
  { type: 'assistant/message', seq: 9, time: 2600, data: { turn: 2, step: 3, message: emptyAssistant }, surfaceOp: 'append' },
  { type: 'turn/end', seq: 10, time: 2700, data: { turn: 2, reason: { kind: 'completed' } } },
]

describe('captureTurn', () => {
  it('captures only the matching completed turn in durable event order', () => {
    expect(captureTurn(events, 10, {
      includeAssistant: true,
      includeToolMemory: false,
      maxMessageChars: 1000,
    })).toEqual([
      {
        id: directUser.id,
        role: 'user',
        content: 'current question',
        chat_time: new Date(2200).toISOString(),
      },
      {
        id: firstAssistant.id,
        role: 'assistant',
        content: 'first answer',
        chat_time: new Date(2300).toISOString(),
      },
      {
        id: secondAssistant.id,
        role: 'assistant',
        content: 'second answer',
        chat_time: new Date(2500).toISOString(),
      },
    ])
  })

  it('can omit assistant messages without removing the required user', () => {
    expect(captureTurn(events, 10, {
      includeAssistant: false,
      includeToolMemory: false,
      maxMessageChars: 1000,
    })).toEqual([
      expect.objectContaining({ id: directUser.id, role: 'user' }),
    ])
  })

  it('captures correlated tool calls and results only when tool memory is enabled', () => {
    expect(captureTurn(events, 10, {
      includeAssistant: true,
      includeToolMemory: true,
      maxMessageChars: 1000,
    })).toEqual([
      {
        id: directUser.id,
        role: 'user',
        content: 'current question',
        chat_time: new Date(2200).toISOString(),
      },
      {
        id: firstAssistant.id,
        role: 'assistant',
        content: 'first answer',
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'read', arguments: '{}' },
        }],
        chat_time: new Date(2300).toISOString(),
      },
      {
        id: toolResult.id,
        role: 'tool',
        tool_call_id: 'call-1',
        content: [{ type: 'text', text: 'tool output' }],
        chat_time: new Date(2400).toISOString(),
      },
      {
        id: secondAssistant.id,
        role: 'assistant',
        content: 'second answer',
        chat_time: new Date(2500).toISOString(),
      },
    ])
  })

  it('keeps tool memory while assistant text is disabled', () => {
    expect(captureTurn(events, 10, {
      includeAssistant: false,
      includeToolMemory: true,
      maxMessageChars: 1000,
    })).toEqual([
      expect.objectContaining({ id: directUser.id, role: 'user' }),
      {
        id: firstAssistant.id,
        role: 'assistant',
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'read', arguments: '{}' },
        }],
        chat_time: new Date(2300).toISOString(),
      },
      expect.objectContaining({
        id: toolResult.id,
        role: 'tool',
        tool_call_id: 'call-1',
      }),
    ])
  })

  it('rejects failed/non-completed turns', () => {
    const failed: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 1100, data: directUser, surfaceOp: 'append' },
      { type: 'turn/end', seq: 2, time: 1200, data: { turn: 1, reason: { kind: 'blocked' } } },
    ]

    expect(captureTurn(failed, 2, {
      includeAssistant: true,
      includeToolMemory: false,
      maxMessageChars: 1000,
    })).toBeUndefined()
  })

  it('requires a matching start boundary and at least one direct user message', () => {
    expect(captureTurn(events.slice(4), 10, {
      includeAssistant: true,
      includeToolMemory: false,
      maxMessageChars: 1000,
    })).toBeUndefined()

    const pluginOnly: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 1100, data: recall, surfaceOp: 'append' },
      { type: 'turn/end', seq: 2, time: 1200, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    expect(captureTurn(pluginOnly, 2, {
      includeAssistant: true,
      includeToolMemory: false,
      maxMessageChars: 1000,
    })).toBeUndefined()
  })

  it('truncates each captured message deterministically by Unicode characters', () => {
    const unicodeUser = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'ab😀cd' }],
    })
    const unicodeToolCall = createAssistantMessage({
      source: { provider: 'fixture', model: 'model' },
      content: [{ type: 'tool-call', id: 'call-unicode' as never, name: 'read', arguments: '{"value":"ab😀cd"}' }],
    })
    const unicodeToolResult = createToolResultMessage({
      callId: 'call-unicode' as never,
      content: [{ type: 'text', text: 'result' }],
      isError: false,
    })
    const unicodeEvents: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 1100, data: unicodeUser, surfaceOp: 'append' },
      { type: 'assistant/message', seq: 2, time: 1150, data: { turn: 1, step: 1, message: unicodeToolCall }, surfaceOp: 'append' },
      { type: 'tool/result', seq: 3, time: 1175, data: { turn: 1, step: 1, message: unicodeToolResult }, surfaceOp: 'append' },
      { type: 'turn/end', seq: 4, time: 1200, data: { turn: 1, reason: { kind: 'completed' } } },
    ]

    const captured = captureTurn(unicodeEvents, 4, {
      includeAssistant: true,
      includeToolMemory: true,
      maxMessageChars: 3,
    })
    expect(captured?.[0]?.content).toBe('ab😀')
    expect(captured).toHaveLength(1)
  })

  it('ignores model-only replacement surface events', () => {
    const replacement = createAssistantMessage({
      source: { provider: 'fixture', model: 'model' },
      content: [{ type: 'text', text: 'replacement summary' }],
    })
    const replacementEvents: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 1100, data: directUser, surfaceOp: 'append' },
      { type: 'assistant/message', seq: 2, time: 1150, data: { turn: 1, step: 1, message: secondAssistant }, surfaceOp: 'append' },
      {
        type: 'assistant/message',
        seq: 3,
        time: 1175,
        data: { turn: 1, step: 2, message: replacement },
        sourceEventSeqs: [2],
        surfaceOp: { op: 'replace', start: 2, end: 2 },
      },
      { type: 'turn/end', seq: 4, time: 1200, data: { turn: 1, reason: { kind: 'completed' } } },
    ]

    expect(captureTurn(replacementEvents, 4, {
      includeAssistant: true,
      includeToolMemory: false,
      maxMessageChars: 1000,
    })).toEqual([
      expect.objectContaining({ id: directUser.id, role: 'user' }),
      expect.objectContaining({ id: secondAssistant.id, content: 'second answer' }),
    ])
  })

  it('keeps tool messages paired while omitting attachment bytes and duplicate results', () => {
    const imageCall = createAssistantMessage({
      source: { provider: 'fixture', model: 'model' },
      content: [{ type: 'tool-call', id: 'call-image' as never, name: 'inspect_image', arguments: '{}' }],
    })
    const imageResult = createToolResultMessage({
      callId: 'call-image' as never,
      content: [{
        type: 'image',
        attachment: {
          attachmentId: 'attachment-1',
          mediaType: 'image/png',
          bytes: 4,
          width: 1,
          height: 1,
        } as never,
      }],
      isError: false,
    })
    const duplicateResult = createToolResultMessage({
      callId: 'call-image' as never,
      content: [{ type: 'text', text: 'duplicate output' }],
      isError: false,
    })
    const unmatchedResult = createToolResultMessage({
      callId: 'call-unmatched' as never,
      content: [{ type: 'text', text: 'unmatched output' }],
      isError: false,
    })
    const pairedEvents: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 1100, data: directUser, surfaceOp: 'append' },
      { type: 'assistant/message', seq: 2, time: 1150, data: { turn: 1, step: 1, message: imageCall }, surfaceOp: 'append' },
      { type: 'tool/result', seq: 3, time: 1170, data: { turn: 1, step: 1, message: imageResult }, surfaceOp: 'append' },
      { type: 'tool/result', seq: 4, time: 1180, data: { turn: 1, step: 1, message: duplicateResult }, surfaceOp: 'append' },
      { type: 'tool/result', seq: 5, time: 1190, data: { turn: 1, step: 1, message: unmatchedResult }, surfaceOp: 'append' },
      { type: 'turn/end', seq: 6, time: 1200, data: { turn: 1, reason: { kind: 'completed' } } },
    ]

    const captured = captureTurn(pairedEvents, 6, {
      includeAssistant: false,
      includeToolMemory: true,
      maxMessageChars: 1000,
    })
    expect(captured).toHaveLength(3)
    expect(captured?.[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call-image' }],
    })
    expect(captured?.[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-image',
      content: [{ type: 'text', text: '[non-text tool result omitted]' }],
    })
  })
})
