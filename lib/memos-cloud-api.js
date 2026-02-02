import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_BASE_URL = "https://memos.memtensor.cn/api/openmem/v1";
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
  return process.env[name];
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

export function buildConfig(pluginConfig = {}) {
  const cfg = pluginConfig ?? {};

  const baseUrl = cfg.baseUrl || loadEnvVar("MEMOS_BASE_URL") || DEFAULT_BASE_URL;
  const apiKey = cfg.apiKey || loadEnvVar("MEMOS_API_KEY") || "";
  const userId = cfg.userId || loadEnvVar("MEMOS_USER_ID") || "openclaw-user";
  const conversationId = cfg.conversationId || loadEnvVar("MEMOS_CONVERSATION_ID") || "";

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
    maxQueryChars: cfg.maxQueryChars ?? 2000,
    recallEnabled: cfg.recallEnabled !== false,
    addEnabled: cfg.addEnabled !== false,
    captureStrategy: cfg.captureStrategy ?? "last_turn",
    maxMessageChars: cfg.maxMessageChars ?? 2000,
    includeAssistant: cfg.includeAssistant !== false,
    memoryLimitNumber: cfg.memoryLimitNumber ?? 6,
    preferenceLimitNumber: cfg.preferenceLimitNumber ?? 6,
    includePreference: cfg.includePreference !== false,
    includeToolMemory: cfg.includeToolMemory === true,
    toolMemoryLimitNumber: cfg.toolMemoryLimitNumber ?? 6,
    filter: cfg.filter,
    knowledgebaseIds: cfg.knowledgebaseIds ?? [],
    tags: cfg.tags ?? ["openclaw"],
    info: cfg.info ?? {},
    agentId: cfg.agentId,
    appId: cfg.appId,
    allowPublic: cfg.allowPublic ?? false,
    allowKnowledgebaseIds: cfg.allowKnowledgebaseIds ?? [],
    asyncMode: cfg.asyncMode ?? true,
    timeoutMs: cfg.timeoutMs ?? 5000,
    retries: cfg.retries ?? 1,
    throttleMs: cfg.throttleMs ?? 0,
  };
}

export async function callApi({ baseUrl, apiKey, timeoutMs = 5000, retries = 1 }, path, body) {
  if (!apiKey) {
    throw new Error("Missing MEMOS API key (Token auth)");
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Token ${apiKey}`,
  };

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

export async function searchMemory(cfg, payload) {
  return callApi(cfg, "/search/memory", payload);
}

export async function addMessage(cfg, payload) {
  return callApi(cfg, "/add/message", payload);
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

export function formatContextBlock(result, options = {}) {
  const data = result?.data ?? result?.data?.data ?? result?.data?.result ?? null;
  if (!data) return "";

  const memoryList = data.memory_detail_list ?? [];
  const prefList = data.preference_detail_list ?? [];
  const toolList = data.tool_memory_detail_list ?? [];
  const preferenceNote = data.preference_note;

  const lines = [];
  if (memoryList.length > 0) {
    lines.push("Facts:");
    for (const item of memoryList) {
      const text = item?.memory_value || item?.memory_key || "";
      if (!text) continue;
      lines.push(`- ${truncate(text, options.maxItemChars ?? 200)}`);
    }
  }

  if (prefList.length > 0) {
    lines.push("Preferences:");
    for (const item of prefList) {
      const pref = item?.preference || "";
      const type = item?.preference_type ? `(${item.preference_type}) ` : "";
      if (!pref) continue;
      lines.push(`- ${type}${truncate(pref, options.maxItemChars ?? 200)}`);
    }
  }

  if (toolList.length > 0) {
    lines.push("Tool Memories:");
    for (const item of toolList) {
      const value = item?.tool_value || "";
      if (!value) continue;
      lines.push(`- ${truncate(value, options.maxItemChars ?? 200)}`);
    }
  }

  if (preferenceNote) {
    lines.push(`Preference Note: ${truncate(preferenceNote, options.maxItemChars ?? 200)}`);
  }

  return lines.length > 0 ? lines.join("\n") : "";
}

function truncate(text, maxLen) {
  if (!text) return "";
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}
