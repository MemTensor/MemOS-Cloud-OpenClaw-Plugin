import { describe, expect, it, vi } from 'vitest'
import {
  Config as ConfigSchema,
  normalizeConfig,
  resolveApiKey,
  type Config as ConfigInput,
  type RuntimeAccessors,
} from '../src/config.ts'

const accessors = (
  credentialValue?: string,
  environment: Record<string, string> = {},
): RuntimeAccessors => ({
  credentials: {
    resolve: vi.fn(async () => credentialValue === undefined
      ? undefined
      : { value: credentialValue, source: 'test' }),
  },
  launchEnvironment: {
    get: (name) => environment[name] === undefined
      ? undefined
      : { value: environment[name], source: 'process' },
  },
})

describe('normalizeConfig', () => {
  it('preserves an omitted filter through the runtime schema', () => {
    const parsed = ConfigSchema({})

    expect(parsed.filter).toBeUndefined()
    expect(normalizeConfig(parsed).filter).toBeUndefined()
    expect(() => normalizeConfig({ filter: {} })).toThrow('filter object cannot be empty')
  })

  it('applies every V1 default', () => {
    expect(normalizeConfig({})).toEqual({
      apiKeyEnv: 'MEMOS_API_KEY',
      baseURL: 'https://memos.memtensor.cn/api/openmem/v1',
      userId: 'deepseek-harness-user',
      recallEnabled: true,
      addEnabled: true,
      includeAssistant: true,
      includeSubagents: false,
      multiAgentMode: false,
      queryPrefix: '',
      recallGlobal: false,
      memoryLimitNumber: 6,
      preferenceLimitNumber: 6,
      includePreference: true,
      includeToolMemory: false,
      toolMemoryLimitNumber: 6,
      relativity: 0.45,
      tags: ['deepseek-harness'],
      info: {},
      knowledgebaseIds: [],
      allowKnowledgebaseIds: [],
      maxQueryChars: 4000,
      maxRecallChars: 12000,
      maxItemChars: 2000,
      maxMessageChars: 12000,
      timeoutMs: 5000,
      searchRetries: 1,
      addRetries: 0,
      allowPublic: false,
      asyncMode: true,
    })
  })

  it('uses the launch environment for userId and strips trailing base URL slashes', () => {
    const environment = accessors(undefined, { MEMOS_USER_ID: 'user-from-env' }).launchEnvironment

    expect(normalizeConfig({ baseURL: 'https://example.test/openmem///' }, environment)).toMatchObject({
      baseURL: 'https://example.test/openmem',
      userId: 'user-from-env',
    })
  })

  it('treats empty optional strings and environment values as absent', () => {
    const environment = accessors(undefined, { MEMOS_USER_ID: '   ' }).launchEnvironment
    const resolved = normalizeConfig({
      apiKey: ' ',
      apiKeyEnv: '',
      baseURL: ' ',
      userId: '',
      agentId: ' ',
      appId: '',
    }, environment)

    expect(resolved).not.toHaveProperty('apiKey')
    expect(resolved).not.toHaveProperty('agentId')
    expect(resolved).not.toHaveProperty('appId')
    expect(resolved.apiKeyEnv).toBe('MEMOS_API_KEY')
    expect(resolved.baseURL).toBe('https://memos.memtensor.cn/api/openmem/v1')
    expect(resolved.userId).toBe('deepseek-harness-user')
  })

  it.each([
    ['memoryLimitNumber', 0],
    ['memoryLimitNumber', 26],
    ['preferenceLimitNumber', 0],
    ['toolMemoryLimitNumber', 26],
    ['relativity', -0.01],
    ['relativity', 1.01],
    ['maxQueryChars', 0],
    ['maxRecallChars', 100_001],
    ['maxItemChars', 0],
    ['maxMessageChars', 1.5],
    ['timeoutMs', 99],
    ['timeoutMs', 60_001],
    ['searchRetries', -1],
    ['searchRetries', 4],
    ['addRetries', -1],
    ['addRetries', 4],
  ] as const)('rejects an invalid %s bound', (key, value) => {
    expect(() => normalizeConfig({ [key]: value })).toThrow(key)
  })

  it.each([
    { ' ': 'value' },
    { key: '' },
    { key: 1 },
    { key: Number.POSITIVE_INFINITY },
    { key: [] },
    { key: ['ok'] },
    { key: ['ok', ' '] },
    { key: true },
    { key: { nested: 'value' } },
  ])('rejects invalid info values: %j', (info) => {
    expect(() => normalizeConfig({ info } as ConfigInput)).toThrow('info')
  })

  it.each([
    { tags: [''] },
    { knowledgebaseIds: ['kb-1', ' '] },
    { allowKnowledgebaseIds: [''] },
  ])('rejects blank list entries: %j', (config) => {
    expect(() => normalizeConfig(config)).toThrow('blank')
  })

  it('returns a detached normalized snapshot', () => {
    const raw: ConfigInput = {
      filter: { and: [{ tags: { contains: 'private' } }] },
      tags: ['alpha'],
      info: { team: 'memory' },
    }
    const resolved = normalizeConfig(raw)

    raw.tags?.push('mutated')
    ;(raw.filter?.and as unknown[]).push({ field: 'app_id', eq: 'bad' })
    raw.info!.team = 'mutated'

    expect(resolved.tags).toEqual(['alpha'])
    expect(resolved.filter).toEqual({ and: [{ tags: { contains: 'private' } }] })
    expect(resolved.info).toEqual({ team: 'memory' })
  })

  it('prefixes invalid filter configuration errors with the plugin name', () => {
    expect(() => normalizeConfig({
      filter: { knowledgebase: { doc_type: 'api' } },
    })).toThrow('memos-cloud: knowledgebaseIds')
  })

  it('rejects an agentId merge that cannot be represented by the filter grammar', () => {
    expect(() => normalizeConfig({
      agentId: 'agent-1',
      filter: { or: [{ tags: 'a' }] },
    })).toThrow('memos-cloud: agentId cannot be combined with an or filter')
  })

  it('rejects a fixed agent filter when multi-agent mode selects the preset dynamically', () => {
    expect(() => normalizeConfig({
      multiAgentMode: true,
      agentId: 'headless-fallback',
      filter: { user: { agent_id: 'headless-fallback' } },
    })).toThrow('memos-cloud: filter.user.agent_id conflicts')
  })
})

describe('resolveApiKey', () => {
  it('uses literal config before credentials and launch environment', async () => {
    const runtime = accessors('credential-key', { MEMOS_API_KEY: 'environment-key' })
    const config = normalizeConfig({ apiKey: 'literal-key' })

    await expect(resolveApiKey(config, runtime)).resolves.toBe('literal-key')
    expect(runtime.credentials?.resolve).not.toHaveBeenCalled()
  })

  it('uses credentials before launch environment', async () => {
    const runtime = accessors('credential-key', { MEMOS_API_KEY: 'environment-key' })

    await expect(resolveApiKey(normalizeConfig({}), runtime)).resolves.toBe('credential-key')
  })

  it('falls back to the launch environment when credentials are absent or blank', async () => {
    await expect(resolveApiKey(
      normalizeConfig({}),
      accessors(' ', { MEMOS_API_KEY: 'environment-key' }),
    )).resolves.toBe('environment-key')
  })

  it('returns undefined when no non-empty key exists', async () => {
    await expect(resolveApiKey(normalizeConfig({}), accessors())).resolves.toBeUndefined()
  })
})
