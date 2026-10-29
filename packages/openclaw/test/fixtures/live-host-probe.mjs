import { appendFileSync } from 'node:fs';

export default {
  id: 'memos-live-host-probe', name: 'MemOS live regression observer',
  register(api) {
    const secrets = [process.env.MEMOS_API_KEY, process.env.PR177_MODEL_API_KEY, process.env.OPENCLAW_GATEWAY_TOKEN].filter(Boolean);
    const save = (event, data, ctx) => {
      let line = JSON.stringify({ time: Date.now(), event, agentId: ctx?.agentId,
        sessionKey: ctx?.sessionKey, runId: ctx?.runId, inputProvenance: ctx?.inputProvenance, data });
      for(const secret of secrets) line = line.split(secret).join('[REDACTED]');
      appendFileSync(process.env.MEMOS_OPENCLAW_LIVE_HOST_LOG, line + '\n', { mode: 0o600 });
    };
    for (const name of ['before_prompt_build', 'llm_input', 'llm_output', 'before_tool_call', 'after_tool_call', 'agent_end']) {
      api.on(name, (event, ctx) => { save(name, event, ctx); });
    }
  },
};
