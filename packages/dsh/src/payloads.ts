import { createHash } from 'node:crypto'
import {
  buildEffectiveFilter,
  buildMemosAddRequest,
  buildMemosSearchRequest,
  truncateUnicode,
} from '@memtensor/memos-cloud-plugin-core'
import type { MemosAddRequest, MemosMessage, MemosSearchRequest } from '@memtensor/memos-cloud-plugin-core'
import type { ResolvedConfig } from './config.ts'

const CONVERSATION_ID_LIMIT = 100

export type DshOrigin = 'top-level' | 'subagent'

export interface SearchPayloadInput {
  config: ResolvedConfig
  sessionId: string
  agentPreset?: string
  query: string
  platform?: NodeJS.Platform
}

export interface AddPayloadInput {
  config: ResolvedConfig
  sessionId: string
  messages: readonly MemosMessage[]
  platform?: NodeJS.Platform
  agentPreset?: string
  origin: DshOrigin
}

export const memosSource = (platform: NodeJS.Platform = process.platform): string => {
  if (platform === 'win32') return 'deepseek_harness_win'
  if (platform === 'darwin') return 'deepseek_harness_mac'
  if (platform === 'linux') return 'deepseek_harness_linux'
  return 'deepseek_harness'
}

export const conversationIdFor = (sessionId: string): string => {
  if (sessionId.trim().length === 0) throw new TypeError('sessionId cannot be blank')
  const readable = `dsh:${sessionId}`
  if (readable.length <= CONVERSATION_ID_LIMIT) return readable
  return `dsh:${createHash('sha256').update(sessionId).digest('hex')}`
}

export const effectiveAgentId = (
  config: ResolvedConfig,
  agentPreset?: string,
): string | undefined => {
  if (!config.multiAgentMode) return config.agentId
  const preset = agentPreset?.trim()
  return preset === undefined || preset.length === 0 ? config.agentId : preset
}

export const buildSearchPayload = ({
  config,
  sessionId,
  agentPreset,
  query,
  platform,
}: SearchPayloadInput): MemosSearchRequest => {
  const filter = buildEffectiveFilter(config.filter, effectiveAgentId(config, agentPreset))
  return buildMemosSearchRequest({
    userId: config.userId,
    query: truncateUnicode(`${config.queryPrefix}${query}`, config.maxQueryChars),
    ...(config.recallGlobal ? {} : { conversationId: conversationIdFor(sessionId) }),
    source: memosSource(platform),
    memoryLimitNumber: config.memoryLimitNumber,
    includePreference: config.includePreference,
    preferenceLimitNumber: config.preferenceLimitNumber,
    includeToolMemory: config.includeToolMemory,
    toolMemoryLimitNumber: config.toolMemoryLimitNumber,
    relativity: config.relativity,
    ...(filter === undefined ? {} : { filter }),
    ...(config.knowledgebaseIds.length === 0
      ? {}
      : { knowledgebaseIds: config.knowledgebaseIds }),
  })
}

export const buildAddPayload = ({
  config,
  sessionId,
  messages,
  platform,
  agentPreset,
  origin,
}: AddPayloadInput): MemosAddRequest => {
  const preset = agentPreset?.trim()
  const agentId = effectiveAgentId(config, agentPreset)
  const info = {
    ...structuredClone(config.info),
    integration: 'deepseek-harness',
    dsh_origin: origin,
    // MemOS' public add contract accepts string values in info. Its filter API
    // can compare ordinary info fields by exact scalar value, so preserve the
    // configured order as a deterministic semicolon-delimited tag-set string.
    ...(config.tags.length === 0 ? {} : { dsh_tags: config.tags.join(';') }),
    ...(preset === undefined || preset.length === 0 ? {} : { dsh_agent_preset: preset }),
  }

  return buildMemosAddRequest({
    userId: config.userId,
    conversationId: conversationIdFor(sessionId),
    messages: messages.map((message) => ({ ...message })),
    source: memosSource(platform),
    asyncMode: config.asyncMode,
    allowPublic: config.allowPublic,
    ...(config.tags.length === 0 ? {} : { tags: config.tags }),
    info,
    ...(agentId === undefined ? {} : { agentId }),
    ...(config.appId === undefined ? {} : { appId: config.appId }),
    ...(config.allowKnowledgebaseIds.length === 0
      ? {}
      : { allowKnowledgebaseIds: config.allowKnowledgebaseIds }),
  })
}
