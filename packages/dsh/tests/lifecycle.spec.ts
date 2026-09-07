import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
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

const setup = (config: Config = {}, client?: Partial<MemosClientLike>): Harness => {
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
    clientFactory: (_resolved, signal) => {
      clientSignals.push(signal)
      return fakeClient
    },
    platform: 'win32',
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

describe('pre-step lifecycle', () => {
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
    expect(result.messages[0]?.source).toEqual({ kind: 'plugin', plugin: 'memos-cloud', form: 'recall' })
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

  it('disposal stops new work, aborts active clients and drains them', async () => {
    const add = vi.fn((_request: MemosAddRequest, signal?: AbortSignal) => new Promise<unknown>((resolve) => {
      signal?.addEventListener('abort', () => resolve({ aborted: true }), { once: true })
    }))
    const harness = setup({}, { add })
    const session = createSession('dispose')
    const first = appendTurn(session, 1, 'first')
    harness.ctx.emit('session/event', session, first)
    await vi.waitFor(() => expect(add).toHaveBeenCalledOnce())

    await harness.controller.dispose()
    expect(harness.clientSignals.every((signal) => signal.aborted)).toBe(true)
    const second = appendTurn(session, 2, 'second')
    harness.ctx.emit('session/event', session, second)
    await Promise.resolve()
    expect(add).toHaveBeenCalledOnce()
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
