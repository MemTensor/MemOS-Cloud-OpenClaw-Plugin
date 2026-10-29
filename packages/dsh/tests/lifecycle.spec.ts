import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import * as settingsModule from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installMemosLifecycle,
  type MemosClientLike,
  type MemosLifecycleController,
} from '../src/index.ts'
import type { Config } from '../src/config.ts'
import type { MemosAddRequest, MemosSearchData, MemosSearchRequest } from '@memtensor/memos-cloud-plugin-core'

const controllers: MemosLifecycleController[] = []

afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.dispose()))
  vi.unstubAllGlobals()
})

const userMessage = (text: string): UserMessage => createUserMessage({
  source: { kind: 'user' },
  content: [{ type: 'text', text }],
})

const createSession = (idText: string, options: { subagent?: boolean; agentPreset?: string } = {}): Session => {
  const id = SessionId(idText)
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1000,
    isSeeded: false,
    ...(options.subagent ? { origin: 'subagent' as const, delegationDepth: 1 } : {}),
    ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
  }
  return Session.create(id, undefined, header)
}

const createAgent = (session: Session): Agent => ({
  id: session.id,
  session,
  options: {},
} as unknown as Agent)

/** Legacy projection read face retained for older DSH SDK compatibility. */
const presetProjection = (value: unknown): { stateOf: (session: Session, key: string) => unknown } => ({
  stateOf: (_session: Session, key: string) => (key === 'agentPreset' ? value : undefined),
})

interface Harness {
  ctx: Context
  client: MemosClientLike
  search: ReturnType<typeof vi.fn<(request: MemosSearchRequest, signal?: AbortSignal) => Promise<MemosSearchData>>>
  add: ReturnType<typeof vi.fn<(request: MemosAddRequest, signal?: AbortSignal) => Promise<unknown>>>
  warn: ReturnType<typeof vi.fn>
  controller: MemosLifecycleController
  clientSignals: AbortSignal[]
}

type PreStepNextMock = ReturnType<typeof vi.fn<() => Promise<PreStepDecision>>>

const setup = (config: Config = {}, client?: Partial<MemosClientLike>, shutdownTimeoutMs: number | null = 100, useDefaultClient = false): Harness => {
  const ctx = new Context()
  const search = vi.fn(async (): Promise<MemosSearchData> => ({
    memory_detail_list: [{ memory_value: 'recalled fact' }],
  }))
  const add = vi.fn(async () => ({ success: true }))
  const fakeClient: MemosClientLike = {
    search,
    add,
    ...client,
  }
  const warn = vi.fn()
  const clientSignals: AbortSignal[] = []
  const controller = installMemosLifecycle(ctx, config, {
    logger: { warn },
    ...(useDefaultClient ? {} : { clientFactory: (_resolved: unknown, signal: AbortSignal) => {
      clientSignals.push(signal)
      return fakeClient
    } }),
    platform: 'win32',
    ...(shutdownTimeoutMs === null ? {} : { shutdownTimeoutMs }),
  })
  controllers.push(controller)
  return { ctx, client: fakeClient, search, add, warn, controller, clientSignals }
}

const dispatchPreStep = async (
  harness: Harness,
  session: Session,
  messages: UserMessage[],
  options: { step?: number; signal?: AbortSignal; decision?: PreStepDecision; next?: PreStepNextMock } = {},
): Promise<{ result: PreStepDecision; next: PreStepNextMock }> => {
  const decision: PreStepDecision = options.decision ?? { kind: 'enter', messages }
  const next = options.next ?? vi.fn(async (): Promise<PreStepDecision> => decision)
  const result = await harness.ctx.waterfall('agent/pre-step', {
    agent: createAgent(session),
    messages,
    turn: 1,
    step: options.step ?? 1,
    signal: options.signal ?? new AbortController().signal,
  }, next)
  return { result, next }
}

const appendTurn = (
  session: Session,
  turn: number,
  userText: string,
  assistantText = 'answer',
  completed = true,
): SessionEvent<'turn/end'> => {
  session.append('turn/start', { turn })
  session.append('user/message', userMessage(userText), { surfaceOp: 'append' })
  const assistant = createAssistantMessage({
    source: { provider: 'fixture', model: 'model' },
    content: [{ type: 'text', text: assistantText }],
  })
  session.append('assistant/message', { turn, step: 1, message: assistant }, { surfaceOp: 'append' })
  return session.append('turn/end', {
    turn,
    reason: completed ? { kind: 'completed' } : { kind: 'blocked' },
  })
}

describe('operation timeout isolation with the production HTTP client', () => {
  it('bounds recall including retries to five seconds while allowing a synchronous write to finish later', async () => {
    vi.useFakeTimers()
    const requests: Array<{ url: string; signal: AbortSignal }> = []
    let searches = 0
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
      const signal = init!.signal!
      requests.push({ url: String(url), signal })
      if (String(url).endsWith('/search/memory')) {
        if (++searches === 1) return new Response('{}', { status: 503 })
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
        })
      }
      return new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(JSON.stringify({ code: 0, data: { success: true } }))), 30000))
    }))
    const harness = setup({ apiKey: 'test-only', asyncMode: false, syncAddTimeoutMs: 180000 }, undefined, null, true)
    try {
      const session = createSession('isolated-deadlines')
      const messages = [userMessage('question')]
      const model = new AbortController()
      let entered = false
      const step = dispatchPreStep(harness, session, messages, { signal: model.signal }).then(value => { entered = true; return value })
      await vi.advanceTimersByTimeAsync(100)
      expect(searches).toBe(2)
      await vi.advanceTimersByTimeAsync(4899)
      expect(entered).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect((await step).result).toEqual({ kind: 'enter', messages })
      expect(model.signal.aborted).toBe(false)
      expect(requests[1]!.signal.aborted).toBe(true)
      expect(harness.warn).toHaveBeenCalledWith('MemOS search skipped: MemOS recall timed out')

      harness.ctx.emit('session/event', session, appendTurn(session, 1, 'remember'))
      let flushed = false
      const flush = harness.ctx.parallel('session/flush', session).then(() => { flushed = true })
      await vi.advanceTimersByTimeAsync(6000)
      expect(flushed).toBe(false)
      expect(requests[2]!.signal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(24000)
      await flush
      expect(flushed).toBe(true)
      expect(requests[2]!.signal.aborted).toBe(false)
      expect(harness.warn).toHaveBeenCalledTimes(1)
    } finally {
      await vi.runAllTimersAsync()
      vi.useRealTimers()
    }
  })

  it('uses five seconds for async writes after a live mode switch without shortening an existing sync write', async () => {
    vi.useFakeTimers()
    const requests: Array<{ asyncMode: boolean; signal: AbortSignal; finish: () => void }> = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((resolve, reject) => {
      const signal = init!.signal!
      requests.push({ asyncMode: JSON.parse(String(init!.body)).async_mode, signal,
        finish: () => resolve(new Response(JSON.stringify({ code: 0, data: { success: true } }))),
      })
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })))
    const config: Config = { apiKey: 'test-only', timeoutMs: 180000, syncAddTimeoutMs: 90000, asyncMode: false }
    const harness = setup(config, undefined, null, true)
    try {
      const first = createSession('long-existing-sync')
      const second = createSession('new-short-async')
      harness.ctx.emit('session/event', first, appendTurn(first, 1, 'sync'))
      await vi.advanceTimersByTimeAsync(0)
      config.asyncMode = true
      harness.ctx.emit('session/event', second, appendTurn(second, 1, 'async'))
      let flushed = false
      const flush = harness.ctx.parallel('session/flush', second).then(() => { flushed = true })
      await vi.advanceTimersByTimeAsync(4999)
      expect(requests.map(row => row.asyncMode)).toEqual([false, true])
      expect(flushed).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await flush
      expect(requests.map(row => row.signal.aborted)).toEqual([false, true])
      expect(harness.warn).toHaveBeenCalledWith('MemOS add skipped: MemOS request timed out')
      requests[0]!.finish()
      await harness.controller.drain()
    } finally {
      for (const request of requests) request.finish()
      await vi.runAllTimersAsync()
      vi.useRealTimers()
    }
  })

  it('continues the model turn when credential lookup stalls beyond the recall budget', async () => {
    vi.useFakeTimers()
    const transport = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', transport)
    const harness = setup({ timeoutMs: 180000 }, undefined, null, true)
    let finish: ((value: undefined) => void) | undefined
    harness.ctx.provide('credentials', { resolve: () => new Promise<undefined>(resolve => { finish = resolve }) })
    try {
      const messages = [userMessage('question')]
      const step = dispatchPreStep(harness, createSession('stalled-credentials'), messages)
      await vi.advanceTimersByTimeAsync(5000)
      expect((await step).result).toEqual({ kind: 'enter', messages })
      expect(transport).not.toHaveBeenCalled()
      finish?.(undefined)
      await vi.advanceTimersByTimeAsync(0)
      expect(transport).not.toHaveBeenCalled()
    } finally {
      finish?.(undefined)
      await vi.runAllTimersAsync()
      vi.useRealTimers()
    }
  })
})

describe('pre-step lifecycle', () => {
  it('preserves the host request-series boundary when adding recall', async () => {
    const harness = setup()
    const messages = [userMessage('new request series')]
    const { result } = await dispatchPreStep(harness, createSession('request-series'), messages, {
      decision: { kind: 'enter', messages, startsRequestSeries: true },
    })
    expect(result).toMatchObject({ kind: 'enter', startsRequestSeries: true })
    if (result.kind !== 'enter') throw new Error('expected enter')
    expect(result.messages).toHaveLength(2)
  })

  it('calls next once, searches on step 1 and inserts recall before direct user', async () => {
    const harness = setup()
    const session = createSession('session-1')
    const direct = userMessage('current question')

    const { result, next } = await dispatchPreStep(harness, session, [direct])

    expect(next).toHaveBeenCalledOnce()
    expect(harness.search).toHaveBeenCalledOnce()
    expect(result.kind).toBe('enter')
    if (result.kind !== 'enter') throw new Error('expected enter')
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]?.source).toEqual({ kind: 'plugin:memos-cloud', form: 'recall' })
    expect(result.messages[1]).toBe(direct)
  })

  it('passes the filter, knowledgebase and stable conversation mapping to the client', async () => {
    const harness = setup({
      userId: 'shared-user',
      agentId: 'coding-main',
      knowledgebaseIds: ['kb_1'],
      filter: { knowledgebase: { doc_type: 'api' } },
    })
    await dispatchPreStep(harness, createSession('session-1'), [userMessage('question')])

    expect(harness.search).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'shared-user',
      conversation_id: 'dsh:session-1',
      query: 'question',
      knowledgebase_ids: ['kb_1'],
      filter: {
        user: { agent_id: 'coding-main' },
        knowledgebase: { doc_type: 'api' },
      },
    }), expect.any(AbortSignal))
  })

  it('uses the session agent preset for dynamic multi-agent recall isolation', async () => {
    const harness = setup({ multiAgentMode: true, agentId: 'headless-fallback' })
    await dispatchPreStep(
      harness,
      createSession('session-1', { agentPreset: 'code' }),
      [userMessage('question')],
    )

    expect(harness.search).toHaveBeenCalledWith(expect.objectContaining({
      filter: { user: { agent_id: 'code' } },
    }), expect.any(AbortSignal))
  })

  it('prefers the agentPreset projection over the initial header value', async () => {
    const harness = setup({ multiAgentMode: true, agentId: 'headless-fallback' })
    harness.ctx.provide('sessionProjections', presetProjection('ptc'))
    await dispatchPreStep(
      harness,
      createSession('session-1', { agentPreset: 'code' }),
      [userMessage('question')],
    )

    expect(harness.search).toHaveBeenCalledWith(expect.objectContaining({
      filter: { user: { agent_id: 'ptc' } },
    }), expect.any(AbortSignal))
  })

  it('does not revive the header preset when the projection reports none', async () => {
    const harness = setup({ multiAgentMode: true, agentId: 'headless-fallback' })
    harness.ctx.provide('sessionProjections', presetProjection(null))
    await dispatchPreStep(
      harness,
      createSession('session-1', { agentPreset: 'code' }),
      [userMessage('question')],
    )

    expect(harness.search).toHaveBeenCalledWith(expect.objectContaining({
      filter: { user: { agent_id: 'headless-fallback' } },
    }), expect.any(AbortSignal))
  })

  it('returns the original decision for empty recall and search errors', async () => {
    const empty = setup({}, { search: vi.fn(async () => ({ memory_detail_list: [] })) })
    const emptyDecision: PreStepDecision = { kind: 'enter', messages: [userMessage('question')] }
    const emptyResult = await dispatchPreStep(empty, createSession('empty'), emptyDecision.messages, {
      decision: emptyDecision,
    })
    expect(emptyResult.result).toBe(emptyDecision)

    const failed = setup({}, { search: vi.fn(async () => { throw new Error('network') }) })
    const failedDecision: PreStepDecision = { kind: 'enter', messages: [userMessage('question')] }
    const failedResult = await dispatchPreStep(failed, createSession('failed'), failedDecision.messages, {
      decision: failedDecision,
    })
    expect(failedResult.result).toBe(failedDecision)
    expect(failed.warn).toHaveBeenCalledOnce()
  })

  it('does not warn when an in-flight search is cancelled', async () => {
    const controller = new AbortController()
    const harness = setup({}, {
      search: vi.fn((_request: MemosSearchRequest, signal?: AbortSignal) => new Promise<MemosSearchData>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })),
    })
    const operation = dispatchPreStep(harness, createSession('cancelled'), [userMessage('question')], {
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(harness.clientSignals).toHaveLength(1))
    controller.abort()

    await operation
    expect(harness.warn).not.toHaveBeenCalled()
  })

  it('skips ineligible steps, decisions, signals, messages, config and subagents', async () => {
    const harness = setup({ recallEnabled: false })
    await dispatchPreStep(harness, createSession('disabled'), [userMessage('question')])

    const enabled = setup()
    await dispatchPreStep(enabled, createSession('step-2'), [userMessage('question')], { step: 2 })
    await dispatchPreStep(enabled, createSession('reject'), [userMessage('question')], {
      decision: { kind: 'reject' },
    })
    const aborted = new AbortController()
    aborted.abort()
    await dispatchPreStep(enabled, createSession('aborted'), [userMessage('question')], { signal: aborted.signal })
    await dispatchPreStep(enabled, createSession('plugin-only'), [createUserMessage({
      source: { kind: 'plugin', plugin: 'fixture', form: 'recall' },
      content: [{ type: 'text', text: 'context' }],
    })])
    await dispatchPreStep(enabled, createSession('subagent', { subagent: true }), [userMessage('question')])

    expect(harness.search).not.toHaveBeenCalled()
    expect(enabled.search).not.toHaveBeenCalled()
  })
})

// SettingsForms replaced this base class in 0.2.x. Exercise the actual legacy
// provider only on hosts that export it; modern forms have a host smoke test.
const SettingsProvider = Reflect.get(settingsModule, 'SettingsProvider')
class TestSettings extends (SettingsProvider ?? class {}) {
  readonly writable = true

  protected async load(): Promise<Record<string, unknown>> {
    return { 'memos-cloud': { userId: 'settings-user' } }
  }

  protected async persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {}
}

describe.skipIf(SettingsProvider === undefined)('real settings provider lifecycle', () => {
  it('merges settings, applies edits, validates writes and falls back after provider reload', async () => {
    const harness = setup({ userId: 'entry-user', queryPrefix: 'entry-prefix ' })
    const provider = await harness.ctx.plugin(TestSettings)
    try {
      await vi.waitFor(() => expect(harness.ctx.settings.get('memos-cloud')).toMatchObject({
        userId: 'settings-user', queryPrefix: 'entry-prefix ',
      }))
      const recall = async () => dispatchPreStep(harness, createSession('settings'), [userMessage('question')])
      await recall()
      expect(harness.search).toHaveBeenLastCalledWith(expect.objectContaining({ user_id: 'settings-user' }), expect.any(AbortSignal))
      await harness.ctx.settings.update('memos-cloud', { userId: 'updated-user', recallEnabled: false })
      await recall()
      expect(harness.search).toHaveBeenCalledTimes(1)
      await expect(harness.ctx.settings.update('memos-cloud', {
        filter: { knowledgebase: { category: 'test' } },
      })).rejects.toThrow('knowledgebaseIds')
      await harness.ctx.settings.replace('memos-cloud', { userId: 'updated-user' })
      await recall()
      expect(harness.search).toHaveBeenLastCalledWith(expect.objectContaining({ user_id: 'updated-user' }), expect.any(AbortSignal))
      await provider.dispose()
      await recall()
      expect(harness.search).toHaveBeenLastCalledWith(expect.objectContaining({ user_id: 'entry-user' }), expect.any(AbortSignal))
      const reloaded = await harness.ctx.plugin(TestSettings)
      await vi.waitFor(() => expect(harness.ctx.settings.get('memos-cloud')).toMatchObject({ userId: 'settings-user' }))
      await recall()
      expect(harness.search).toHaveBeenLastCalledWith(expect.objectContaining({ user_id: 'settings-user' }), expect.any(AbortSignal))
      await reloaded.dispose()
    } finally {
      await harness.ctx.fiber.dispose()
    }
  })
})

describe('turn-end lifecycle', () => {
  it('queues completed turns without delaying event delivery and adds safe metadata', async () => {
    let finishAdd: (() => void) | undefined
    const add = vi.fn((_request: MemosAddRequest) => new Promise<unknown>((resolve) => {
      finishAdd = () => resolve({ success: true })
    }))
    const harness = setup({ multiAgentMode: true, agentId: 'headless-fallback' }, { add })
    const session = createSession('session-1', { agentPreset: 'coding' })
    const end = appendTurn(session, 1, 'remember this')

    harness.ctx.emit('session/event', session, end)
    expect(add).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(add).toHaveBeenCalledOnce())
    expect(add).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: 'dsh:session-1',
      agent_id: 'coding',
      info: expect.objectContaining({
        integration: 'deepseek-harness',
        dsh_origin: 'top-level',
        dsh_agent_preset: 'coding',
      }),
    }), expect.any(AbortSignal))

    finishAdd?.()
    await harness.controller.drain()
  })

  it('tags the write with the projected preset rather than the initial header value', async () => {
    const add = vi.fn(async () => ({ success: true }))
    const harness = setup({ multiAgentMode: true, agentId: 'headless-fallback' }, { add })
    harness.ctx.provide('sessionProjections', presetProjection('ptc'))
    const session = createSession('session-1', { agentPreset: 'coding' })
    const end = appendTurn(session, 1, 'remember this')

    harness.ctx.emit('session/event', session, end)
    await vi.waitFor(() => expect(add).toHaveBeenCalledOnce())
    expect(add).toHaveBeenCalledWith(expect.objectContaining({
      agent_id: 'ptc',
      info: expect.objectContaining({ dsh_agent_preset: 'ptc' }),
    }), expect.any(AbortSignal))
    await harness.controller.drain()
  })

  it('serializes writes per session and deduplicates the same turn event', async () => {
    const resolvers: Array<() => void> = []
    const add = vi.fn((_request: MemosAddRequest) => new Promise<unknown>((resolve) => {
      resolvers.push(() => resolve({ success: true }))
    }))
    const harness = setup({}, { add })
    const session = createSession('ordered')
    const first = appendTurn(session, 1, 'first')
    const second = appendTurn(session, 2, 'second')

    harness.ctx.emit('session/event', session, first)
    harness.ctx.emit('session/event', session, first)
    harness.ctx.emit('session/event', session, second)
    await vi.waitFor(() => expect(add).toHaveBeenCalledOnce())
    expect(add.mock.calls[0]?.[0].messages[0]?.content).toBe('first')

    resolvers.shift()?.()
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(2))
    expect(add.mock.calls[1]?.[0].messages[0]?.content).toBe('second')
    resolvers.shift()?.()
    await harness.controller.drain()
  })

  it('allows different sessions to write concurrently', async () => {
    const add = vi.fn((_request: MemosAddRequest, signal?: AbortSignal) => new Promise<unknown>((resolve) => {
      signal?.addEventListener('abort', () => resolve({ aborted: true }), { once: true })
    }))
    const harness = setup({}, { add })
    const firstSession = createSession('first')
    const secondSession = createSession('second')

    harness.ctx.emit('session/event', firstSession, appendTurn(firstSession, 1, 'first'))
    harness.ctx.emit('session/event', secondSession, appendTurn(secondSession, 1, 'second'))
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(2))

    expect(add.mock.calls.map((call) => call[0].conversation_id).sort()).toEqual(['dsh:first', 'dsh:second'])
  })

  it('skips non-completed, disabled and default subagent writes', async () => {
    const harness = setup({ addEnabled: false })
    const disabled = createSession('disabled')
    harness.ctx.emit('session/event', disabled, appendTurn(disabled, 1, 'disabled'))

    const enabled = setup()
    const blocked = createSession('blocked')
    enabled.ctx.emit('session/event', blocked, appendTurn(blocked, 1, 'blocked', 'answer', false))
    const subagent = createSession('subagent', { subagent: true })
    enabled.ctx.emit('session/event', subagent, appendTurn(subagent, 1, 'subagent'))
    await Promise.resolve()

    expect(harness.add).not.toHaveBeenCalled()
    expect(enabled.add).not.toHaveBeenCalled()
  })

  it('contains add errors and deduplicates identical warnings', async () => {
    const harness = setup({}, { add: vi.fn(async () => { throw new Error('network') }) })
    for (const id of ['first', 'second']) {
      const session = createSession(id)
      harness.ctx.emit('session/event', session, appendTurn(session, 1, id))
    }
    await harness.controller.drain()

    expect(harness.warn).toHaveBeenCalledOnce()
  })

  it('disposal stops new work and waits for accepted writes without aborting them', async () => {
    let finish: (() => void) | undefined
    const add = vi.fn((_request: MemosAddRequest, signal?: AbortSignal) => new Promise<unknown>((resolve) => {
      finish = () => { expect(signal?.aborted).toBe(false); resolve({ success: true }) }
    }))
    const harness = setup({}, { add })
    const session = createSession('dispose')
    const first = appendTurn(session, 1, 'first')
    harness.ctx.emit('session/event', session, first)
    await vi.waitFor(() => expect(add).toHaveBeenCalledOnce())

    let disposed = false
    const disposal = harness.controller.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    expect(harness.clientSignals[0]?.aborted).toBe(false)
    finish?.()
    await disposal
    expect(harness.clientSignals.every((signal) => signal.aborted)).toBe(true)
    const second = appendTurn(session, 2, 'second')
    harness.ctx.emit('session/event', session, second)
    await Promise.resolve()
    expect(add).toHaveBeenCalledOnce()
  })

  it('bounds shutdown and warns about unconfirmed writes even if a transport ignores abort', async () => {
    let finish: (() => void) | undefined
    const add = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const harness = setup({}, { add }, 10)
    const session = createSession('stuck-write')
    harness.ctx.emit('session/event', session, appendTurn(session, 1, 'remember'))
    await vi.waitFor(() => expect(add).toHaveBeenCalledOnce())
    await harness.controller.dispose()
    expect(harness.clientSignals[0]?.aborted).toBe(true)
    expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining('1 write(s) unconfirmed'))
    finish?.()
    await harness.controller.drain()
  })

  it('finishes queued turns in session order during graceful shutdown', async () => {
    const complete: Array<() => void> = []
    const add = vi.fn((_request: MemosAddRequest, signal?: AbortSignal) => new Promise<void>((resolve) => {
      expect(signal?.aborted).toBe(false)
      complete.push(resolve)
    }))
    const harness = setup({}, { add }, 1000)
    const session = createSession('queued-shutdown')
    harness.ctx.emit('session/event', session, appendTurn(session, 1, 'first'))
    harness.ctx.emit('session/event', session, appendTurn(session, 2, 'second'))
    await vi.waitFor(() => expect(add).toHaveBeenCalledOnce())
    const disposal = harness.controller.dispose()
    complete[0]?.()
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(2))
    expect(add.mock.calls[1]?.[0].messages[0]?.content).toBe('second')
    complete[1]?.()
    await disposal
    expect(harness.warn).not.toHaveBeenCalled()
  })

  it('holds the awaited session flush for a slow write using the configured request budget', async () => {
    vi.useFakeTimers()
    let finish: (() => void) | undefined
    const add = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const harness = setup({ asyncMode: false, syncAddTimeoutMs: 60000 }, { add }, null)
    try {
      const session = createSession('slow-synchronous-flush')
      harness.ctx.emit('session/event', session, appendTurn(session, 1, 'remember'))
      await vi.advanceTimersByTimeAsync(0)
      expect(add).toHaveBeenCalledOnce()
      let flushed = false
      const flush = harness.ctx.parallel('session/flush', session).then(() => { flushed = true })
      await vi.advanceTimersByTimeAsync(26000)
      expect(flushed).toBe(false)
      expect(harness.clientSignals[0]?.aborted).toBe(false)
      finish?.()
      await flush
      expect(flushed).toBe(true)
      expect(harness.warn).not.toHaveBeenCalled()
    } finally {
      finish?.()
      vi.useRealTimers()
    }
  })

  it('flushes one session without waiting for another agent\'s write', async () => {
    const complete: Array<() => void> = []
    const add = vi.fn(() => new Promise<void>((resolve) => { complete.push(resolve) }))
    const harness = setup({}, { add })
    const first = createSession('flush-first')
    const second = createSession('flush-unrelated')
    try {
      harness.ctx.emit('session/event', first, appendTurn(first, 1, 'first'))
      harness.ctx.emit('session/event', second, appendTurn(second, 1, 'second'))
      await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(2))
      const flush = harness.ctx.parallel('session/flush', first)
      complete[0]?.()
      await flush
      expect(harness.warn).not.toHaveBeenCalled()
      expect(harness.clientSignals[1]?.aborted).toBe(false)
    } finally {
      for (const finish of complete) finish()
      await harness.controller.drain()
    }
  })

  it('bounds a stalled session flush without failing the host checkpoint', async () => {
    let finish: (() => void) | undefined
    const harness = setup({}, { add: vi.fn(() => new Promise<void>((resolve) => { finish = resolve })) }, 10)
    const session = createSession('stalled-flush')
    harness.ctx.emit('session/event', session, appendTurn(session, 1, 'remember'))
    await harness.ctx.parallel('session/flush', session)
    expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining('session flush timed out'))
    finish?.()
    await harness.controller.drain()
  })

  it('disposal aborts and waits for an in-flight recall search', async () => {
    let finishSearch: ((data: MemosSearchData) => void) | undefined
    const search = vi.fn(() => new Promise<MemosSearchData>((resolve) => {
      finishSearch = resolve
    }))
    const harness = setup({}, { search })
    const operation = dispatchPreStep(
      harness,
      createSession('dispose-search'),
      [userMessage('question')],
    )
    await vi.waitFor(() => expect(search).toHaveBeenCalledOnce())

    let disposed = false
    const disposal = harness.controller.dispose().then(() => {
      disposed = true
    })
    await vi.waitFor(() => expect(harness.clientSignals[0]?.aborted).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const disposedBeforeSearchSettled = disposed
    finishSearch?.({ memory_detail_list: [] })
    await disposal
    await operation

    expect(disposedBeforeSearchSettled).toBe(false)
    expect(disposed).toBe(true)
  })
})
