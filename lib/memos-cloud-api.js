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

function extractResultData(result) {
  if (!result || typeof result !== "object") return null;
  return result.data ?? result.data?.data ?? result.data?.result ?? null;
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
  const maxChars = options.maxItemChars ?? 200;
  const truncated = truncate(cleaned, maxChars);
  const time = formatTime(item?.create_time);
  if (time) return `   -[${time}] ${truncated}`;
  return `   - ${truncated}`;
}

function formatPreferenceLine(item, text, options = {}) {
  const cleaned = sanitizeInlineText(text);
  if (!cleaned) return "";
  const maxChars = options.maxItemChars ?? 200;
  const truncated = truncate(cleaned, maxChars);
  const time = formatTime(item?.create_time);
  const type = normalizePreferenceType(item?.preference_type);
  const typeLabel = type ? ` [${type}]` : "";
  if (time) return `   -[${time}]${typeLabel} ${truncated}`;
  return `   -${typeLabel} ${truncated}`;
}

function formatSkillBlock(skillList) {
  const lines = ["<skills>"];
  if (Array.isArray(skillList) && skillList.length > 0) {
    for (const skill of skillList) {
      const id = skill?.id ?? "";
      const name = skill?.name ?? "";
      const idAttr = id ? ` id="${String(id).replace(/"/g, "&quot;")}"` : "";
      const nameAttr = name ? ` name="${String(name).replace(/"/g, "&quot;")}"` : "";
      lines.push(`  <skill${idAttr}${nameAttr}>`);

      const metaParts = [];
      if (skill?.status) metaParts.push(`Status: ${skill.status}`);
      if (skill?.confidence !== undefined) metaParts.push(`Confidence: ${skill.confidence}`);
      if (skill?.relativity !== undefined) metaParts.push(`Relativity: ${skill.relativity}`);
      if (metaParts.length > 0) lines.push(`    <meta>${metaParts.join(" | ")}</meta>`);

      if (skill?.description) lines.push(`    <description>${skill.description}</description>`);

      if (skill?.procedure) {
        lines.push("    <procedure>");
        if (Array.isArray(skill.procedure)) {
          skill.procedure.forEach((step, idx) => {
            if (!step) return;
            lines.push(`      Step ${idx + 1}: ${step}`);
          });
        } else {
          String(skill.procedure)
            .split(/\r?\n/)
            .filter((line) => line.trim())
            .forEach((line) => {
              lines.push(`      ${line}`);
            });
        }
        lines.push("    </procedure>");
      }

      if (skill?.guidance) {
        lines.push("    <guidance>");
        if (Array.isArray(skill.guidance)) {
          skill.guidance.forEach((line) => {
            if (!line) return;
            lines.push(`      - ${line}`);
          });
        } else {
          String(skill.guidance)
            .split(/\r?\n/)
            .filter((line) => line.trim())
            .forEach((line) => {
              lines.push(`      - ${line.trim()}`);
            });
        }
        lines.push("    </guidance>");
      }

      if (skill?.example) lines.push(`    <example>${skill.example}</example>`);
      lines.push("  </skill>");
    }
  }
  lines.push("</skills>");
  return lines;
}

function buildPromptFromData(data, options = {}) {
  const now = options.currentTime ?? Date.now();
  const nowText = formatTime(now) || formatTime(Date.now()) || "";
  const memoryList = data?.memory_detail_list ?? [];
  const preferenceList = data?.preference_detail_list ?? [];

  const memoryLines = memoryList
    .map((item) => {
      const text = item?.memory_value || item?.memory_key || "";
      return formatMemoryLine(item, text, options);
    })
    .filter(Boolean);

  const preferenceLines = preferenceList
    .map((item) => {
      const text = item?.preference || "";
      return formatPreferenceLine(item, text, options);
    })
    .filter(Boolean);

  const skillList = data?.skill_detail_list ?? [];
  const skillLines = formatSkillBlock(skillList);
  const preferenceNote = typeof data?.preference_note === "string" ? data.preference_note.trim() : "";
  const hasContent =
    memoryLines.length > 0 ||
    preferenceLines.length > 0 ||
    (Array.isArray(skillList) && skillList.length > 0);

  if (!hasContent) return "";

  const lines = [
    "# Role",
    "",
    "You are an intelligent assistant powered by MemOS. Your goal is to provide personalized and accurate responses by leveraging retrieved memory fragments and specialized skills, while strictly avoiding hallucinations caused by past AI inferences.",
    "",
    "# System Context",
    "",
    `* Current Time: ${nowText} (Baseline for freshness)`,
    "",
    "# Memory Data",
    "",
    'Below is the information retrieved by MemOS, categorized into "Facts" and "Preferences".',
    "",
    "* **Facts**: May contain user attributes, historical logs, or third-party details.",
    "* **Warning**: Content tagged with '[assistant观点]' or '[summary]' represents **past AI inferences**, NOT direct user quotes.",
    "* **Preferences**: Explicit or implicit user requirements regarding response style and format.",
    "",
    "<memories>",
    "  <facts>",
    ...memoryLines,
    "  </facts>",
    "  <preferences>",
    ...preferenceLines,
    "  </preferences>",
    "</memories>",
    "",
    "# Skill Data",
    "",
    'Below are the specialized skills ("Procedural Memories") retrieved for the current context. These represent tasks the user has established patterns for.',
    "",
    "* Status: Only 'activated' skills should be considered.",
    "* **Skills may be returned as a list and are NOT guaranteed to be useful for the current query. You must actively filter them.**",
    "",
    ...skillLines,
    "",
    "# Critical Protocol: Memory Safety",
    "",
    "You must strictly execute the following **\"Four-Step Verdict\"**. If a memory fails any step, **DISCARD IT**:",
    "",
    "1. **Source Verification (CRITICAL)**:",
    "",
    "* Distinguish between \"User's Input\" and \"AI's Inference\".",
    "* If a memory is tagged as '[assistant观点]' or '[summary]', treat it as a **hypothesis**, not a hard fact.",
    "* Principle: AI summaries have much lower authority than direct user statements.",
    "",
    "2. **Attribution Check**:",
    "",
    "* Is the \"Subject\" of the memory definitely the User?",
    "* If it describes a **Third Party**, NEVER attribute these traits to the User.",
    "",
    "3. **Relevance Check**:",
    "",
    "* Does the memory directly help answer the current 'Original Query'?",
    "* If it is merely a keyword match with different context, IGNORE IT.",
    "",
    "4. **Freshness Check**:",
    "",
    "* The current 'Original Query' is always the supreme Source of Truth.",
    "",
    "# Critical Protocol: Skill Execution",
    "",
    "When Skills are present, you must adhere to the following execution rules:",
    "",
    "1. **Applicability First (Mandatory Filtering)**:",
    "",
    "* **Treat every skill as \"optional\". Do NOT assume it should be used.**",
    "* **For each skill, decide whether it materially helps solve the current query (correctness / usefulness / personalization).**",
    "* **If a skill does not help this query, ignore it completely.**",
    "* **If no skills are applicable, proceed without any skill.**",
    "",
    "2. **Workflow Composition (Skill as a Skeleton)**:",
    "",
    "* Follow the steps defined in `<procedure>` sequentially.",
    "* Do not skip steps unless the user has already provided that information in the current turn.",
    "* **Skills are distilled from the user's past interactions. When you choose to use a skill, treat its `<procedure>` as a workflow skeleton that should be combined with:**",
    "",
    "  * **(a) validated user preferences in `<preferences>`**",
    "  * **(b) validated relevant facts in `<facts>`**",
    "  * **(c) constraints from the user's current query**",
    "* **You may omit unnecessary steps that are already satisfied, but keep the internal order of the remaining steps.**",
    "* **If multiple skills are applicable, merge them modularly: preserve each skill’s internal step order, remove duplicate steps, and produce one coherent flow.**",
    "",
    "3. **Personalization (Grounded)**:",
    "",
    "* Apply `<guidance>` to customize your response.",
    "* **Also leverage the skill’s `<example>` as a signal of what the user tends to care about and how they tend to decide—BUT only when it does not conflict with the current query and passes Memory Safety.**",
    "* **Do not invent new preferences. Any personalization must be grounded in validated memories or the current user input.**",
    "* **Goal: make the result align with the user's habitual decision style, not a generic answer.**",
    "",
    "4. **Conflict Resolution**:",
    "",
    "* If a Skill's instruction conflicts with explicit `<preferences>` in the Memory Data section, the Memory Data takes precedence.",
    "* **If skills conflict with each other, prioritize the one that best matches the current query goal and explicit user preferences; otherwise, drop the conflicting part and proceed without skill for that segment.**",
    "",
    "# Instructions",
    "",
    "1. **Filter**: Apply the \"Four-Step Verdict\" to all '<facts>' to filter out noise.",
    "2. **Match**: **From the returned skill list, perform applicability filtering; ignore any skill that does not help the current query.**",
    "3. **Synthesize**: **If one or more skills are applicable, combine their necessary `<procedure>` steps with validated user preferences and the current query constraints to produce an output that fits the user's habitual workflow.**",
    "4. **Style**: Strictly adhere to '<preferences>'.",
    "5. **Output**: Answer directly. NEVER mention \"retrieved memories,\" \"skills,\" \"database,\" or \"AI views\" in your response.",
  ];

  if (preferenceNote) {
    lines.push("");
    preferenceNote.split(/\r?\n/).forEach((line) => {
      lines.push(line);
    });
  }

  return lines.join("\n");
}

export function formatContextBlock(result, options = {}) {
  const data = extractResultData(result);
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

export function formatPromptBlock(result, options = {}) {
  const data = extractResultData(result);
  if (!data) return "";
  return buildPromptFromData(data, options);
}

function truncate(text, maxLen) {
  if (!text) return "";
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}
