// Separate host process for the shared-home migration regression.
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prepareLegacyMigration } from '../../src/settings-compat.ts'

const [home, name] = process.argv.slice(2)
const dir = join(home, 'profiles', name)
mkdirSync(dir, { recursive: true })
const ctx = new Context()
const inherited = { recallEnabled: true }
const override = { userId: `${name}-user` }
let config = { ...inherited, ...override }
const row = { entry: { fiber: ctx.fiber, options: { id: 'memos-cloud' } }, override }
ctx.provide('profileContext', { home, dir })
ctx.provide('loader', { await: async () => {} })
ctx.provide('configEditor', {
  configuration: () => [row],
  edit: async (_entry, change) => { config = change(config, inherited) },
})
// Both processes prepare before either profile write is allowed to finish.
const released = new Promise(resolve => process.once('message', resolve))
const migrate = prepareLegacyMigration(ctx)
process.send({ ready: true })
await released
await migrate()
writeFileSync(join(dir, 'observed.json'), JSON.stringify(config))
process.disconnect()
