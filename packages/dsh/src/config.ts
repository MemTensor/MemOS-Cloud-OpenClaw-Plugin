import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import { buildEffectiveFilter, validateFilter } from '@memtensor/memos-cloud-plugin-core'
import type { JsonObject, MemosInfo } from '@memtensor/memos-cloud-plugin-core'
import {
  environmentValue,
  integerInRange,
  nonBlankList,
  nonBlankSecret,
  normalizeFilterObject,
  normalizeInfo,
  numberInRange,
  optionalString,
} from './config-validation.ts'

export const DEFAULT_API_KEY_ENV = 'MEMOS_API_KEY'
export const DEFAULT_BASE_URL = 'https://memos.memtensor.cn/api/openmem/v1'
export const DEFAULT_USER_ID = 'deepseek-harness-user'

export interface Config {
  apiKey?: string
  apiKeyEnv?: string
  baseURL?: string
  userId?: string
  recallEnabled?: boolean
  addEnabled?: boolean
  includeAssistant?: boolean
  includeSubagents?: boolean
  multiAgentMode?: boolean
  queryPrefix?: string
  recallGlobal?: boolean
  memoryLimitNumber?: number
  preferenceLimitNumber?: number
  includePreference?: boolean
  includeToolMemory?: boolean
  toolMemoryLimitNumber?: number
  relativity?: number
  filter?: JsonObject
  knowledgebaseIds?: string[]
  tags?: string[]
  info?: MemosInfo
  agentId?: string
  appId?: string
  allowKnowledgebaseIds?: string[]
  maxQueryChars?: number
  maxRecallChars?: number
  maxItemChars?: number
  maxMessageChars?: number
  timeoutMs?: number
  searchRetries?: number
  addRetries?: number
  allowPublic?: boolean
  asyncMode?: boolean
}

export interface ResolvedConfig {
  apiKey?: string
  apiKeyEnv: string
  baseURL: string
  userId: string
  recallEnabled: boolean
  addEnabled: boolean
  includeAssistant: boolean
  includeSubagents: boolean
  multiAgentMode: boolean
  queryPrefix: string
  recallGlobal: boolean
  memoryLimitNumber: number
  preferenceLimitNumber: number
  includePreference: boolean
  includeToolMemory: boolean
  toolMemoryLimitNumber: number
  relativity: number
  filter?: JsonObject
  knowledgebaseIds: string[]
  tags: string[]
  info: MemosInfo
  agentId?: string
  appId?: string
  allowKnowledgebaseIds: string[]
  maxQueryChars: number
  maxRecallChars: number
  maxItemChars: number
  maxMessageChars: number
  timeoutMs: number
  searchRetries: number
  addRetries: number
  allowPublic: boolean
  asyncMode: boolean
}

export interface CredentialAccessor {
  resolve(ref: CredentialRef): Promise<{ value: string; source: string } | undefined>
}

export interface RuntimeAccessors {
  credentials?: CredentialAccessor
  launchEnvironment: Pick<LaunchEnvironmentSnapshot, 'get'>
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  userId: z.string(),
  recallEnabled: z.boolean().default(true),
  addEnabled: z.boolean().default(true),
  includeAssistant: z.boolean().default(true),
  includeSubagents: z.boolean().default(false),
  multiAgentMode: z.boolean().default(false),
  queryPrefix: z.string().default(''),
  recallGlobal: z.boolean().default(false),
  memoryLimitNumber: z.number().step(1).min(1).max(25).default(6),
  preferenceLimitNumber: z.number().step(1).min(1).max(25).default(6),
  includePreference: z.boolean().default(true),
  includeToolMemory: z.boolean().default(false),
  toolMemoryLimitNumber: z.number().step(1).min(1).max(25).default(6),
  relativity: z.number().min(0).max(1).default(0.45),
  filter: z.union([z.never(), z.dict(z.any())]),
  knowledgebaseIds: z.array(z.string()),
  tags: z.array(z.string()).default(['deepseek-harness']),
  info: z.dict(z.string()),
  agentId: z.string(),
  appId: z.string(),
  allowKnowledgebaseIds: z.array(z.string()),
  maxQueryChars: z.number().step(1).min(1).max(100_000).default(4000),
  maxRecallChars: z.number().step(1).min(1).max(100_000).default(12_000),
  maxItemChars: z.number().step(1).min(1).max(100_000).default(2000),
  maxMessageChars: z.number().step(1).min(1).max(100_000).default(12_000),
  timeoutMs: z.number().step(1).min(100).max(60_000).default(5000),
  searchRetries: z.number().step(1).min(0).max(3).default(1),
  addRetries: z.number().step(1).min(0).max(3).default(0),
  allowPublic: z.boolean().default(false),
  asyncMode: z.boolean().default(true),
})

export const normalizeConfig = (
  input: Config = {},
  environment?: Pick<LaunchEnvironmentSnapshot, 'get'>,
): ResolvedConfig => {
  const config = structuredClone(input)
  const apiKey = optionalString(config.apiKey, false)
  const agentId = optionalString(config.agentId)
  const appId = optionalString(config.appId)
  const multiAgentMode = config.multiAgentMode ?? false
  const filter = normalizeFilterObject(config.filter)
  const knowledgebaseIds = nonBlankList('knowledgebaseIds', config.knowledgebaseIds)
  try {
    validateFilter(filter, knowledgebaseIds)
    if (multiAgentMode) {
      // The effective id varies by Session preset, so a fixed agent_id inside
      // the user filter can never be valid for every Session. Two sentinels
      // ensure even a coincidental match with one is rejected by the other.
      for (const filterAgentId of ['dsh-agent-preset-a', 'dsh-agent-preset-b']) {
        validateFilter(buildEffectiveFilter(filter, filterAgentId), knowledgebaseIds)
      }
    } else if (agentId !== undefined) {
      validateFilter(buildEffectiveFilter(filter, agentId), knowledgebaseIds)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new TypeError(`memos-cloud: ${message}`)
  }
  const userId = optionalString(config.userId)
    ?? environmentValue(environment, 'MEMOS_USER_ID')
    ?? DEFAULT_USER_ID
  const baseURL = (optionalString(config.baseURL) ?? DEFAULT_BASE_URL).replace(/\/+$/, '')

  return {
    ...(apiKey === undefined ? {} : { apiKey }),
    apiKeyEnv: optionalString(config.apiKeyEnv) ?? DEFAULT_API_KEY_ENV,
    baseURL,
    userId,
    recallEnabled: config.recallEnabled ?? true,
    addEnabled: config.addEnabled ?? true,
    includeAssistant: config.includeAssistant ?? true,
    includeSubagents: config.includeSubagents ?? false,
    multiAgentMode,
    queryPrefix: config.queryPrefix ?? '',
    recallGlobal: config.recallGlobal ?? false,
    memoryLimitNumber: integerInRange('memoryLimitNumber', config.memoryLimitNumber ?? 6, 1, 25),
    preferenceLimitNumber: integerInRange('preferenceLimitNumber', config.preferenceLimitNumber ?? 6, 1, 25),
    includePreference: config.includePreference ?? true,
    includeToolMemory: config.includeToolMemory ?? false,
    toolMemoryLimitNumber: integerInRange('toolMemoryLimitNumber', config.toolMemoryLimitNumber ?? 6, 1, 25),
    relativity: numberInRange('relativity', config.relativity ?? 0.45, 0, 1),
    ...(filter === undefined ? {} : { filter }),
    knowledgebaseIds,
    tags: nonBlankList('tags', config.tags, ['deepseek-harness']),
    info: normalizeInfo(config.info),
    ...(agentId === undefined ? {} : { agentId }),
    ...(appId === undefined ? {} : { appId }),
    allowKnowledgebaseIds: nonBlankList('allowKnowledgebaseIds', config.allowKnowledgebaseIds),
    maxQueryChars: integerInRange('maxQueryChars', config.maxQueryChars ?? 4000, 1, 100_000),
    maxRecallChars: integerInRange('maxRecallChars', config.maxRecallChars ?? 12_000, 1, 100_000),
    maxItemChars: integerInRange('maxItemChars', config.maxItemChars ?? 2000, 1, 100_000),
    maxMessageChars: integerInRange('maxMessageChars', config.maxMessageChars ?? 12_000, 1, 100_000),
    timeoutMs: integerInRange('timeoutMs', config.timeoutMs ?? 5000, 100, 60_000),
    searchRetries: integerInRange('searchRetries', config.searchRetries ?? 1, 0, 3),
    addRetries: integerInRange('addRetries', config.addRetries ?? 0, 0, 3),
    allowPublic: config.allowPublic ?? false,
    asyncMode: config.asyncMode ?? true,
  }
}

export const resolveApiKey = async (
  config: ResolvedConfig,
  accessors: RuntimeAccessors,
): Promise<string | undefined> => {
  const literal = nonBlankSecret(config.apiKey)
  if (literal !== undefined) return literal

  const resolved = await accessors.credentials?.resolve(credentialRef(config.apiKeyEnv))
  const credential = nonBlankSecret(resolved?.value)
  if (credential !== undefined) return credential

  return nonBlankSecret(accessors.launchEnvironment.get(config.apiKeyEnv)?.value)
}
