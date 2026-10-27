import { writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'

export const name = 'memos-settings-probe'
export function apply(ctx, config) {
  let inspected = false
  ctx.on('agent/pre-step', async (_payload, next) => {
    if (!inspected) {
      inspected = true
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
        errors: ctx.logger.buffer.filter(row => row.type === 'error').map(row => String(row.args)),
      }))
    }
    return next()
  })
}
