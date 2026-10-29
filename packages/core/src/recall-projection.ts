import { truncateUnicode, unicodeLength } from './serialization.js'
import type { MemosMemoryDetail, MemosPreferenceDetail, MemosSearchData, MemosToolMemoryDetail } from './types.js'

export interface RecallLimits {
  maxItemChars: number
  maxTotalChars: number
}

export interface RecallFact {
  text: string
  id?: string
  createdAt?: number | string
  updatedAt?: number | string
  relativity?: number
}

export interface RecallPreference {
  text: string
  id?: string
  type?: string
  createdAt?: number | string
  updatedAt?: number | string
  relativity?: number
}

export interface RecallSupplement {
  text: string
  id?: string
  type?: string
  createdAt?: number | string
  updatedAt?: number | string
  relativity?: number
}

export interface RecallProjection {
  facts: RecallFact[]
  preferences: RecallPreference[]
  tools?: RecallSupplement[]
}

const nonBlank = (value: string | undefined): string | undefined => {
  if (value === undefined || value.trim().length === 0) return undefined
  return value.trim()
}

const safeTime = (value: number | string | undefined): number | string | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  return nonBlank(value)
}

const factMetadata = (detail: MemosMemoryDetail): Omit<RecallFact, 'text'> => {
  const id = nonBlank(detail.id)
  const createdAt = safeTime(detail.create_time)
  const updatedAt = safeTime(detail.update_time)
  const relativity = Number.isFinite(detail.relativity) ? detail.relativity : undefined
  return {
    ...(id === undefined ? {} : { id }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(relativity === undefined ? {} : { relativity }),
  }
}

const preferenceMetadata = (detail: MemosPreferenceDetail): Omit<RecallPreference, 'text'> => {
  const id = nonBlank(detail.id)
  const type = nonBlank(detail.preference_type)
  const createdAt = safeTime(detail.create_time)
  const updatedAt = safeTime(detail.update_time)
  const relativity = Number.isFinite(detail.relativity) ? detail.relativity : undefined
  return {
    ...(id === undefined ? {} : { id }),
    ...(type === undefined ? {} : { type }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(relativity === undefined ? {} : { relativity }),
  }
}

const supplementMetadata = (
  detail: MemosToolMemoryDetail,
  typeValue?: string,
  createdValue?: number | string,
  updatedValue?: number | string,
): Omit<RecallSupplement, 'text'> => {
  const id = nonBlank(detail.id)
  const type = nonBlank(typeValue)
  const createdAt = safeTime(createdValue)
  const updatedAt = safeTime(updatedValue)
  const numericRelativity = typeof detail.relativity === 'number' ? detail.relativity : undefined
  const relativity = Number.isFinite(numericRelativity) ? numericRelativity : undefined
  return {
    ...(id === undefined ? {} : { id }),
    ...(type === undefined ? {} : { type }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(relativity === undefined ? {} : { relativity }),
  }
}

export const projectRecall = (
  data: MemosSearchData,
  limits: RecallLimits,
): RecallProjection | undefined => {
  const facts: RecallFact[] = []
  const preferences: RecallPreference[] = []
  const tools: RecallSupplement[] = []
  let remaining = Math.max(0, limits.maxTotalChars)

  const takeText = (value: string | undefined): string | undefined => {
    const text = nonBlank(value)
    if (text === undefined || remaining === 0) return undefined
    const bounded = truncateUnicode(text, Math.min(limits.maxItemChars, remaining))
    if (bounded.length === 0) return undefined
    remaining -= unicodeLength(bounded)
    return bounded
  }

  for (const detail of data.memory_detail_list ?? []) {
    const text = takeText(nonBlank(detail.memory_value) ?? detail.memory_key)
    if (text !== undefined) facts.push({ text, ...factMetadata(detail) })
  }
  for (const detail of data.preference_detail_list ?? []) {
    const text = takeText(detail.preference)
    if (text !== undefined) preferences.push({ text, ...preferenceMetadata(detail) })
  }
  for (const detail of data.tool_memory_detail_list ?? []) {
    const text = takeText(nonBlank(detail.tool_value) ?? detail.experience)
    if (text !== undefined) tools.push({
      text,
      ...supplementMetadata(detail, detail.tool_type, detail.create_time, detail.update_time),
    })
  }
  if ([facts, preferences, tools].every((items) => items.length === 0)) {
    return undefined
  }
  return {
    facts,
    preferences,
    ...(tools.length === 0 ? {} : { tools }),
  }
}
