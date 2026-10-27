import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { MemosClient, MemosClientError } from '@memtensor/memos-cloud-plugin-core'
import type { MemosAddRequest } from '@memtensor/memos-cloud-plugin-core'
import { captureTurn, readSessionEvents } from './capture.ts'
import {
  Config as ConfigSchema,
  configSnapshot,
  normalizeConfig,
  resolveApiKey,
  type Config,
  type ConfigInput,
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
import { prepareLegacyMigration, type LegacySettings } from './settings-compat.ts'

export type {
  MemosClientLike,
  MemosLifecycleController,
  MemosLifecycleDependencies,
} from './lifecycle-types.ts'

export const MEMOS_SETTINGS_NAMESPACE = 'memos-cloud' as SettingsNamespace

const isSubagent = (session: Session): boolean => session.header.origin === 'subagent'

/** The session-projection service a runtime may expose; older runtimes have none. */
interface SessionProjectionsLike {
  stateOf?: (session: Session, key: string) => unknown
}

/**
 * The current preset lives in the `agentPreset` session projection; the header
 * carries only its initial value. An absent service, an unregistered projection,
 * or a failed lookup each fall back to the header, while a projection reporting
 * no preset stays absent instead of reviving a stale header value.
 */
const agentPresetOf = (ctx: Context, session: Session): string | undefined => {
  try {
    // This optional service is not declared in inject. Property access would
    // throw in a mounted Cordis plugin, so query it through get().
    const projections = ctx.get('sessionProjections') as SessionProjectionsLike | undefined
    const current = projections?.stateOf?.(session, 'agentPreset')
    if (current !== undefined) return typeof current === 'string' ? current : undefined
  } catch {
    // Older hosts may not expose the projection or may not have registered it.
  }
  return session.header.agentPreset
}

const errorDescription = (error: unknown, configError: boolean): string => {
  if (configError && error instanceof Error) return error.message
  if (error instanceof Error && error.name === 'MemosClientError') return error.message
  return 'unexpected failure'
}

export const installMemosLifecycle = (
  ctx: Context,
  entry: ConfigInput = {},
  dependencies: MemosLifecycleDependencies = {},
): MemosLifecycleController => {
  const logger = dependencies.logger ?? ctx.logger('memos-cloud')
  const launchEnvironment = launchEnvironmentOf(ctx)
  const lifecycle = new AbortController()
  const writeLifecycle = new AbortController()
  const writes = new SessionWriteQueue()
  const searches = new Set<Promise<unknown>>()
  const processedTurns = new WeakMap<Session, Set<number>>()
  const warned = new Set<string>()
  let accepting = true
  let current: () => Config = () => configSnapshot(entry)
  let ready: Promise<void> = Promise.resolve()
  let settingsError: unknown
  let settingsPending = false

  const warnOnce = (area: 'config' | 'search' | 'add', error: unknown): void => {
    const detail = errorDescription(error, area === 'config')
    const key = `${area}:${detail}`
    if (warned.has(key)) return
    warned.add(key)
    logger.warn(`MemOS ${area} skipped: ${detail}`)
  }

  const resolvedConfig = (): ResolvedConfig | undefined => {
    try {
      if (settingsError !== undefined) throw settingsError
      return normalizeConfig(current(), launchEnvironment)
    } catch (error) {
      warnOnce('config', error)
      return undefined
    }
  }

  const defaultClientFactory = (config: ResolvedConfig, signal: AbortSignal, operation: 'search' | 'add'): MemosClientLike => (
    new MemosClient({
      baseURL: config.baseURL,
      timeoutMs: operation === 'search' ? config.searchTimeoutMs : config.addTimeoutMs,
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

  // ConfigEditor validates through this waterfall before persisting edits.
  // Keep cross-field constraints identical to the legacy provider's validator.
  ctx.on('internal/config', function (_input, next) {
    const value = next()
    if (this === ctx.fiber) normalizeConfig(ConfigSchema(value), launchEnvironment)
    return value
  })

  const trackSearch = <T>(task: Promise<T>): Promise<T> => {
    searches.add(task)
    void task.finally(() => searches.delete(task)).catch(() => {})
    return task
  }

  // Older hosts own settings sections; newer hosts project our volatile Config
  // directly into SettingsForms and supply a live config reference.
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings as unknown as Partial<LegacySettings>
    if (typeof settings.register !== 'function') {
      const failed = (): void => {
        settingsError = new Error('Legacy MemOS settings migration failed; check the preserved configuration in the profile and restart after fixing it')
        warnOnce('config', settingsError)
      }
      try {
        const migrate = prepareLegacyMigration(ctx)
        settingsPending = true
        ready = migrate().catch(failed).finally(() => { settingsPending = false })
      } catch { failed() }
      return
    }
    const scope = settings.register(MEMOS_SETTINGS_NAMESPACE, ConfigSchema, {
      base: configSnapshot(entry),
      validate: (value) => {
        normalizeConfig(value, launchEnvironment)
      },
    })
    current = () => scope.get()
    settingsCtx.effect(() => () => {
      current = () => configSnapshot(entry)
    })
  })

  const handlePreStep = async (
    payload: PreStepPayload,
    next: PreStepNext,
  ): ReturnType<PreStepNext> => {
    const decision = await next()
    await ready
    if (!accepting || payload.step !== 1 || decision.kind !== 'enter' || payload.signal.aborted) return decision
    const config = resolvedConfig()
    if (config === undefined || !config.recallEnabled) return decision
    if (isSubagent(payload.agent.session) && !config.includeSubagents) return decision
    const query = extractDirectUserQuery(decision.messages, config.maxQueryChars)
    if (query === undefined) return decision

    try {
      const client = clientFactory(config, lifecycle.signal, 'search')
      const agentPreset = agentPresetOf(ctx, payload.agent.session)
      const request = buildSearchPayload({
        config,
        sessionId: payload.agent.session.id,
        ...(agentPreset === undefined ? {} : { agentPreset }),
        query,
        ...(dependencies.platform === undefined ? {} : { platform: dependencies.platform }),
      })
      // Bound the whole recall, including retries and credential lookup. Only
      // memory IO receives this signal; expiry must not cancel the model turn.
      const deadline = new AbortController()
      const signal = AbortSignal.any([payload.signal, lifecycle.signal, deadline.signal])
      let timer: ReturnType<typeof setTimeout> | undefined
      const search = async () => {
        try {
          return await Promise.race([
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                reject(new MemosClientError('MemOS recall timed out', { kind: 'timeout' }))
                deadline.abort()
              }, config.searchTimeoutMs)
            }),
            client.search(request, signal),
          ])
        } finally { clearTimeout(timer) }
      }
      const data = await trackSearch(search())
      if (payload.signal.aborted || lifecycle.signal.aborted) return decision
      const projection = projectRecall(data, {
        maxItemChars: dependencies.maxRecallItemChars ?? Math.min(config.maxItemChars, config.maxRecallChars),
        maxTotalChars: config.maxRecallChars,
      })
      if (projection === undefined) return decision
      return {
        ...decision,
        messages: insertRecallBeforeDirectUser(decision.messages, createRecallMessage(projection)),
      }
    } catch (error) {
      if (payload.signal.aborted || lifecycle.signal.aborted) return decision
      warnOnce('search', error)
      return decision
    }
  }

  const enqueueAdd = (session: Session, request: MemosAddRequest, client: MemosClientLike, config: ResolvedConfig): void => {
    writes.enqueue(session, async () => {
      try {
        if (writeLifecycle.signal.aborted) return
        await client.add(request, writeLifecycle.signal)
      } catch (error) {
        warnOnce('add', error)
      }
    // Match the client's per-attempt timeout and linear retry delay. The small
    // margin also bounds an unresponsive credential accessor or test transport.
    }, config.addTimeoutMs * (config.addRetries + 1) + 100 * config.addRetries * (config.addRetries + 1) / 2 + 1000)
  }

  const handleSessionEvent = (session: Session, event: SessionEvent): void => {
    if (!accepting || settingsPending || event.type !== 'turn/end' || event.data.reason.kind !== 'completed') return
    const config = resolvedConfig()
    if (config === undefined || !config.addEnabled) return
    if (isSubagent(session) && !config.includeSubagents) return
    const seen = processedTurns.get(session) ?? new Set<number>()
    if (seen.has(event.data.turn)) return
    const messages = captureTurn(readSessionEvents(session), event.seq, {
      includeAssistant: config.includeAssistant,
      includeToolMemory: config.includeToolMemory,
      maxMessageChars: config.maxMessageChars,
    })
    if (messages === undefined) return
    seen.add(event.data.turn)
    processedTurns.set(session, seen)

    try {
      const client = clientFactory(config, writeLifecycle.signal, 'add')
      const agentPreset = agentPresetOf(ctx, session)
      const request = buildAddPayload({
        config,
        sessionId: session.id,
        messages,
        origin: isSubagent(session) ? 'subagent' : 'top-level',
        ...(agentPreset === undefined ? {} : { agentPreset }),
        ...(dependencies.platform === undefined ? {} : { platform: dependencies.platform }),
      })
      enqueueAdd(session, request, client, config)
    } catch (error) {
      warnOnce('add', error)
    }
  }

  const offPreStep = ctx.on('agent/pre-step', handlePreStep, { prepend: true })
  const offSessionEvent = ctx.on('session/event', handleSessionEvent)

  const boundedWait = async (task: Promise<void>, timeoutMs: number): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        task.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) }),
      ])
    } finally { clearTimeout(timer) }
  }

  // Headless calls sessions.flush() after whenIdle(), before appExit starts the
  // host's fixed 5s teardown timer. Disposal alone cannot protect slower writes.
  // Wait only for this session, so another agent's memory IO cannot block it.
  const offSessionFlush = ctx.on('session/flush', async (session) => {
    if (!accepting) return
    const completed = await boundedWait(writes.drain(session), dependencies.shutdownTimeoutMs ?? writes.timeoutBudget(session))
    if (!completed) logger.warn('MemOS session flush timed out: queued writes unconfirmed')
  })

  const drain = async (): Promise<void> => {
    while (searches.size > 0) await Promise.allSettled([...searches])
    await writes.drain()
  }
  const disposeEffect = ctx.effect(() => async () => {
    if (!accepting) return
    accepting = false
    offPreStep()
    offSessionEvent()
    offSessionFlush()
    lifecycle.abort()
    const completed = await boundedWait(drain(), dependencies.shutdownTimeoutMs ?? writes.timeoutBudget())
    if (!completed && writes.pending > 0) logger.warn(`MemOS shutdown timed out: ${writes.pending} write(s) unconfirmed`)
    writeLifecycle.abort()
  }, 'memos-cloud lifecycle')

  return { drain, dispose: disposeEffect }
}
