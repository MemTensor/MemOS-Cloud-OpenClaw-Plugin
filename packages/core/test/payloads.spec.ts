import { describe, expect, it } from 'vitest'
import { buildMemosAddRequest, buildMemosSearchRequest } from '../src/payloads.ts'

describe('OpenClaw-compatible MemOS payload contract', () => {
  it('constructs and detaches the shared search wire format', () => {
    const filter = { app_id: 'coding' }
    const knowledgebaseIds = ['kb-1']
    const request = buildMemosSearchRequest({
      userId: 'user-1',
      query: 'question',
      conversationId: 'conversation-1',
      source: 'host_win32',
      memoryLimitNumber: 9,
      includePreference: true,
      preferenceLimitNumber: 6,
      includeToolMemory: false,
      toolMemoryLimitNumber: 6,
      relativity: 0.45,
      filter,
      knowledgebaseIds,
    })

    filter.app_id = 'mutated'
    knowledgebaseIds.push('mutated')
    expect(request).toEqual({
      user_id: 'user-1',
      query: 'question',
      conversation_id: 'conversation-1',
      source: 'host_win32',
      memory_limit_number: 9,
      include_preference: true,
      preference_limit_number: 6,
      include_tool_memory: false,
      tool_memory_limit_number: 6,
      relativity: 0.45,
      filter: { app_id: 'coding' },
      knowledgebase_ids: ['kb-1'],
    })
  })

  it('omits session and optional scope fields for global recall', () => {
    const request = buildMemosSearchRequest({
      userId: 'user-1',
      query: 'question',
      source: 'host',
      memoryLimitNumber: 6,
      includePreference: false,
      preferenceLimitNumber: 6,
      includeToolMemory: true,
      toolMemoryLimitNumber: 3,
      relativity: 0,
    })
    expect(request).not.toHaveProperty('conversation_id')
    expect(request).not.toHaveProperty('filter')
    expect(request).not.toHaveProperty('knowledgebase_ids')
  })

  it('constructs and detaches the shared add wire format', () => {
    const messages = [
      { id: 'm1', role: 'user' as const, content: 'hello', chat_time: 'now' },
      {
        id: 'm2',
        role: 'assistant' as const,
        tool_calls: [{
          id: 'call-1',
          type: 'function' as const,
          function: { name: 'status', arguments: '{}' },
        }],
        chat_time: 'later',
      },
      {
        id: 'm3',
        role: 'tool' as const,
        tool_call_id: 'call-1',
        content: [{ type: 'text' as const, text: 'ok' }],
        chat_time: 'latest',
      },
    ]
    const request = buildMemosAddRequest({
      userId: 'user-1',
      conversationId: 'conversation-1',
      messages,
      source: 'host',
      asyncMode: false,
      allowPublic: true,
      tags: ['project'],
      info: { team: 'memory' },
      agentId: 'agent-1',
      appId: 'app-1',
      allowKnowledgebaseIds: ['kb-write'],
    })
    messages[0]!.content = 'mutated'
    messages[1]!.tool_calls[0]!.function.arguments = '{"mutated":true}'
    expect(request).toEqual({
      user_id: 'user-1',
      conversation_id: 'conversation-1',
      messages: [
        { id: 'm1', role: 'user', content: 'hello', chat_time: 'now' },
        {
          id: 'm2',
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'status', arguments: '{}' },
          }],
          chat_time: 'later',
        },
        {
          id: 'm3',
          role: 'tool',
          tool_call_id: 'call-1',
          content: [{ type: 'text', text: 'ok' }],
          chat_time: 'latest',
        },
      ],
      source: 'host',
      async_mode: false,
      allow_public: true,
      tags: ['project'],
      info: { team: 'memory' },
      agent_id: 'agent-1',
      app_id: 'app-1',
      allow_knowledgebase_ids: ['kb-write'],
    })
  })
})
