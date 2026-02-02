import {
  addMessage,
  buildConfig,
  extractText,
  formatContextBlock,
  searchMemory,
} from "./lib/memos-cloud-api.js";

let lastCaptureTime = 0;
const conversationCounters = new Map();
const API_KEY_HELP_URL = "https://memos-dashboard.openmem.net/cn/apikeys/";
const ENV_FILE_HINTS = "~/.openclaw/.env, ~/.moltbot/.env, ~/.clawdbot/.env";

function warnMissingApiKey(log) {
  log.warn?.(
    [
      "[memos-cloud] Missing MEMOS_API_KEY.",
      "Configure it with one of:",
      "  echo 'export MEMOS_API_KEY=\"mpg-...\"' >> ~/.zshrc",
      "  source ~/.zshrc",
      "  (or ~/.bashrc)",
      "  [System.Environment]::SetEnvironmentVariable(\"MEMOS_API_KEY\", \"mpg-...\", \"User\")",
      `Get an API key at: ${API_KEY_HELP_URL}`,
    ].join("\n"),
  );
}

function getCounterSuffix(sessionKey) {
  if (!sessionKey) return "";
  const current = conversationCounters.get(sessionKey) ?? 0;
  return current > 0 ? `#${current}` : "";
}

function bumpConversationCounter(sessionKey) {
  if (!sessionKey) return;
  const current = conversationCounters.get(sessionKey) ?? 0;
  conversationCounters.set(sessionKey, current + 1);
}

function resolveConversationId(cfg, ctx) {
  if (cfg.conversationId) return cfg.conversationId;
  // TODO: consider binding conversation_id directly to OpenClaw sessionId (prefer ctx.sessionId).
  const base = ctx?.sessionKey || ctx?.sessionId || (ctx?.agentId ? `openclaw:${ctx.agentId}` : "");
  const dynamicSuffix = cfg.conversationSuffixMode === "counter" ? getCounterSuffix(ctx?.sessionKey) : "";
  const prefix = cfg.conversationIdPrefix || "";
  const suffix = cfg.conversationIdSuffix || "";
  if (base) return `${prefix}${base}${dynamicSuffix}${suffix}`;
  return `${prefix}openclaw-${Date.now()}${dynamicSuffix}${suffix}`;
}

function buildSearchPayload(cfg, prompt, ctx) {
  const queryRaw = `${cfg.queryPrefix || ""}${prompt}`;
  const query = queryRaw.slice(0, cfg.maxQueryChars || 2000);

  const payload = {
    user_id: cfg.userId,
    query,
  };

  if (!cfg.recallGlobal) {
    const conversationId = resolveConversationId(cfg, ctx);
    if (conversationId) payload.conversation_id = conversationId;
  }

  if (cfg.filter) payload.filter = cfg.filter;
  if (cfg.knowledgebaseIds?.length) payload.knowledgebase_ids = cfg.knowledgebaseIds;

  payload.memory_limit_number = cfg.memoryLimitNumber;
  payload.include_preference = cfg.includePreference;
  payload.preference_limit_number = cfg.preferenceLimitNumber;
  payload.include_tool_memory = cfg.includeToolMemory;
  payload.tool_memory_limit_number = cfg.toolMemoryLimitNumber;

  return payload;
}

function buildAddMessagePayload(cfg, messages, ctx) {
  const payload = {
    user_id: cfg.userId,
    conversation_id: resolveConversationId(cfg, ctx),
    messages,
  };

  if (cfg.agentId) payload.agent_id = cfg.agentId;
  if (cfg.appId) payload.app_id = cfg.appId;
  if (cfg.tags?.length) payload.tags = cfg.tags;

  const info = {
    source: "openclaw",
    sessionKey: ctx?.sessionKey,
    agentId: ctx?.agentId,
    ...(cfg.info || {}),
  };
  if (Object.keys(info).length > 0) payload.info = info;

  payload.allow_public = cfg.allowPublic;
  if (cfg.allowKnowledgebaseIds?.length) payload.allow_knowledgebase_ids = cfg.allowKnowledgebaseIds;
  payload.async_mode = cfg.asyncMode;

  return payload;
}

function pickLastTurnMessages(messages, cfg) {
  const lastUserIndex = messages
    .map((m, idx) => ({ m, idx }))
    .filter(({ m }) => m?.role === "user")
    .map(({ idx }) => idx)
    .pop();

  if (lastUserIndex === undefined) return [];

  const slice = messages.slice(lastUserIndex);
  const results = [];

  for (const msg of slice) {
    if (!msg || !msg.role) continue;
    if (msg.role === "user") {
      const content = extractText(msg.content);
      if (content) results.push({ role: "user", content: truncate(content, cfg.maxMessageChars) });
      continue;
    }
    if (msg.role === "assistant" && cfg.includeAssistant) {
      const content = extractText(msg.content);
      if (content) results.push({ role: "assistant", content: truncate(content, cfg.maxMessageChars) });
    }
  }

  return results;
}

function pickFullSessionMessages(messages, cfg) {
  const results = [];
  for (const msg of messages) {
    if (!msg || !msg.role) continue;
    if (msg.role === "user") {
      const content = extractText(msg.content);
      if (content) results.push({ role: "user", content: truncate(content, cfg.maxMessageChars) });
    }
    if (msg.role === "assistant" && cfg.includeAssistant) {
      const content = extractText(msg.content);
      if (content) results.push({ role: "assistant", content: truncate(content, cfg.maxMessageChars) });
    }
  }
  return results;
}

function truncate(text, maxLen) {
  if (!text) return "";
  if (!maxLen) return text;
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

export default {
  id: "memos-cloud-openclaw-plugin",
  name: "MemOS Cloud OpenClaw Plugin",
  description: "MemOS Cloud recall + add memory via lifecycle hooks",
  kind: "lifecycle",

  register(api) {
    const cfg = buildConfig(api.pluginConfig);
    const log = api.logger ?? console;

    if (cfg.envFileMissing && cfg.apiKey) {
      log.warn?.(`[memos-cloud] No env file found at ${ENV_FILE_HINTS}; using process.env or plugin config.`);
    }

    if (!cfg.apiKey) {
      warnMissingApiKey(log);
    }

    if (cfg.conversationSuffixMode === "counter" && cfg.resetOnNew) {
      if (api.config?.hooks?.internal?.enabled !== true) {
        log.warn?.("[memos-cloud] command:new hook requires hooks.internal.enabled = true");
      }
      api.registerHook(
        ["command:new"],
        (event) => {
          if (event?.type === "command" && event?.action === "new") {
            bumpConversationCounter(event.sessionKey);
          }
        },
        {
          name: "memos-cloud-conversation-new",
          description: "Increment MemOS conversation suffix on /new",
        },
      );
    }

    api.on("before_agent_start", async (event, ctx) => {
      if (!cfg.recallEnabled) return;
      if (!event?.prompt || event.prompt.length < 3) return;
      if (!cfg.apiKey || !cfg.userId) {
        log.warn?.("[memos-cloud] Missing apiKey or userId; recall skipped.");
        return;
      }

      try {
        const payload = buildSearchPayload(cfg, event.prompt, ctx);
        const result = await searchMemory(cfg, payload);
        const contextBlock = formatContextBlock(result, { maxItemChars: 200 });
        if (!contextBlock) return;

        return {
          prependContext: `<user_memory_context>\nRelevant memories from MemOS Cloud:\n${contextBlock}\n</user_memory_context>`,
        };
      } catch (err) {
        log.warn?.(`[memos-cloud] recall failed: ${String(err)}`);
      }
    });

    api.on("agent_end", async (event, ctx) => {
      if (!cfg.addEnabled) return;
      if (!event?.success || !event?.messages?.length) return;
      if (!cfg.apiKey || !cfg.userId) {
        log.warn?.("[memos-cloud] Missing apiKey or userId; add skipped.");
        return;
      }

      const now = Date.now();
      if (cfg.throttleMs && now - lastCaptureTime < cfg.throttleMs) {
        return;
      }
      lastCaptureTime = now;

      try {
        const messages =
          cfg.captureStrategy === "full_session"
            ? pickFullSessionMessages(event.messages, cfg)
            : pickLastTurnMessages(event.messages, cfg);

        if (!messages.length) return;

        const payload = buildAddMessagePayload(cfg, messages, ctx);
        await addMessage(cfg, payload);
      } catch (err) {
        log.warn?.(`[memos-cloud] add failed: ${String(err)}`);
      }
    });
  },
};
