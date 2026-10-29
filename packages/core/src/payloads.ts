import type {
  JsonObject,
  MemosAddRequest,
  MemosInfo,
  MemosMessage,
  MemosSearchRequest,
} from './types.js'

export interface BuildMemosSearchRequestInput {
  userId: string
  query: string
  source: string
  conversationId?: string
  memoryLimitNumber: number
  includePreference: boolean
  preferenceLimitNumber: number
  includeToolMemory: boolean
  toolMemoryLimitNumber: number
  relativity: number
  filter?: JsonObject
  knowledgebaseIds?: readonly string[]
}

export const buildMemosSearchRequest = (
  input: BuildMemosSearchRequestInput,
): MemosSearchRequest => ({
  user_id: input.userId,
  query: input.query,
  ...(input.conversationId === undefined ? {} : { conversation_id: input.conversationId }),
  source: input.source,
  memory_limit_number: input.memoryLimitNumber,
  include_preference: input.includePreference,
  preference_limit_number: input.preferenceLimitNumber,
  include_tool_memory: input.includeToolMemory,
  tool_memory_limit_number: input.toolMemoryLimitNumber,
  relativity: input.relativity,
  ...(input.filter === undefined ? {} : { filter: structuredClone(input.filter) }),
  ...(input.knowledgebaseIds === undefined || input.knowledgebaseIds.length === 0
    ? {}
    : { knowledgebase_ids: [...input.knowledgebaseIds] }),
})
export interface BuildMemosAddRequestInput {
  userId: string
  conversationId: string
  messages: readonly MemosMessage[]
  source: string
  asyncMode: boolean
  allowPublic: boolean
  tags?: readonly string[]
  info?: MemosInfo
  agentId?: string
  appId?: string
  allowKnowledgebaseIds?: readonly string[]
}

const normalizeAddMessage = (message: MemosMessage): MemosMessage => {
  const cloned = structuredClone(message)
  if (
    cloned.role === 'assistant'
    && cloned.content === undefined
    && cloned.tool_calls !== undefined
    && cloned.tool_calls.length > 0
  ) {
    cloned.content = ''
  }
  return cloned
}

export const buildMemosAddRequest = (
  input: BuildMemosAddRequestInput,
): MemosAddRequest => ({
  user_id: input.userId,
  conversation_id: input.conversationId,
  messages: input.messages.map(normalizeAddMessage),
  source: input.source,
  async_mode: input.asyncMode,
  allow_public: input.allowPublic,
  ...(input.tags === undefined || input.tags.length === 0 ? {} : { tags: [...input.tags] }),
  ...(input.info === undefined ? {} : { info: structuredClone(input.info) }),
  ...(input.agentId === undefined ? {} : { agent_id: input.agentId }),
  ...(input.appId === undefined ? {} : { app_id: input.appId }),
  ...(input.allowKnowledgebaseIds === undefined || input.allowKnowledgebaseIds.length === 0
    ? {}
    : { allow_knowledgebase_ids: [...input.allowKnowledgebaseIds] }),
})
