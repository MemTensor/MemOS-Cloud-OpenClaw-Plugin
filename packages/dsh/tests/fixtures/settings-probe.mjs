import { realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

export const name = 'memos-settings-probe'
export function apply(ctx, config) {
  let inspected = false
  ctx.on('agent/pre-step', async (_payload, next) => {
    if (!inspected) {
      inspected = true
      const sdk = {}
      if (config.sdk) {
        const plugin = fileURLToPath(import.meta.resolve('@memtensor/memos-cloud-dsh-plugin'))
        const pluginRequire = createRequire(plugin)
        for (const [name, expected] of Object.entries(config.sdk)) {
          const resolved = realpathSync(fileURLToPath(import.meta.resolve(name)))
          assert.equal(resolved, realpathSync(expected), `${name} must resolve from the selected host`)
          assert.equal(realpathSync(pluginRequire.resolve(name)), resolved, `${name} must share the plugin's host instance`)
          sdk[name] = resolved
        }
      }
      const settings = ctx.get('settings')
      const form = settings?.describe?.().find(row => row.ns === 'memos-cloud')
      if (config.edit) {
        await settings.update('memos-cloud', { userId: 'ui-user' })
        await assert.rejects(settings.update('memos-cloud', {
          filter: { knowledgebase: { category: 'invalid-without-ids' } },
        }), /knowledgebaseIds/)
      }
      writeFileSync(config.output, JSON.stringify({
        form: !!form,
        sdk,
        errors: ctx.logger.buffer.filter(row => row.type === 'error').map(row => String(row.args)),
      }))
    }
    return next()
  })
}
