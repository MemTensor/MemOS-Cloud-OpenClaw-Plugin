import { MemosClientError } from './memos-errors.js'
import type { BaseResponse, MemosAddData, MemosSearchData } from './types.js'

const SUCCESS_CODES = new Set<unknown>([0, '0', 200, '200'])

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
)

const sanitizedMessage = (value: unknown, apiKey: string): string | undefined => {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const withoutControls = value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160)
  return withoutControls.split(apiKey).join('[redacted]')
}

const parseBody = async (response: Response): Promise<unknown> => {
  const body = await response.text()
  try {
    return JSON.parse(body) as unknown
  } catch (cause) {
    throw new MemosClientError('MemOS returned invalid JSON', { kind: 'response', cause })
  }
}

const validateEnvelope = <T>(
  value: unknown,
  apiKey: string,
  validateData: (data: unknown) => data is T,
): T => {
  if (!isRecord(value)) {
    throw new MemosClientError('MemOS returned an invalid response envelope', { kind: 'response' })
  }
  if (!SUCCESS_CODES.has(value.code)) {
    const detail = sanitizedMessage(value.message, apiKey)
    throw new MemosClientError(
      `MemOS rejected the request${detail === undefined ? '' : `: ${detail}`}`,
      { kind: 'business' },
    )
  }
  if (!validateData(value.data)) {
    throw new MemosClientError('MemOS returned an invalid data shape', { kind: 'response' })
  }
  return value.data
}

const isRecordArray = (value: unknown): boolean => (
  Array.isArray(value) && value.every(isRecord)
)

const isSearchData = (value: unknown): value is MemosSearchData => {
  if (!isRecord(value)) return false
  for (const key of [
    'memory_detail_list',
    'preference_detail_list',
    'tool_memory_detail_list',
  ]) {
    if (value[key] !== undefined && !isRecordArray(value[key])) return false
  }
  if (value.preference_note !== undefined && typeof value.preference_note !== 'string') return false
  return true
}

const isAddData = (value: unknown): value is MemosAddData => {
  if (!isRecord(value)) return false
  if (value.success !== undefined && typeof value.success !== 'boolean') return false
  if (value.task_id !== undefined && typeof value.task_id !== 'string') return false
  if (value.status !== undefined && typeof value.status !== 'string') return false
  return true
}

const httpError = async (response: Response, apiKey: string): Promise<never> => {
  let detail: string | undefined
  try {
    const value = await parseBody(response)
    if (isRecord(value)) detail = sanitizedMessage(value.message, apiKey)
  } catch {
    // The HTTP status is sufficient when the error body is not JSON.
  }
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500
  throw new MemosClientError(
    `MemOS HTTP ${response.status}${detail === undefined ? '' : `: ${detail}`}`,
    { kind: 'http', status: response.status, retryable },
  )
}

export const parseSearchResponse = async (response: Response, apiKey: string): Promise<MemosSearchData> => {
  if (!response.ok) return httpError(response, apiKey)
  const envelope = await parseBody(response) as BaseResponse<unknown>
  return validateEnvelope(envelope, apiKey, isSearchData)
}

export const parseAddResponse = async (response: Response, apiKey: string): Promise<MemosAddData> => {
  if (!response.ok) return httpError(response, apiKey)
  const envelope = await parseBody(response) as BaseResponse<unknown>
  return validateEnvelope(envelope, apiKey, isAddData)
}
