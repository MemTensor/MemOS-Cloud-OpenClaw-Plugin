import { MemosClientError } from './memos-errors.js'
import { parseAddResponse, parseSearchResponse } from './memos-response.js'
import type { MemosAddData, MemosAddRequest, MemosSearchData, MemosSearchRequest } from './types.js'

export { MemosClientError } from './memos-errors.js'
export type { MemosClientErrorKind } from './memos-errors.js'

export interface MemosClientOptions {
  baseURL: string
  timeoutMs: number
  searchRetries: number
  addRetries?: number
  retryDelayMs?: number
  resolveApiKey: () => Promise<string | undefined>
  fetch?: typeof globalThis.fetch
  lifecycleSignal?: AbortSignal
  redirect?: RequestRedirect
  retryAllFailures?: boolean
}

interface RequestSignal {
  signal: AbortSignal
  abortSource: () => 'external' | 'timeout' | undefined
  cleanup: () => void
}

const abortedError = (): MemosClientError => new MemosClientError(
  'MemOS request was aborted',
  { kind: 'aborted' },
)

const throwIfExternallyAborted = (caller?: AbortSignal, lifecycle?: AbortSignal): void => {
  if (caller?.aborted || lifecycle?.aborted) throw abortedError()
}

const createRequestSignal = (
  timeoutMs: number,
  caller?: AbortSignal,
  lifecycle?: AbortSignal,
): RequestSignal => {
  const controller = new AbortController()
  let source: 'external' | 'timeout' | undefined
  const forwardAbort = (): void => {
    if (source !== undefined) return
    source = 'external'
    controller.abort()
  }
  for (const signal of [caller, lifecycle]) {
    if (signal?.aborted) forwardAbort()
    else signal?.addEventListener('abort', forwardAbort, { once: true })
  }
  const timeout = setTimeout(() => {
    if (source !== undefined) return
    source = 'timeout'
    controller.abort()
  }, timeoutMs)
  return {
    signal: controller.signal,
    abortSource: () => source,
    cleanup: () => {
      clearTimeout(timeout)
      caller?.removeEventListener('abort', forwardAbort)
      lifecycle?.removeEventListener('abort', forwardAbort)
    },
  }
}

const abortableDelay = async (
  milliseconds: number,
  caller?: AbortSignal,
  lifecycle?: AbortSignal,
): Promise<void> => {
  throwIfExternallyAborted(caller, lifecycle)
  if (milliseconds <= 0) return
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timeout)
      caller?.removeEventListener('abort', abort)
      lifecycle?.removeEventListener('abort', abort)
    }
    const abort = (): void => {
      finish()
      reject(abortedError())
    }
    const timeout = setTimeout(() => {
      finish()
      resolve()
    }, milliseconds)
    caller?.addEventListener('abort', abort, { once: true })
    lifecycle?.addEventListener('abort', abort, { once: true })
  })
}

export class MemosClient {
  readonly #baseURL: string
  readonly #timeoutMs: number
  readonly #searchRetries: number
  readonly #addRetries: number
  readonly #retryDelayMs: number
  readonly #resolveApiKey: () => Promise<string | undefined>
  readonly #fetch: typeof globalThis.fetch
  readonly #lifecycleSignal?: AbortSignal
  readonly #redirect: RequestRedirect
  readonly #retryAllFailures: boolean

  constructor(options: MemosClientOptions) {
    this.#baseURL = options.baseURL.replace(/\/+$/, '')
    this.#timeoutMs = options.timeoutMs
    this.#searchRetries = options.searchRetries
    this.#addRetries = options.addRetries ?? 0
    this.#retryDelayMs = options.retryDelayMs ?? 100
    this.#resolveApiKey = options.resolveApiKey
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#redirect = options.redirect ?? 'error'
    this.#retryAllFailures = options.retryAllFailures ?? false
    if (options.lifecycleSignal !== undefined) this.#lifecycleSignal = options.lifecycleSignal
  }

  async search(request: MemosSearchRequest, signal?: AbortSignal): Promise<MemosSearchData> {
    return this.#execute('/search/memory', request, parseSearchResponse, this.#searchRetries, signal)
  }

  async add(request: MemosAddRequest, signal?: AbortSignal): Promise<MemosAddData> {
    return this.#execute('/add/message', request, parseAddResponse, this.#addRetries, signal)
  }

  async requestRaw<T = unknown>(
    path: string,
    body: unknown,
    retries: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const parseRaw = async (response: Response): Promise<T> => {
      if (!response.ok) {
        throw new MemosClientError(`HTTP ${response.status}`, {
          kind: 'http',
          status: response.status,
          retryable: this.#retryAllFailures
            || response.status === 408
            || response.status === 429
            || response.status >= 500,
        })
      }
      try {
        return await response.json() as T
      } catch (cause) {
        throw new MemosClientError('MemOS returned invalid JSON', {
          kind: 'response',
          retryable: this.#retryAllFailures,
          cause,
        })
      }
    }
    return this.#execute(path, body, parseRaw, retries, signal)
  }

  async #execute<T>(
    path: string,
    body: unknown,
    parse: (response: Response, apiKey: string) => Promise<T>,
    retries: number,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    throwIfExternallyAborted(callerSignal, this.#lifecycleSignal)
    let apiKey: string | undefined
    try {
      apiKey = await this.#resolveApiKey()
    } catch (cause) {
      throw new MemosClientError('MemOS credential resolution failed', { kind: 'credential', cause })
    }
    if (apiKey === undefined || apiKey.trim().length === 0) {
      throw new MemosClientError('MemOS API key is not configured', { kind: 'credential' })
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#send(path, body, apiKey, parse, callerSignal)
      } catch (cause) {
        const error = cause instanceof MemosClientError
          ? cause
          : new MemosClientError('MemOS request failed', { kind: 'network', retryable: true, cause })
        const retryable = error.retryable
          || (this.#retryAllFailures && error.kind !== 'credential' && error.kind !== 'aborted')
        if (!retryable || attempt >= retries) throw error
        await abortableDelay(this.#retryDelayMs * (attempt + 1), callerSignal, this.#lifecycleSignal)
      }
    }
  }

  async #send<T>(
    path: string,
    body: unknown,
    apiKey: string,
    parse: (response: Response, key: string) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    throwIfExternallyAborted(callerSignal, this.#lifecycleSignal)
    const requestSignal = createRequestSignal(this.#timeoutMs, callerSignal, this.#lifecycleSignal)
    try {
      const response = await this.#fetch(`${this.#baseURL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Token ${apiKey}` },
        body: JSON.stringify(body),
        redirect: this.#redirect,
        signal: requestSignal.signal,
      })
      return await parse(response, apiKey)
    } catch (cause) {
      if (requestSignal.abortSource() === 'external') throw abortedError()
      if (requestSignal.abortSource() === 'timeout') {
        throw new MemosClientError('MemOS request timed out', { kind: 'timeout', retryable: true, cause })
      }
      if (cause instanceof MemosClientError) throw cause
      throw new MemosClientError('MemOS network request failed', { kind: 'network', retryable: true, cause })
    } finally {
      requestSignal.cleanup()
    }
  }
}
