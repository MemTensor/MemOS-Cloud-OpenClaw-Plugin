import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
export const name = 'memos-live-host-probe'
export function apply(ctx, config) {
  const secrets = [process.env.MEMOS_API_KEY, process.env[process.env.DSH_LIVE_MODEL_KEY_ENV]].filter(Boolean)
  const log = event => {
    let line = JSON.stringify({ time: Date.now(), ...event })
    for (const secret of secrets) line = line.split(secret).join('[REDACTED]')
    appendFileSync(process.env.DSH_LIVE_HOST_LOG ?? config.output, line + '\n')
  }
  const buffer = ctx.logger.buffer
  ctx.logger.exporter({
    export(record) {
      if (!['warn', 'error'].includes(record.type)) return
      log({ event: 'log', record: { type: record.type, name: record.name,
        args: record.args.map(value => value instanceof Error ? { name: value.name, message: value.message } : value),
      } })
    },
  })
  process.once('exit', () => log({ event: 'logs', records: buffer.filter(row => ['warn', 'error'].includes(row.type)).map(row => ({
    type: row.type, name: row.name, args: row.args.map(value => value instanceof Error ? { name: value.name, message: value.message } : value),
  })) }))
  let inspected = false
  ctx.on('agent/pre-step', async (_payload, next) => {
    if (!inspected) {
      inspected = true
      const settings = ctx.get('settings')
      if (config.edit) {
        await settings.update('memos-cloud', config.edit)
        await assert.rejects(settings.update('memos-cloud', { filter: { knowledgebase: { category: 'needs-ids' } } }), /knowledgebaseIds/)
        log({ event: 'settings-edit', success: true })
      }
      const form = settings?.describe?.().find(row => row.ns === 'memos-cloud')
      log({ event: 'settings', constructor: settings?.constructor?.name, formPresent: !!form,
        userId: form?.value?.userId, asyncMode: form?.value?.asyncMode, timeoutMs: form?.value?.timeoutMs,
        searchTimeoutMs: form?.value?.searchTimeoutMs, syncAddTimeoutMs: form?.value?.syncAddTimeoutMs,
      })
    }
    return next()
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') log({ event: 'turn-end', session: session.id, seq: event.seq, reason: event.data.reason })
  })
}
