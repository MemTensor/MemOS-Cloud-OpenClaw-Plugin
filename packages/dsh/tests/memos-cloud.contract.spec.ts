import { describe, expect, it } from 'vitest'
import { normalizeConfig } from '../src/config.ts'
import { MemosClient, MemosClientError } from '@memtensor/memos-cloud-plugin-core'
import { buildSearchPayload } from '../src/payloads.ts'
import type { Config } from '../src/config.ts'
import type { MemosSearchData } from '@memtensor/memos-cloud-plugin-core'

const apiKey = process.env.MEMOS_API_KEY?.trim()
const userId = process.env.MEMOS_CONTRACT_USER_ID?.trim()
const knowledgebaseId = process.env.MEMOS_CONTRACT_KB_ID?.trim()
const baseURL = process.env.MEMOS_CONTRACT_BASE_URL?.trim()
  || 'https://memos.memtensor.cn/api/openmem/v1'
const liveEnabled = Boolean(apiKey && userId)
const runMarker = `dsh-contract-${Date.now()}`

const search = async (overrides: Config = {}): Promise<MemosSearchData> => {
  if (!apiKey || !userId) throw new Error('live contract prerequisites are missing')
  const config = normalizeConfig({ userId, ...overrides })
  const client = new MemosClient({
    baseURL,
    timeoutMs: 15_000,
    searchRetries: 1,
    resolveApiKey: async () => apiKey,
  })
  const request = buildSearchPayload({
    config,
    sessionId: runMarker,
    query: 'DeepSeek Harness MemOS contract search probe',
  })
  return client.search(request)
}

const expectSearchEnvelope = (data: MemosSearchData): void => {
  expect(data).toEqual(expect.any(Object))
  if (data.memory_detail_list !== undefined) {
    expect(data.memory_detail_list).toEqual(expect.any(Array))
  }
  if (data.preference_detail_list !== undefined) {
    expect(data.preference_detail_list).toEqual(expect.any(Array))
  }
}

describe.skipIf(!liveEnabled)('MemOS Cloud live search contract', () => {
  it('accepts a search without filter', async () => {
    expectSearchEnvelope(await search())
  })

  it('accepts an explicit user-source filter', async () => {
    expectSearchEnvelope(await search({
      filter: { user: { dsh_contract_scope: 'search-only' } },
    }))
  })

  it('accepts an ordinary logical filter after user wrapping', async () => {
    expectSearchEnvelope(await search({
      filter: {
        and: [
          { tags: { contains: 'deepseek-harness' } },
          { dsh_contract_scope: 'search-only' },
        ],
      },
    }))
  })

  it.skipIf(!knowledgebaseId)('accepts a knowledgebase-source filter when a test KB is supplied', async () => {
    expectSearchEnvelope(await search({
      knowledgebaseIds: [knowledgebaseId!],
      filter: { knowledgebase: { dsh_contract_scope: 'search-only' } },
    }))
  })
})

describe('MemOS contract safety gates', () => {
  it('rejects a knowledgebase filter locally when no KB ID is configured', () => {
    expect(() => normalizeConfig({
      userId: userId || 'contract-user',
      filter: { knowledgebase: { dsh_contract_scope: 'search-only' } },
    })).toThrow('knowledgebaseIds')
  })

  it('redacts a credential echoed by a business error', async () => {
    const secret = 'contract-secret-that-must-not-leak'
    const client = new MemosClient({
      baseURL: 'https://memos.invalid/api/openmem/v1',
      timeoutMs: 1_000,
      searchRetries: 0,
      resolveApiKey: async () => secret,
      fetch: async () => new Response(JSON.stringify({
        code: 40001,
        data: {},
        message: `${secret} rejected`,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    })
    const config = normalizeConfig({ userId: userId || 'contract-user' })
    const error = await client.search(buildSearchPayload({
      config,
      sessionId: runMarker,
      query: 'redaction probe',
    })).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(MemosClientError)
    expect(error).toMatchObject({ kind: 'business' })
    expect(String(error)).not.toContain(secret)
    expect(JSON.stringify(error)).not.toContain(secret)
  })
})
