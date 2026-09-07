import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MemosClient } from '@memtensor/memos-cloud-plugin-core'
import type { MemosAddRequest } from '@memtensor/memos-cloud-plugin-core'
import { captureTurn } from './capture.ts'
import {
  Config as ConfigSchema,
  normalizeConfig,
  resolveApiKey,
  type Config,
  type ResolvedConfig,
} from './config.ts'
import type {
  MemosClientLike,
  MemosLifecycleController,
  MemosLifecycleDependencies,
  PreStepNext,
  PreStepPayload,
} from './lifecycle-types.ts'
import { buildAddPayload, buildSearchPayload } from './payloads.ts'
import {
  createRecallMessage,
  extractDirectUserQuery,
  insertRecallBeforeDirectUser,
  projectRecall,
} from './recall.ts'
import { SessionWriteQueue } from './write-queue.ts'

export type {
  MemosClientLike,
  MemosLifecycleController,
  MemosLifecycleDependencies,
} from './lifecycle-types.ts'

export const MEMOS_SETTINGS_NAMESPACE = settingsNamespace('memos-cloud')

const isSubagent = (session: Session): boolean => session.header.origin === 'subagent'

const errorDescription = (error: unknown, configError: boolean): string => {
  if (configError && error instanceof Error) return error.message
  if (error instanceof Error && error.name === 'MemosClientError') return error.message
  return 'unexpected failure'
}

export const installMemosLifecycle = (
  ctx: Context,
  entry: Config = {},
  dependencies: MemosLifecycleDependencies = {},
): MemosLifecycleController => {
  const logger = dependencies.logger ?? ctx.logger('memos-cloud')
  const launchEnvironment = launchEnvironmentOf(ctx)
  const lifecycle = new AbortController()
  const writes = new SessionWriteQueue()
  const searches = new Set<Promise<unknown>>()
  const processedTurns = new WeakMap<Session, Set<number>>()
  const warned = new Set<string>()
  let accepting = true
  let current: () => Config = () => entry

  const warnOnce = (area: 'config' | 'search' | 'add', error: unknown): void => {
    const detail = errorDescription(error, area === 'config')
    const key = `${area}:${detail}`
    if (warned.has(key)) return
    warned.add(key)
    logger.warn(`MemOS ${area} skipped: ${detail}`)
  }

  const resolvedConfig = (): ResolvedConfig | undefined => {
    try {
      return normalizeConfig(current(), launchEnvironment)
    } catch (error) {
      warnOnce('config', error)
      return undefined
    }
  }

  const defaultClientFactory = (config: ResolvedConfig, signal: AbortSignal): MemosClientLike => (
    new MemosClient({
      baseURL: config.baseURL,
      timeoutMs: config.timeoutMs,
      searchRetries: config.searchRetries,
      addRetries: config.addRetries,
      lifecycleSignal: signal,
      resolveApiKey: async () => {
        const credentials = ctx.get('credentials')
        return resolveApiKey(config, {
          launchEnvironment,
          ...(credentials === undefined ? {} : { credentials }),
        })
      },
    })
  )
  const clientFactory = dependencies.clientFactory ?? defaultClientFactory

  const trackSearch = <T>(task: Promise<T>): Promise<T> => {
    searches.add(task)
    void task.finally(() => searches.delete(task)).catch(() => {})
    return task
  }

  installSettingsSection(ctx, MEMOS_SETTINGS_NAMESPACE, ConfigSchema, entry, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {},
    validate: (value) => {
      normalizeConfig(value, launchEnvironment)
    },
  })

  const handlePreStep = async (
    payload: PreStepPayload,
    next: PreStepNext,
  ): ReturnType<PreStepNext> => {
    const decision = await next()
    if (!accepting || payload.step !== 1 || decision.kind !== 'enter' || payload.signal.aborted) return decision
    const config = resolvedConfig()
    if (config === undefined || !config.recallEnabled) return decision
    if (isSubagent(payload.agent.session) && !config.includeSubagents) return decision
    const query = extractDirectUserQuery(decision.messages, config.maxQueryChars)
    if (query === undefined) return decision

    try {
      const client = clientFactory(config, lifecycle.signal)
      const request = buildSearchPayload({
        config,
        sessionId: payload.agent.session.id,
        ...(payload.agent.session.header.agentPreset === undefined
          ? {}
          : { agentPreset: payload.agent.session.header.agentPreset }),
        query,
        ...(dependencies.platform === undefined ? {} : { platform: dependencies.platform }),
      })
      const data = await trackSearch(client.search(request, payload.signal))
      if (payload.signal.aborted || lifecycle.signal.aborted) return decision
      const projection = projectRecall(data, {
        maxItemChars: dependencies.maxRecallItemChars ?? Math.min(config.maxItemChars, config.maxRecallChars),
        maxTotalChars: config.maxRecallChars,
      })
      if (projection === undefined) return decision
      return {
        kind: 'enter',
        messages: insertRecallBeforeDirectUser(decision.messages, createRecallMessage(projection)),
      }
    } catch (error) {
      if (payload.signal.aborted || lifecycle.signal.aborted) return decision
      warnOnce('search', error)
      return decision
    }
  }

  const enqueueAdd = (session: Session, request: MemosAddRequest, client: MemosClientLike): void => {
    writes.enqueue(session, async () => {
      try {
        await client.add(request, lifecycle.signal)
      } catch (error) {
        warnOnce('add', error)
      }
    })
  }

  const handleSessionEvent = (session: Session, event: SessionEvent): void => {
    if (!accepting || event.type !== 'turn/end' || event.data.reason.kind !== 'completed') return
    const config = resolvedConfig()
    if (config === undefined || !config.addEnabled) return
    if (isSubagent(session) && !config.includeSubagents) return
    const seen = processedTurns.get(session) ?? new Set<number>()
    if (seen.has(event.data.turn)) return
    const messages = captureTurn(session.events, event.seq, {
      includeAssistant: config.includeAssistant,
      includeToolMemory: config.includeToolMemory,
      maxMessageChars: config.maxMessageChars,
    })
    if (messages === undefined) return
    seen.add(event.data.turn)
    processedTurns.set(session, seen)

    try {
      const client = clientFactory(config, lifecycle.signal)
      const request = buildAddPayload({
        config,
        sessionId: session.id,
        messages,
        origin: isSubagent(session) ? 'subagent' : 'top-level',
        ...(session.header.agentPreset === undefined ? {} : { agentPreset: session.header.agentPreset }),
        ...(dependencies.platform === undefined ? {} : { platform: dependencies.platform }),
      })
      enqueueAdd(session, request, client)
    } catch (error) {
      warnOnce('add', error)
    }
  }

  const offPreStep = ctx.on('agent/pre-step', handlePreStep, { prepend: true })
  const offSessionEvent = ctx.on('session/event', handleSessionEvent)

  const drain = async (): Promise<void> => {
    while (searches.size > 0) await Promise.allSettled([...searches])
    await writes.drain()
  }
  const disposeEffect = ctx.effect(() => async () => {
    if (!accepting) return
    accepting = false
    offPreStep()
    offSessionEvent()
    lifecycle.abort()
    await drain()
  }, 'memos-cloud lifecycle')

  return { drain, dispose: disposeEffect }
}
