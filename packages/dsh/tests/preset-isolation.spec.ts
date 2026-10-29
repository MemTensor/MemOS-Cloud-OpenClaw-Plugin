import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { MemosAddRequest, MemosSearchData, MemosSearchRequest } from '@memtensor/memos-cloud-plugin-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inject, installMemosLifecycle, type MemosLifecycleController } from '../src/index.ts'

interface Projection {
  stateOf(session: Session, key: string): unknown
}

interface Presets {
  presetForSession?: (session: Session) => string | null
}

const projectionOf = (value: unknown): Projection => ({
  stateOf: (_session, key) => key === 'agentPreset' ? value : undefined,
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

const mount = async (options: {
  projection?: Projection
  presets?: Presets
  agentId?: string
  multiAgentMode?: boolean
} = {}) => {
  const root = new Context()
  root.provide('agents', {})
  root.provide('sessions', {})
  const projection = options.projection
  const provider = projection === undefined ? undefined : await root.plugin({
    name: 'fixture-preset-projections',
    apply(ctx: Context) { ctx.provide('sessionProjections', projection) },
  })
  const presets = options.presets
  const owner = presets === undefined ? undefined : await root.plugin({
    name: 'fixture-preset-owner',
    apply(ctx: Context) { ctx.provide('agentPresets', presets) },
  })
  const search = vi.fn(async (_request: MemosSearchRequest, _signal?: AbortSignal): Promise<MemosSearchData> => ({
    memory_detail_list: [],
  }))
  const add = vi.fn(async (_request: MemosAddRequest, _signal?: AbortSignal) => ({ success: true }))
  let controller: MemosLifecycleController | undefined
  const consumer = await root.plugin({
    name: 'fixture-memos-preset-consumer',
    // Match the actual plugin mount: both preset services are optional and are
    // not declared in inject. Access must work through ctx.get().
    inject,
    apply(ctx: Context) {
      controller = installMemosLifecycle(ctx, {
        multiAgentMode: options.multiAgentMode ?? true,
        ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
      }, { clientFactory: () => ({ search, add }) })
    },
  })
  cleanups.push(async () => {
    await controller?.dispose()
    await consumer.dispose()
    await owner?.dispose()
    await provider?.dispose()
  })
  if (controller === undefined) throw new Error('MemOS consumer did not activate')
  return { root, controller, search, add, owner }
}

const createSession = (preset?: string): Session => {
  const id = SessionId('preset-isolation')
  return Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1000,
    isSeeded: false,
    ...(preset === undefined ? {} : { agentPreset: preset }),
  })
}

const completeTurn = async (
  harness: Awaited<ReturnType<typeof mount>>,
  session: Session,
  turn = 1,
) => {
  const message = createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text: 'remember this' }],
  })
  await harness.root.waterfall('agent/pre-step', {
    agent: { id: session.id, session, options: {} } as unknown as Agent,
    messages: [message], turn, step: 1, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter' as const, messages: [message] }))
  session.append('turn/start', { turn })
  session.append('user/message', message, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn, step: 1,
    message: createAssistantMessage({
      source: { provider: 'fixture', model: 'model' },
      content: [{ type: 'text', text: 'answer' }],
    }),
  }, { surfaceOp: 'append' })
  const end = session.append('turn/end', { turn, reason: { kind: 'completed' } })
  harness.root.emit('session/event', session, end)
  await harness.controller.drain()
}

describe('preset memory isolation in a mounted plugin', () => {
  it('uses the owning service for live preset switches without reading the deprecated projection', async () => {
    const legacyRead = vi.fn(() => 'stale-projection')
    const presets = {
      current: 'coding',
      presetForSession: vi.fn(function (this: { current: string }, _session: Session) { return this.current }),
    }
    const harness = await mount({ presets, projection: { stateOf: legacyRead } })
    const session = createSession('minimal')
    await completeTurn(harness, session)
    presets.current = 'standard'
    await completeTurn(harness, session, 2)

    expect(harness.search.mock.calls.map(([request]) => request.filter)).toEqual([
      { user: { agent_id: 'coding' } },
      { user: { agent_id: 'standard' } },
    ])
    expect(harness.add.mock.calls.map(([request]) => request.agent_id)).toEqual(['coding', 'standard'])
    expect(harness.add.mock.calls.map(([request]) => request.info?.dsh_agent_preset)).toEqual(['coding', 'standard'])
    expect(presets.presetForSession).toHaveBeenCalledWith(session)
    expect(legacyRead).not.toHaveBeenCalled()
  })

  it('reads the owning service without requiring a projection registry', async () => {
    const harness = await mount({ presets: { presetForSession: () => 'coding' } })
    await completeTurn(harness, createSession('minimal'))
    expect(harness.search.mock.calls[0]?.[0].filter).toEqual({ user: { agent_id: 'coding' } })
    expect(harness.add.mock.calls[0]?.[0]).toMatchObject({ agent_id: 'coding', info: { dsh_agent_preset: 'coding' } })
  })

  it.each(['fallback', undefined])('does not revive a cleared preset with configured fallback %s', async agentId => {
    const legacyRead = vi.fn(() => 'stale-projection')
    const harness = await mount({
      presets: { presetForSession: () => null },
      projection: { stateOf: legacyRead },
      ...(agentId === undefined ? {} : { agentId }),
    })
    await completeTurn(harness, createSession('minimal'))
    expect(harness.search.mock.calls[0]?.[0].filter).toEqual(agentId ? { user: { agent_id: agentId } } : undefined)
    if (agentId) expect(harness.add.mock.calls[0]?.[0].agent_id).toBe(agentId)
    else expect(harness.add.mock.calls[0]?.[0]).not.toHaveProperty('agent_id')
    expect(harness.add.mock.calls[0]?.[0].info).not.toHaveProperty('dsh_agent_preset')
    expect(legacyRead).not.toHaveBeenCalled()
  })

  it('preserves the header fallback on owner read failure without consulting the deprecated API', async () => {
    const legacyRead = vi.fn(() => 'stale-projection')
    const harness = await mount({
      presets: { presetForSession() { throw new Error('owner unavailable') } },
      projection: { stateOf: legacyRead },
    })
    await completeTurn(harness, createSession('minimal'))
    expect(harness.search.mock.calls[0]?.[0].filter).toEqual({ user: { agent_id: 'minimal' } })
    expect(harness.add.mock.calls[0]?.[0].agent_id).toBe('minimal')
    expect(legacyRead).not.toHaveBeenCalled()
  })

  it('keeps memory operations available after the optional preset owner is disposed', async () => {
    const harness = await mount({ presets: { presetForSession: () => 'coding' } })
    const session = createSession('minimal')
    await completeTurn(harness, session)
    await harness.owner!.dispose()
    expect(harness.root.get('agentPresets')).toBeUndefined()
    await completeTurn(harness, session, 2)
    expect(harness.search.mock.calls.map(([request]) => request.filter)).toEqual([
      { user: { agent_id: 'coding' } }, { user: { agent_id: 'minimal' } },
    ])
    expect(harness.add.mock.calls.map(([request]) => request.agent_id)).toEqual(['coding', 'minimal'])
  })

  it('follows legacy projection switches when the owner has no modern read method', async () => {
    let current = 'coding'
    const harness = await mount({ presets: {}, projection: { stateOf: () => current } })
    const session = createSession('minimal')
    await completeTurn(harness, session)
    current = 'standard'
    await completeTurn(harness, session, 2)

    expect(session.header.agentPreset).toBe('minimal')
    expect(harness.search.mock.calls.map(([request]) => request.filter)).toEqual([
      { user: { agent_id: 'coding' } },
      { user: { agent_id: 'standard' } },
    ])
    expect(harness.add.mock.calls.map(([request]) => request.agent_id)).toEqual(['coding', 'standard'])
    expect(harness.add.mock.calls.map(([request]) => request.info?.dsh_agent_preset)).toEqual(['coding', 'standard'])
  })

  it.each([
    { name: 'no projection service', projection: undefined, expected: 'minimal' },
    { name: 'an unregistered projection', projection: projectionOf(undefined), expected: 'minimal' },
    {
      name: 'a failing projection',
      projection: { stateOf() { throw new Error('projection unavailable') } },
      expected: 'minimal',
    },
    { name: 'an explicitly cleared preset', projection: projectionOf(null), expected: 'fallback' },
  ])('uses the same fallback for search and add with $name', async ({ projection, expected }) => {
    const harness = await mount({ ...(projection === undefined ? {} : { projection }), agentId: 'fallback' })
    await completeTurn(harness, createSession('minimal'))
    expect(harness.search).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      filter: { user: { agent_id: expected } },
    }), expect.any(AbortSignal))
    expect(harness.add).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agent_id: expected }), expect.any(AbortSignal))
  })

  it.each([
    { name: 'a cleared preset', projection: projectionOf(null), header: 'minimal' },
    { name: 'a session without a preset', projection: undefined, header: undefined },
  ])('omits agent_id when $name has no configured fallback', async ({ projection, header }) => {
    const harness = await mount(projection === undefined ? {} : { projection })
    await completeTurn(harness, createSession(header))
    expect(harness.search).toHaveBeenCalledOnce()
    expect(harness.search.mock.calls[0]?.[0].filter).toBeUndefined()
    expect(harness.add).toHaveBeenCalledOnce()
    expect(harness.add.mock.calls[0]?.[0]).not.toHaveProperty('agent_id')
    expect(harness.add.mock.calls[0]?.[0].info).not.toHaveProperty('dsh_agent_preset')
  })

  it.each([
    { name: 'owner API', presets: { presetForSession: () => 'coding' } },
    { name: 'legacy projection', projection: projectionOf('coding') },
  ])('keeps the configured agent_id when multiAgentMode is disabled with $name', async services => {
    const harness = await mount({ ...services, agentId: 'fixed', multiAgentMode: false })
    await completeTurn(harness, createSession('minimal'))
    expect(harness.search).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      filter: { user: { agent_id: 'fixed' } },
    }), expect.any(AbortSignal))
    expect(harness.add).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      agent_id: 'fixed', info: expect.objectContaining({ dsh_agent_preset: 'coding' }),
    }), expect.any(AbortSignal))
  })
})
