// Pass-through observation of real MemOS and model traffic; never log headers.
import { appendFileSync } from 'node:fs';

const output = process.env.MEMOS_OPENCLAW_LIVE_FETCH_LOG;
if (output) {
  const secrets = [process.env.MEMOS_API_KEY, process.env.PR177_MODEL_API_KEY, process.env.OPENCLAW_GATEWAY_TOKEN].filter(Boolean);
  const save = value => {
    let line = JSON.stringify({ time: Date.now(), ...value });
    for (const secret of secrets) line = line.split(secret).join('[REDACTED]');
    appendFileSync(output, line + '\n', { mode: 0o600 });
  };
  const original = globalThis.fetch;
  let sequence = 0;
  globalThis.fetch = async function(input, init) {
    const url = String(input?.url ?? input);
    const memory = /\/(?:search\/memory|add\/message)\/?$/.test(url);
    const model = /\/(?:chat\/completions|responses)\/?$/.test(url);
    if (!memory && !model) return original.call(this, input, init);
    const id = `${process.pid}-${++sequence}`;
    let body = init?.body;
    if (body === undefined && input instanceof Request) body = await input.clone().text();
    try { body = JSON.parse(body); } catch { body = String(body ?? ''); }
    save({ event: 'request', id, kind: memory ? 'memory' : 'model', url, body });
    const start = Date.now();
    try {
      const response = await original.call(this, input, init);
      save({ event: 'response', id, status: response.status, elapsedMs: Date.now() - start });
      if (memory) response.clone().text().then(text => {
        let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
        save({ event: 'response-body', id, elapsedMs: Date.now() - start, body: parsed });
      }).catch(error => save({ event: 'observation-error', id, error: error.message }));
      return response;
    } catch(error) {
      save({ event: 'fetch-error', id, elapsedMs: Date.now() - start, error: error.message });
      throw error;
    }
  };
}
