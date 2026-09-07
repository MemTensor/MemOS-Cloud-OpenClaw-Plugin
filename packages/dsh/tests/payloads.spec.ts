import { describe, expect, it } from 'vitest'
import { normalizeConfig } from '../src/config.ts'
import {
  buildAddPayload,
  buildSearchPayload,
  conversationIdFor,
  memosSource,
} from '../src/payloads.ts'
import type { MemosMessage } from '@memtensor/memos-cloud-plugin-core'

const messages: MemosMessage[] = [
  { id: 'user-1', role: 'user', content: 'question', chat_time: '2026-08-14T12:00:00.000Z' },
  { id: 'assistant-1', role: 'assistant', content: 'answer', chat_time: '2026-08-14T12:00:01.000Z' },
]

describe('search payloads', () => {
  it('maps the normalized V1 search contract exactly', () => {
    const payload = buildSearchPayload({
      config: normalizeConfig({
        userId: 'shared-user',
        filter: { app_id: 'coding' },
        knowledgebaseIds: ['kb_1'],
      }),
      sessionId: 'session-1',
      query: 'current question',
      platform: 'win32',
    })

    expect(payload).toEqual({
      user_id: 'shared-user',
      query: 'current question',
      conversation_id: 'dsh:session-1',
      source: 'deepseek_harness_win',
      memory_limit_number: 6,
      include_preference: true,
      preference_limit_number: 6,
      include_tool_memory: false,
      tool_memory_limit_number: 6,
      relativity: 0.45,
      filter: { user: { app_id: 'coding' } },
      knowledgebase_ids: ['kb_1'],
    })

    expect(payload).not.toHaveProperty('include_memory_view')
    expect(payload).not.toHaveProperty('context_format')
  })

  it('omits optional filter and knowledgebase fields when absent', () => {
    const payload = buildSearchPayload({
      config: normalizeConfig({}),
      sessionId: 'session-1',
      query: 'question',
    })

    expect(payload).not.toHaveProperty('filter')
    expect(payload).not.toHaveProperty('knowledgebase_ids')
  })

  it('adds configured agentId only to the user filter branch', () => {
    const payload = buildSearchPayload({
      config: normalizeConfig({
        agentId: 'coding-main',
        knowledgebaseIds: ['kb_1'],
        filter: { knowledgebase: { doc_type: 'api' } },
      }),
      sessionId: 'session-1',
      query: 'question',
    })

    expect(payload.filter).toEqual({
      user: { agent_id: 'coding-main' },
      knowledgebase: { doc_type: 'api' },
    })
  })

  it('uses the real DSH agent preset for dynamic multi-agent search isolation', () => {
    const payload = buildSearchPayload({
      config: normalizeConfig({ multiAgentMode: true, agentId: 'headless-fallback' }),
      sessionId: 'session-1',
      agentPreset: 'code',
      query: 'question',
    })

    expect(payload.filter).toEqual({ user: { agent_id: 'code' } })
  })

  it('falls back to the explicit agentId when no stable DSH preset exists', () => {
    const payload = buildSearchPayload({
      config: normalizeConfig({ multiAgentMode: true, agentId: 'headless-fallback' }),
      sessionId: 'session-1',
      query: 'question',
    })

    expect(payload.filter).toEqual({ user: { agent_id: 'headless-fallback' } })
  })

  it('maps OpenClaw-compatible recall controls and global search', () => {
    const payload = buildSearchPayload({
      config: normalizeConfig({
        queryPrefix: 'project context: ',
        recallGlobal: true,
        memoryLimitNumber: 9,
        includePreference: false,
        preferenceLimitNumber: 7,
        includeToolMemory: true,
        toolMemoryLimitNumber: 5,
      }),
      sessionId: 'session-1',
      query: 'current question',
    })

    expect(payload).toMatchObject({
      query: 'project context: current question',
      memory_limit_number: 9,
      include_preference: false,
      preference_limit_number: 7,
      include_tool_memory: true,
      tool_memory_limit_number: 5,
    })
    expect(payload).not.toHaveProperty('conversation_id')
  })
})

describe('add payloads', () => {
  it('maps safe metadata and configured write fields', () => {
    const payload = buildAddPayload({
      config: normalizeConfig({
        userId: 'shared-user',
        tags: ['project-a'],
        info: {
          team: 'memory',
          integration: 'forged',
          dsh_origin: 'forged',
          dsh_tags: 'forged',
        },
        agentId: 'coding-main',
        appId: 'desktop',
        allowKnowledgebaseIds: ['kb_write'],
      }),
      sessionId: 'session-1',
      messages,
      platform: 'linux',
      agentPreset: 'coding',
      origin: 'top-level',
    })

    expect(payload).toEqual({
      user_id: 'shared-user',
      conversation_id: 'dsh:session-1',
      messages,
      source: 'deepseek_harness_linux',
      async_mode: true,
      allow_public: false,
      tags: ['project-a'],
      info: {
        team: 'memory',
        integration: 'deepseek-harness',
        dsh_origin: 'top-level',
        dsh_agent_preset: 'coding',
        dsh_tags: 'project-a',
      },
      agent_id: 'coding-main',
      app_id: 'desktop',
      allow_knowledgebase_ids: ['kb_write'],
    })
  })

  it('maps configurable add behavior without changing safe defaults', () => {
    const payload = buildAddPayload({
      config: normalizeConfig({ asyncMode: false, allowPublic: true }),
      sessionId: 'session-1',
      messages: [messages[0]!],
      origin: 'top-level',
    })

    expect(payload.async_mode).toBe(false)
    expect(payload.allow_public).toBe(true)
  })

  it('uses the real DSH agent preset for dynamic multi-agent add isolation', () => {
    const payload = buildAddPayload({
      config: normalizeConfig({ multiAgentMode: true, agentId: 'headless-fallback' }),
      sessionId: 'session-1',
      messages: [messages[0]!],
      agentPreset: 'standard',
      origin: 'top-level',
    })

    expect(payload.agent_id).toBe('standard')
    expect(payload.info?.dsh_agent_preset).toBe('standard')
  })

  it('omits optional write fields when absent', () => {
    const payload = buildAddPayload({
      config: normalizeConfig({ tags: [] }),
      sessionId: 'session-1',
      messages: [messages[0]!],
      origin: 'subagent',
    })

    expect(payload).not.toHaveProperty('tags')
    expect(payload).not.toHaveProperty('agent_id')
    expect(payload).not.toHaveProperty('app_id')
    expect(payload).not.toHaveProperty('allow_knowledgebase_ids')
    expect(payload.info).toEqual({
      integration: 'deepseek-harness',
      dsh_origin: 'subagent',
    })
  })

  it('detaches messages and configured metadata from caller mutation', () => {
    const config = normalizeConfig({ tags: ['a'], info: { team: 'memory' } })
    const payload = buildAddPayload({ config, sessionId: 's', messages, origin: 'top-level' })

    messages[0]!.content = 'mutated'
    config.tags.push('mutated')
    config.info.team = 'mutated'

    expect(payload.messages[0]?.content).toBe('question')
    expect(payload.tags).toEqual(['a'])
    expect(payload.info?.team).toBe('memory')
    expect(payload.info?.dsh_tags).toBe('a')
  })
})

describe('request attribution', () => {
  it('uses readable short conversation IDs', () => {
    expect(conversationIdFor('session-1')).toBe('dsh:session-1')
  })

  it('hashes long session IDs deterministically under the server limit', () => {
    const first = conversationIdFor('x'.repeat(200))
    const second = conversationIdFor('x'.repeat(200))

    expect(first).toBe(second)
    expect(first).toMatch(/^dsh:[a-f0-9]{64}$/)
    expect(first.length).toBeLessThanOrEqual(100)
  })

  it('rejects blank session IDs', () => {
    expect(() => conversationIdFor(' ')).toThrow('sessionId')
  })

  it.each([
    ['win32', 'deepseek_harness_win'],
    ['darwin', 'deepseek_harness_mac'],
    ['linux', 'deepseek_harness_linux'],
    ['aix', 'deepseek_harness'],
  ] as const)('maps the Node platform %s to source %s', (platform, source) => {
    expect(memosSource(platform)).toBe(source)
  })
})
