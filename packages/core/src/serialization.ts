import type { JsonValue } from './types.js'

export const stringifyTagSafeJson = (value: JsonValue): string => (
  (JSON.stringify(value) ?? 'null').replace(/</g, '\\u003c')
)

export const unicodeLength = (value: string): number => Array.from(value).length

export const truncateUnicode = (value: string, maxChars: number): string => {
  if (maxChars <= 0) return ''
  const characters = Array.from(value)
  if (characters.length <= maxChars) return value
  return characters.slice(0, maxChars).join('')
}
