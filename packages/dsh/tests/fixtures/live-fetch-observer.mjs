// Observe real requests. Preserve fetch arguments, signals, responses and body
// contents; record timings when the application consumes a response body.
import { appendFileSync } from 'node:fs'
const output = process.env.DSH_LIVE_FETCH_LOG
const secrets = [process.env.MEMOS_API_KEY, process.env[process.env.DSH_LIVE_MODEL_KEY_ENV]].filter(Boolean)
const redact = value => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value))
const log = value => appendFileSync(output, redact(JSON.stringify({ time: Date.now(), ...value })) + '\n')
const original = globalThis.fetch
let sequence = 0
globalThis.fetch = async function (input, init) {
  const url = String(input?.url ?? input)
  const memory = /\/(search\/memory|add\/message)$/.test(url)
  if (!memory) return original.call(this, input, init)
  const id = ++sequence
  const started = Date.now()
  log({ event: 'request', id, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
  init?.signal?.addEventListener('abort', () => log({ event: 'signal-abort', id, elapsedMs: Date.now() - started,
    reason: init.signal.reason?.name ?? String(init.signal.reason),
  }), { once: true })
  try {
    const response = await original.call(this, input, init)
    log({ event: 'response', id, status: response.status, elapsedMs: Date.now() - started })
    const text = response.text.bind(response)
    response.text = async () => {
      try {
        const body = await text()
        let parsed
        try { parsed = JSON.parse(body) } catch {}
        log({ event: 'response-body', id, elapsedMs: Date.now() - started, body: parsed })
        return body
      } catch (error) {
        log({ event: 'body-error', id, name: error.name, message: error.message, elapsedMs: Date.now() - started })
        throw error
      }
    }
    return response
  } catch (error) {
    log({ event: 'fetch-error', id, name: error.name, message: error.message,
      elapsedMs: Date.now() - started, aborted: init?.signal?.aborted,
    })
    throw error
  }
}
process.once('exit', code => log({ event: 'process-exit', code }))
