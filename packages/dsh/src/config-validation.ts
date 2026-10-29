import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type { JsonObject, JsonValue, MemosInfo } from '@memtensor/memos-cloud-plugin-core'

export const optionalString = (value: string | undefined, trim = true): string | undefined => {
  if (value === undefined || value.trim().length === 0) return undefined
  return trim ? value.trim() : value
}

export const integerInRange = (name: string, value: number, min: number, max: number): number => {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

export const numberInRange = (name: string, value: number, min: number, max: number): number => {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`${name} must be between ${min} and ${max}`)
  }
  return value
}

export const nonBlankList = (
  name: string,
  value: string[] | undefined,
  fallback: string[] = [],
): string[] => {
  const result = value ?? fallback
  if (result.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    throw new TypeError(`${name} cannot contain a blank entry`)
  }
  return result.map((entry) => entry.trim())
}

const assertJsonValue: (value: unknown, path: string) => asserts value is JsonValue = (value, path) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain finite numbers`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`))
    return
  }
  if (typeof value !== 'object') throw new TypeError(`${path} must be JSON-safe`)
  for (const [key, entry] of Object.entries(value)) assertJsonValue(entry, `${path}.${key}`)
}

export const normalizeFilterObject = (filter: JsonObject | undefined): JsonObject | undefined => {
  if (filter === undefined) return undefined
  if (filter === null || Array.isArray(filter) || typeof filter !== 'object') {
    throw new TypeError('filter must be a JSON object')
  }
  assertJsonValue(filter, 'filter')
  return filter
}

export const normalizeInfo = (info: MemosInfo | undefined): MemosInfo => {
  if (info === undefined) return {}
  const result: MemosInfo = {}
  for (const [key, value] of Object.entries(info)) {
    if (key.trim().length === 0) throw new TypeError('info keys cannot be blank')
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new TypeError(`info.${key} must be a non-blank string`)
    }
    result[key] = value.trim()
  }
  return result
}

export const environmentValue = (
  environment: Pick<LaunchEnvironmentSnapshot, 'get'> | undefined,
  name: string,
): string | undefined => optionalString(environment?.get(name)?.value)

export const nonBlankSecret = (value: string | undefined): string | undefined => {
  if (value === undefined || value.trim().length === 0) return undefined
  return value
}
