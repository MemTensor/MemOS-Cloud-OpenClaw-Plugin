import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-session'
import type { Config as MemosCloudConfig } from './config.ts'
import { installMemosLifecycle } from './lifecycle.ts'
export { Config } from './config.ts'
export type { Config as MemosCloudConfig, ResolvedConfig } from './config.ts'
export { installMemosLifecycle, MEMOS_SETTINGS_NAMESPACE } from './lifecycle.ts'
export type {
  MemosClientLike,
  MemosLifecycleController,
  MemosLifecycleDependencies,
} from './lifecycle.ts'
export type * from '@memtensor/memos-cloud-plugin-core'

export const name = 'memos-cloud'
export const inject = ['agents', 'sessions']
export const apply = (ctx: Context, config: MemosCloudConfig): void => {
  installMemosLifecycle(ctx, config)
}
