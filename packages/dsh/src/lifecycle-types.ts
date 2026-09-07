import type { Logger } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { MemosAddRequest, MemosSearchData, MemosSearchRequest } from '@memtensor/memos-cloud-plugin-core'
import type { ResolvedConfig } from './config.ts'

export interface MemosClientLike {
  search(request: MemosSearchRequest, signal?: AbortSignal): Promise<MemosSearchData>
  add(request: MemosAddRequest, signal?: AbortSignal): Promise<unknown>
}

export interface MemosLifecycleDependencies {
  clientFactory?: (config: ResolvedConfig, lifecycleSignal: AbortSignal) => MemosClientLike
  logger?: Pick<Logger, 'warn'>
  platform?: NodeJS.Platform
  maxRecallItemChars?: number
}

export interface MemosLifecycleController {
  drain(): Promise<void>
  dispose(): Promise<void>
}

export interface PreStepPayload {
  agent: Agent
  messages: UserMessage[]
  turn: number
  step: number
  signal: AbortSignal
}

export type PreStepNext = () => Promise<PreStepDecision>
