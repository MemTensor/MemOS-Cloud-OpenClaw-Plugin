import { describe, expect, it, vi } from 'vitest'
import { MemosClient, MemosClientError } from '@memtensor/memos-cloud-plugin-core'
import type { MemosAddRequest, MemosSearchRequest } from '@memtensor/memos-cloud-plugin-core'

const searchRequest: MemosSearchRequest = {
  user_id: 'user-1',
  query: 'question',
  conversation_id: 'dsh:session-1',
  source: 'deepseek_harness_win',
  memory_limit_number: 6,
  include_preference: true,
  preference_limit_number: 6,
  include_tool_memory: false,
  tool_memory_limit_number: 6,
  relativity: 0.45,
}

const addRequest: MemosAddRequest = {
  user_id: 'user-1',
  conversation_id: 'dsh:session-1',
  messages: [{
    id: 'message-1',
    role: 'user',
    content: 'question',
    chat_time: '2026-08-14T12:00:00.000Z',
  }],
  source: 'deepseek_harness_win',
  async_mode: true,
  allow_public: false,
}

const jsonResponse = (body: unknown, status = 200): Response => new Response(
  JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json' } },
)

const successSearch = () => jsonResponse({
  code: 0,
  data: {
    memory_detail_list: [{ id: 'm1', memory_value: 'remembered' }],
    preference_detail_list: [],
  },
  message: 'ok',
})

const successAdd = () => jsonResponse({
  code: 0,
  data: { success: true, task_id: 'task-1', status: 'running' },
  message: 'ok',
})

type FetchMock = ReturnType<typeof vi.fn<typeof globalThis.fetch>>

const mockFetch = (implementation: typeof globalThis.fetch): FetchMock => vi.fn(implementation)

const createClient = (
  fetch: typeof globalThis.fetch,
  overrides: Partial<ConstructorParameters<typeof MemosClient>[0]> = {},
) => new MemosClient({
  baseURL: 'https://memos.example/api/openmem/v1/',
  timeoutMs: 1000,
  searchRetries: 1,
  retryDelayMs: 0,
  resolveApiKey: vi.fn(async () => 'secret-key'),
  fetch,
  ...overrides,
})

describe('MemosClient request contract', () => {
  it('sends the exact URL, Token header and redirect policy', async () => {
    const fetch = mockFetch(async () => successSearch())
    const client = createClient(fetch)

    await client.search(searchRequest)

    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://memos.example/api/openmem/v1/search/memory')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(new Headers(init?.headers).get('Authorization')).toBe('Token secret-key')
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(init?.body))).toEqual(searchRequest)
  })

  it('accepts the live code 0 envelope and defensive numeric/string variants', async () => {
    for (const code of [0, '0', 200, '200']) {
      const fetch = mockFetch(async () => jsonResponse({ code, data: { memory_detail_list: [] } }))
      await expect(createClient(fetch).search(searchRequest)).resolves.toEqual({
        memory_detail_list: [],
      })
    }
  })

  it('resolves credentials for every operation so rotation is immediate', async () => {
    const resolveApiKey = vi.fn()
      .mockResolvedValueOnce('key-one')
      .mockResolvedValueOnce('key-two')
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () => successSearch())
      .mockImplementationOnce(async () => successAdd())
    const client = createClient(fetch, { resolveApiKey })

    await client.search(searchRequest)
    await client.add(addRequest)

    expect(resolveApiKey).toHaveBeenCalledTimes(2)
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Token key-one')
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe('Token key-two')
  })

  it('does not expose credentials in errors', async () => {
    const fetch = mockFetch(async () => jsonResponse({ message: 'secret-key rejected' }, 401))
    const client = createClient(fetch)

    const error = await client.search(searchRequest).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(MemosClientError)
    expect(String(error)).not.toContain('secret-key')
    expect(JSON.stringify(error)).not.toContain('secret-key')
  })

  it('rejects missing credentials without sending a request', async () => {
    const fetch = mockFetch(async () => successSearch())
    const client = createClient(fetch, { resolveApiKey: async () => ' ' })

    await expect(client.search(searchRequest)).rejects.toMatchObject({ kind: 'credential' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    [jsonResponse({ message: 'bad request' }, 400), 'http'],
    [jsonResponse({ code: 40001, data: {}, message: 'invalid filter' }), 'business'],
    [new Response('not-json', { status: 200 }), 'response'],
    [jsonResponse({ code: 0, data: [] }), 'response'],
    [jsonResponse({ code: 0, data: { memory_detail_list: 'bad' } }), 'response'],
  ] as const)('returns typed errors for malformed responses', async (response, kind) => {
    const client = createClient(mockFetch(async () => response), { searchRetries: 0 })
    await expect(client.search(searchRequest)).rejects.toMatchObject({ kind })
  })
})

describe('MemosClient retry policy', () => {
  it.each([408, 429, 500, 503])('retries transient search HTTP %s', async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () => jsonResponse({ message: 'temporary' }, status))
      .mockImplementationOnce(async () => successSearch())
    const client = createClient(fetch)

    await expect(client.search(searchRequest)).resolves.toMatchObject({ memory_detail_list: expect.any(Array) })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('retries search network errors', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError('secret-key must never leak'))
      .mockImplementationOnce(async () => successSearch())
    const client = createClient(fetch)

    await client.search(searchRequest)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not retry ordinary search 4xx errors', async () => {
    const fetch = mockFetch(async () => jsonResponse({ message: 'bad request' }, 400))
    const client = createClient(fetch, { searchRetries: 3 })

    await expect(client.search(searchRequest)).rejects.toMatchObject({ kind: 'http', status: 400 })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('never retries add requests', async () => {
    const fetch = mockFetch(async () => jsonResponse({ message: 'temporary' }, 503))
    const client = createClient(fetch, { searchRetries: 3 })

    await expect(client.add(addRequest)).rejects.toMatchObject({ kind: 'http', status: 503 })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('aborts an in-progress retry delay', async () => {
    const controller = new AbortController()
    const fetch = mockFetch(async () => jsonResponse({ message: 'temporary' }, 503))
    const client = createClient(fetch, { retryDelayMs: 1000, searchRetries: 3 })
    const operation = client.search(searchRequest, controller.signal)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    controller.abort()

    await expect(operation).rejects.toMatchObject({ kind: 'aborted' })
    expect(fetch).toHaveBeenCalledOnce()
  })
})

describe('MemosClient cancellation', () => {
  const abortingFetch = mockFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
  }))

  it('classifies its own timeout', async () => {
    const client = createClient(abortingFetch, { timeoutMs: 5, searchRetries: 0 })
    await expect(client.search(searchRequest)).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('keeps its timeout active while reading the response body', async () => {
    const fetch = mockFetch((_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new Error('body aborted'))
          }, { once: true })
        },
      })
      return Promise.resolve(new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    })
    const client = createClient(fetch, { timeoutMs: 5, searchRetries: 0 })

    await expect(client.search(searchRequest)).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('preserves caller abort classification', async () => {
    const controller = new AbortController()
    const client = createClient(abortingFetch, { searchRetries: 0 })
    const operation = client.search(searchRequest, controller.signal)
    controller.abort()

    await expect(operation).rejects.toMatchObject({ kind: 'aborted' })
  })

  it('keeps caller abort classification when rejection settles after the timeout', async () => {
    const controller = new AbortController()
    let markFetchStarted: (() => void) | undefined
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve
    })
    const delayedAbortFetch = mockFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      markFetchStarted?.()
      init?.signal?.addEventListener('abort', () => {
        setTimeout(() => reject(new Error('delayed abort settlement')), 20)
      }, { once: true })
    }))
    const client = createClient(delayedAbortFetch, { timeoutMs: 5, searchRetries: 0 })
    const operation = client.search(searchRequest, controller.signal)
    const assertion = expect(operation).rejects.toMatchObject({ kind: 'aborted' })
    await fetchStarted
    controller.abort()

    await assertion
  })

  it('keeps timeout classification when the caller aborts later', async () => {
    const controller = new AbortController()
    let markFetchStarted: (() => void) | undefined
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve
    })
    const delayedTimeoutFetch = mockFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      markFetchStarted?.()
      init?.signal?.addEventListener('abort', () => {
        setTimeout(() => reject(new Error('delayed timeout settlement')), 20)
      }, { once: true })
    }))
    const client = createClient(delayedTimeoutFetch, { timeoutMs: 5, searchRetries: 0 })
    const operation = client.search(searchRequest, controller.signal)
    const assertion = expect(operation).rejects.toMatchObject({ kind: 'timeout' })
    await fetchStarted
    setTimeout(() => controller.abort(), 10)

    await assertion
  })

  it('preserves lifecycle abort classification', async () => {
    const lifecycle = new AbortController()
    const client = createClient(abortingFetch, { lifecycleSignal: lifecycle.signal, searchRetries: 0 })
    const operation = client.search(searchRequest)
    lifecycle.abort()

    await expect(operation).rejects.toMatchObject({ kind: 'aborted' })
  })
})
