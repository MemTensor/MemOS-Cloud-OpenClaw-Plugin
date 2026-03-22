import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_BASE_URL = "https://memos.memtensor.cn/api/openmem/v1";
export const USER_QUERY_MARKER = "user\u200b原\u200b始\u200bquery\u200b：\u200b\u200b\u200b\u200b";
const ENV_SOURCES = [
  { name: "openclaw", path: join(homedir(), ".openclaw", ".env") },
  { name: "moltbot", path: join(homedir(), ".moltbot", ".env") },
  { name: "clawdbot", path: join(homedir(), ".clawdbot", ".env") },
];

let envFilesLoaded = false;
const envFileContents = new Map();
const envFileValues = new Map();

function stripQuotes(value) {
  if (!value) return value;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function extractResultData(result) {
  if (!result || typeof result !== "object") return null;
  // Support both cloud and self-hosted response formats
  return result.data ?? result.data?.data ?? result.data?.result ?? result;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatTime(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number") {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
      date.getHours(),
    )}:${pad2(date.getMinutes())}`;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (/^\d+$/.test(trimmed)) return formatTime(Number(trimmed));
    return trimmed;
  }
  return "";
}

function parseEnvFile(content) {
  const values = new Map();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const rawValue = trimmed.slice(idx + 1);
    if (!key) continue;
    values.set(key, stripQuotes(rawValue));
  }
  return values;
}

function loadEnvFiles() {
  if (envFilesLoaded) return;
  envFilesLoaded = true;
  for (const source of ENV_SOURCES) {
    try {
      const content = readFileSync(source.path, "utf-8");
      envFileContents.set(source.name, content);
      envFileValues.set(source.name, parseEnvFile(content));
    } catch {
      // ignore missing files
    }
  }
}

function loadEnvFromFiles(name) {
  for (const source of ENV_SOURCES) {
    const values = envFileValues.get(source.name);
    if (!values) continue;
    if (values.has(name)) return values.get(name);
  }
  return undefined;
}

function loadEnvVar(name) {
  loadEnvFiles();
  const fromFiles = loadEnvFromFiles(name);
  if (fromFiles !== undefined) return fromFiles;
  if (envFileContents.size === 0) return process.env[name];
  return undefined;
}

export function getEnvFileStatus() {
  loadEnvFiles();
  const sources = ENV_SOURCES.filter((source) => envFileContents.has(source.name));
  return {
    found: sources.length > 0,
    sources: sources.map((source) => source.name),
    paths: sources.map((source) => source.path),
    searchPaths: ENV_SOURCES.map((source) => source.path),
  };
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function parseNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Detect server mode based on baseUrl
 * - cloud: official MemOS cloud service
 * - self-hosted: local or custom MemOS server
 */
function detectServerMode(baseUrl, explicitMode) {
  if (explicitMode) return explicitMode;
  
  // Check if explicitly set to cloud or self-hosted
  const envMode = loadEnvVar("MEMOS_SERVER_MODE");
  if (envMode === "self-hosted" || envMode === "cloud") return envMode;
  
  // Auto-detect: if URL is localhost, 127.0.0.1, or not the official cloud URL, treat as self-hosted
  const isLocalhost = baseUrl.includes("localhost") || 
                      baseUrl.includes("127.0.0.1") ||
                      baseUrl.includes("192.168.") ||
                      baseUrl.includes("10.") ||
                      baseUrl.includes("172.");
  
  const isOfficialCloud = baseUrl.includes("memtensor.cn") || 
                          baseUrl.includes("memos.openmem.net");
  
  if (isLocalhost || !isOfficialCloud) {
    return "self-hosted";
  }
  
  return "cloud";
}

export function buildConfig(pluginConfig = {}) {
  const cfg = pluginConfig ?? {};

  const baseUrl = cfg.baseUrl || loadEnvVar("MEMOS_BASE_URL") || DEFAULT_BASE_URL;
  const apiKey = cfg.apiKey || loadEnvVar("MEMOS_API_KEY") || "";
  const userId = cfg.userId || loadEnvVar("MEMOS_USER_ID") || "openclaw-user";
  const conversationId = cfg.conversationId || loadEnvVar("MEMOS_CONVERSATION_ID") || "";
  
  // NEW: server mode detection
  const serverMode = detectServerMode(baseUrl, cfg.serverMode);

  const recallGlobal = parseBool(
    cfg.recallGlobal,
    parseBool(loadEnvVar("MEMOS_RECALL_GLOBAL"), true),
  );

  const conversationIdPrefix = cfg.conversationIdPrefix ?? loadEnvVar("MEMOS_CONVERSATION_PREFIX") ?? "";
  const conversationIdSuffix = cfg.conversationIdSuffix ?? loadEnvVar("MEMOS_CONVERSATION_SUFFIX") ?? "";
  const conversationSuffixMode =
    cfg.conversationSuffixMode ?? loadEnvVar("MEMOS_CONVERSATION_SUFFIX_MODE") ?? "none";
  const resetOnNew = parseBool(
    cfg.resetOnNew,
    parseBool(loadEnvVar("MEMOS_CONVERSATION_RESET_ON_NEW"), true),
  );

  const multiAgentMode = parseBool(
    cfg.multiAgentMode,
    parseBool(loadEnvVar("MEMOS_MULTI_AGENT_MODE"), false),
  );

  const recallFilterEnabled = parseBool(
    cfg.recallFilterEnabled,
    parseBool(loadEnvVar("MEMOS_RECALL_FILTER_ENABLED"), false),
  );
  const recallFilterFailOpen = parseBool(
    cfg.recallFilterFailOpen,
    parseBool(loadEnvVar("MEMOS_RECALL_FILTER_FAIL_OPEN"), true),
  );

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    userId,
    conversationId,
    conversationIdPrefix,
    conversationIdSuffix,
    conversationSuffixMode,
    recallGlobal,
    resetOnNew,
    envFileStatus: getEnvFileStatus(),
    queryPrefix: cfg.queryPrefix ?? "",
    maxQueryChars: cfg.maxQueryChars ?? 0,
    recallEnabled: cfg.recallEnabled !== false,
    addEnabled: cfg.addEnabled !== false,
    captureStrategy: cfg.captureStrategy ?? "last_turn",
    maxMessageChars: cfg.maxMessageChars ?? 20000,
    maxItemChars: cfg.maxItemChars ?? 8000,
    includeAssistant: cfg.includeAssistant !== false,
    memoryLimitNumber: cfg.memoryLimitNumber ?? 9,
    preferenceLimitNumber: cfg.preferenceLimitNumber ?? 6,
    includePreference: cfg.includePreference !== false,
    includeToolMemory: cfg.includeToolMemory === true,
    toolMemoryLimitNumber: cfg.toolMemoryLimitNumber ?? 6,
    relativity: cfg.relativity ?? ((() => {
      const v = loadEnvVar("MEMOS_RELATIVITY");
      return v ? parseFloat(v) : 0.45;
    })()),
    filter: cfg.filter,
    knowledgebaseIds: cfg.knowledgebaseIds ?? [],
    tags: cfg.tags ?? ["openclaw"],
    info: cfg.info ?? {},
    agentId: cfg.agentId,
    appId: cfg.appId,
    allowPublic: cfg.allowPublic ?? false,
    allowKnowledgebaseIds: cfg.allowKnowledgebaseIds ?? [],
    asyncMode: cfg.asyncMode ?? true,
    multiAgentMode,
    // NEW: server mode
    serverMode,
    recallFilterEnabled,
    recallFilterBaseUrl:
      (cfg.recallFilterBaseUrl ?? loadEnvVar("MEMOS_RECALL_FILTER_BASE_URL") ?? "").replace(/\/+$/, ""),
    recallFilterApiKey: cfg.recallFilterApiKey ?? loadEnvVar("MEMOS_RECALL_FILTER_API_KEY") ?? "",
    recallFilterModel: cfg.recallFilterModel ?? loadEnvVar("MEMOS_RECALL_FILTER_MODEL") ?? "",
    recallFilterTimeoutMs: parseNumber(
      cfg.recallFilterTimeoutMs ?? loadEnvVar("MEMOS_RECALL_FILTER_TIMEOUT_MS"),
      6000,
    ),
    recallFilterRetries: parseNumber(cfg.recallFilterRetries ?? loadEnvVar("MEMOS_RECALL_FILTER_RETRIES"), 0),
    recallFilterCandidateLimit:
      parseNumber(cfg.recallFilterCandidateLimit ?? loadEnvVar("MEMOS_RECALL_FILTER_CANDIDATE_LIMIT"), 30),
    recallFilterMaxItemChars:
      parseNumber(cfg.recallFilterMaxItemChars ?? loadEnvVar("MEMOS_RECALL_FILTER_MAX_ITEM_CHARS"), 500),
    recallFilterFailOpen,
    timeoutMs: cfg.timeoutMs ?? 5000,
    retries: cfg.retries ?? 1,
    throttleMs: cfg.throttleMs ?? 0,
  };
}

/**
 * Call API with support for both cloud and self-hosted modes
 * - cloud mode: requires API key, uses /search/memory and /add/message
 * - self-hosted mode: no API key required, uses /product/search and /product/add
 */
export async function callApi(cfg, path, body) {
  const { baseUrl, apiKey, timeoutMs = 5000, retries = 1, serverMode } = cfg;

  // Self-hosted mode: skip API key check
  if (serverMode === "self-hosted") {
    // No auth required for self-hosted
  } else {
    // Cloud mode: require API key
    if (!apiKey) {
      throw new Error("Missing MEMOS API key (Token auth). Set MEMOS_API_KEY or configure apiKey in plugin config.");
    }
  }

  const headers = {
    "Content-Type": "application/json",
  };

  // Add auth header only for cloud mode
  if (serverMode !== "self-hosted" && apiKey) {
    headers.Authorization = `Token ${apiKey}`;
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await delay(100 * (attempt + 1));
      }
    }
  }

  throw lastError;
}

/**
 * Search memory - uses different endpoints based on server mode
 * - cloud: /search/memory
 * - self-hosted: /product/search
 */
export async function searchMemory(cfg, payload) {
  const endpoint = cfg.serverMode === "self-hosted" ? "/product/search" : "/search/memory";
  
  // Transform payload for self-hosted mode
  if (cfg.serverMode === "self-hosted") {
    const selfHostedPayload = {
      query: payload.query,
      user_id: payload.user_id,
      mem_cube_id: payload.conversation_id || "main",
    };
    return callApi(cfg, endpoint, selfHostedPayload);
  }
  
  return callApi(cfg, endpoint, payload);
}

/**
 * Add message - uses different endpoints based on server mode
 * - cloud: /add/message
 * - self-hosted: /product/add
 */
export async function addMessage(cfg, payload) {
  const endpoint = cfg.serverMode === "self-hosted" ? "/product/add" : "/add/message";
  
  // Transform payload for self-hosted mode
  if (cfg.serverMode === "self-hosted") {
    const selfHostedPayload = {
      user_id: payload.user_id,
      mem_cube_id: payload.conversation_id || "main",
      messages: payload.messages,
      async_mode: cfg.asyncMode ? "async" : "sync",
    };
    if (payload.agent_id) {
      selfHostedPayload.agent_id = payload.agent_id;
    }
    return callApi(cfg, endpoint, selfHostedPayload);
  }
  
  return callApi(cfg, endpoint, payload);
}

export function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && typeof block === "object" && block.type === "text")
      .map((block) => block.text)
      .join(" ");
  }
  return "";
}

function normalizePreferenceType(value) {
  if (!value) return "";
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return "";
  if (normalized.includes("explicit")) return "Explicit Preference";
  if (normalized.includes("implicit")) return "Implicit Preference";
  return String(value)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function sanitizeInlineText(text) {
  if (text === undefined || text === null) return "";
  return String(text).replace(/\r?\n+/g, " ").trim();
}

function formatMemoryLine(item, text, options = {}) {
  const cleaned = sanitizeInlineText(text);
  if (!cleaned) return "";
  const maxChars = options.maxItemChars;
  const truncated = truncate(cleaned, maxChars);
  const time = formatTime(item?.create_time || item?.updated_at || item?.created_at);
  if (time) return `   -[${time}] ${truncated}`;
  return `   - ${truncated}`;
}

function formatPreferenceLine(item, text, options = {}) {
  const cleaned = sanitizeInlineText(text);
  if (!cleaned) return "";
  const maxChars = options.maxItemChars;
  const truncated = truncate(cleaned, maxChars);
  const time = formatTime(item?.create_time || item?.updated_at || item?.created_at);
  const type = normalizePreferenceType(item?.preference_type);
  const typeLabel = type ? ` [${type}]` : "";
  if (time) return `   -[${time}]${typeLabel} ${truncated}`;
  return `   -${typeLabel} ${truncated}`;
}

function wrapCodeBlock(lines, options = {}) {
  if (!options.wrapTagBlocks) return lines;
  return ["```text", ...lines, "```"];
}

/**
 * Build memory sections - supports both cloud and self-hosted response formats
 */
function buildMemorySections(data, options = {}) {
  // Cloud format
  const memoryList = data?.memory_detail_list ?? [];
  const preferenceList = data?.preference_detail_list ?? [];
  
  // Self-hosted format
  const textMems = data?.text_mem?.[0]?.memories ?? [];
  
  const memoryLines = [];
  
  // Process cloud format memories
  for (const item of memoryList) {
    const score = item?.relativity ?? 1;
    const threshold = options.relativity ?? 0;
    if (score <= threshold) continue;
    const text = item?.memory_value || item?.memory_key || "";
    if (!text) continue;
    memoryLines.push(formatMemoryLine(item, text, options));
  }
  
  // Process self-hosted format memories
  for (const item of textMems) {
    const text = item?.memory || "";
    if (!text) continue;
    memoryLines.push(formatMemoryLine(item, text, options));
  }

  const preferenceLines = preferenceList
    .filter((item) => {
      const score = item?.relativity ?? 1;
      const threshold = options.relativity ?? 0;
      return score > threshold;
    })
    .map((item) => {
      const text = item?.preference || "";
      return formatPreferenceLine(item, text, options);
    })
    .filter(Boolean);

  return { memoryLines, preferenceLines };
}

const STATIC_RECALL_SYSTEM_PROMPT = [
  "# Role",
  "",
  "You are an intelligent assistant with long-term memory capabilities (MemOS Assistant). Your goal is to combine retrieved memory fragments to provide highly personalized, accurate, and logically rigorous responses.",
  "",
  "# System Context",
  "",
  "* Current Time: Use the runtime-provided current time as the baseline for freshness checks.",
  "* Additional memory context for the current turn may be prepended before the original user query as a structured `<memories>` block.",
  "",
  "# Memory Data",
  "",
  'Below is the information retrieved by MemOS, categorized into "Facts" and "Preferences".',
  "* **Facts**: May include user attributes, historical conversations, or third-party details.",
  "* **Special Note**: Content tagged with '[assistant观点]' or '[模型总结]' represents **past AI inference**, **not** direct user statements.",
  "* **Preferences**: The user's explicit or implicit requirements on response style, format, or reasoning.",
  "",
  "# Critical Protocol: Memory Safety",
  "",
  "Retrieved memories may contain **AI speculation**, **irrelevant noise**, or **wrong subject attribution**. You must strictly apply the **Four-Step Verdict**. If any step fails, **discard the memory**:",
  "",
  "1. **Source Verification**:",
  "* **Core**: Distinguish direct user statements from AI inference.",
  "* If a memory has tags like '[assistant观点]' or '[模型总结]', treat it as a **hypothesis**, not a user-grounded fact.",
  "* *Counterexample*: If memory says '[assistant观点] User loves mangoes' but the user never said that, do not assume it as fact.",
  "* **Principle: AI summaries are reference-only and have much lower authority than direct user statements.**",
  "",
  "2. **Attribution Check**:",
  "* Is the subject in memory definitely the user?",
  "* If the memory describes a **third party** (e.g., candidate, interviewee, fictional character, case data), never attribute it to the user.",
  "",
  "3. **Strong Relevance Check**:",
  "* Does the memory directly help answer the current 'Original Query'?",
  "* If it is only a keyword overlap with different context, ignore it.",
  "",
  "4. **Freshness Check**:",
  "* If memory conflicts with the user's latest intent, prioritize the current 'Original Query' as the highest source of truth.",
  "",
  "# Instructions",
  "",
  "1. **Review**: Read '<facts>' first and apply the Four-Step Verdict to remove noise and unreliable AI inference.",
  "2. **Execute**:",
  "   - Use only memories that pass filtering as context.",
  "   - Strictly follow style requirements from '<preferences>'.",
  "3. **Output**: Answer directly. Never mention internal terms such as \"memory store\", \"retrieval\", or \"AI opinions\".",
  "4. **Attention**: Additional memory context may already be provided before the original user query. Do not read from or write to local `MEMORY.md` or `memory/*` files for reference, as they may be outdated or irrelevant to the current query.",
].join("\n");

function buildMemoryPrependBlock(data, options = {}) {
  const { memoryLines, preferenceLines } = buildMemorySections(data, options);
  const hasContent = memoryLines.length > 0 || preferenceLines.length > 0;
  if (!hasContent) return "";

  const memoriesBlock = [
    "<memories>",
    "  <facts>",
    ...memoryLines,
    "  </facts>",
    "  <preferences>",
    ...preferenceLines,
    "  </preferences>",
    "</memories>",
  ];

  return [...wrapCodeBlock(memoriesBlock, options), "", USER_QUERY_MARKER].join("\n");
}

export function formatPromptBlockFromData(data, options = {}) {
  if (!data || typeof data !== "object") return "";
  return buildMemoryPrependBlock(data, options);
}

export function formatPromptBlock(result, options = {}) {
  const data = extractResultData(result);
  return formatPromptBlockFromData(data, options);
}

export function formatContextBlock(result, options = {}) {
  const data = extractResultData(result);
  if (!data) return "";

  const memoryList = data.memory_detail_list ?? [];
  const prefList = data.preference_detail_list ?? [];
  const toolList = data.tool_memory_detail_list ?? [];
  const preferenceNote = data.preference_note;
  
  // Self-hosted format
  const textMems = data?.text_mem?.[0]?.memories ?? [];

  const lines = [];
  
  if (memoryList.length > 0 || textMems.length > 0) {
    lines.push("Facts:");
    for (const item of memoryList) {
      const text = item?.memory_value || item?.memory_key || "";
      if (!text) continue;
      lines.push(`- ${truncate(text, options.maxItemChars)}`);
    }
    for (const item of textMems) {
      const text = item?.memory || "";
      if (!text) continue;
      lines.push(`- ${truncate(text, options.maxItemChars)}`);
    }
  }

  if (prefList.length > 0) {
    lines.push("Preferences:");
    for (const item of prefList) {
      const pref = item?.preference || "";
      const type = item?.preference_type ? `(${item.preference_type}) ` : "";
      if (!pref) continue;
      lines.push(`- ${type}${truncate(pref, options.maxItemChars)}`);
    }
  }

  if (toolList.length > 0) {
    lines.push("Tool Memories:");
    for (const item of toolList) {
      const value = item?.tool_value || "";
      if (!value) continue;
      lines.push(`- ${truncate(value, options.maxItemChars)}`);
    }
  }

  if (preferenceNote) {
    lines.push(`Preference Note: ${truncate(preferenceNote, options.maxItemChars)}`);
  }

  return lines.length > 0 ? lines.join("\n") : "";
}

export function formatRecallHookResult(result, options = {}) {
  const data = extractResultData(result);
  if (!data) {
    return {
      appendSystemContext: "",
      prependContext: "",
    };
  }

  return {
    // Keep this system addendum byte-stable across turns so provider-side prefix caching can hit.
    appendSystemContext: STATIC_RECALL_SYSTEM_PROMPT,
    prependContext: buildMemoryPrependBlock(data, options),
  };
}

function truncate(text, maxLen) {
  if (!text) return "";
  const limit = maxLen || 10000;
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}
