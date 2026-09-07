export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]

export interface JsonObject {
  [key: string]: JsonValue
}

// The public /add/message contract declares info as Map<String, String>.
// Keeping this narrow prevents Jackson coercion failures at the API boundary.
export type MemosInfo = Record<string, string>

export interface MemosToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface MemosTextContentBlock {
  type: 'text'
  text: string
}

interface MemosMessageMetadata {
  id?: string
  chat_time?: string
}

export interface MemosUserMessage extends MemosMessageMetadata {
  role: 'user'
  content: string
}

export interface MemosAssistantMessage extends MemosMessageMetadata {
  role: 'assistant'
  content?: string
  tool_calls?: MemosToolCall[]
}

export interface MemosToolMessage extends MemosMessageMetadata {
  role: 'tool'
  tool_call_id: string
  content: MemosTextContentBlock[]
}

export type MemosMessage = MemosUserMessage | MemosAssistantMessage | MemosToolMessage

export interface MemosSearchRequest {
  user_id: string
  query: string
  conversation_id?: string
  source: string
  memory_limit_number: number
  include_preference: boolean
  preference_limit_number: number
  include_tool_memory: boolean
  tool_memory_limit_number: number
  relativity: number
  filter?: JsonObject
  knowledgebase_ids?: string[]
}

export interface MemosAddRequest {
  user_id: string
  conversation_id: string
  messages: MemosMessage[]
  source: string
  async_mode: boolean
  allow_public: boolean
  tags?: string[]
  info?: MemosInfo
  agent_id?: string
  app_id?: string
  allow_knowledgebase_ids?: string[]
}

export interface MemosMemoryDetail {
  id?: string
  memory_key?: string
  memory_value?: string
  memory_type?: string
  create_time?: number | string
  update_time?: number | string
  relativity?: number
  tags?: string[]
  [key: string]: JsonValue | undefined
}

export interface MemosPreferenceDetail {
  id?: string
  memory_value?: string
  preference?: string
  preference_type?: string
  reasoning?: string
  create_time?: number | string
  update_time?: number | string
  relativity?: number
  [key: string]: JsonValue | undefined
}

export interface MemosToolMemoryDetail {
  id?: string
  tool_type?: string
  tool_value?: string
  experience?: string
  create_time?: number | string
  update_time?: number | string
  relativity?: number
  [key: string]: JsonValue | undefined
}

export interface MemosSearchData {
  memory_detail_list?: MemosMemoryDetail[]
  preference_detail_list?: MemosPreferenceDetail[]
  tool_memory_detail_list?: MemosToolMemoryDetail[]
  preference_note?: string
}

export interface MemosAddData {
  success?: boolean
  task_id?: string
  status?: string
}

export interface BaseResponse<T> {
  code: number | string
  data?: T
  message?: string
}
