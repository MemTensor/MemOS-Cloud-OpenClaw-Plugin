import type { JsonObject, JsonValue } from './types.js'

const SOURCE_KEYS = new Set(['user', 'public', 'knowledgebase'])
const SUPPORTED_OPERATORS = new Set(['contains', 'gt', 'gte', 'lt', 'lte', 'in', 'like'])
const RANGE_OPERATORS = new Set(['gt', 'gte', 'lt', 'lte'])
const FIELD_PATTERN = /^[a-zA-Z0-9_]+$/
const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/

const fail: (message: string) => never = (message) => {
  throw new TypeError(message)
}

const isPlainObject = (value: unknown): value is JsonObject => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const validateKnowledgebaseIds = (ids: readonly string[] | undefined): void => {
  if (ids === undefined) return
  if (ids.some((id) => typeof id !== 'string' || id.trim().length === 0)) {
    fail('knowledgebaseIds cannot contain a blank ID')
  }
  if (ids.includes('all') && ids.length !== 1) {
    fail("knowledgebaseIds value 'all' cannot be combined with concrete IDs")
  }
}

const validateFieldName = (field: string): void => {
  if (!FIELD_PATTERN.test(field)) fail(`invalid filter field '${field}'`)
  const lower = field.toLowerCase()
  if (lower.includes('time') && lower !== 'create_time' && lower !== 'update_time') {
    fail(`time field '${field}' is not allowed; use create_time or update_time`)
  }
}

const validateDateTime = (value: string, field: string, operator: string): void => {
  const match = DATE_TIME_PATTERN.exec(value)
  if (match === null) fail(`${field}.${operator} must use a valid date or date-time`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4] ?? 0)
  const minute = Number(match[5] ?? 0)
  const second = Number(match[6] ?? 0)
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day || parsed.getUTCHours() !== hour
    || parsed.getUTCMinutes() !== minute || parsed.getUTCSeconds() !== second) {
    fail(`${field}.${operator} has an invalid date`)
  }
}

const validateSimpleValue = (field: string, value: JsonValue): void => {
  if (value === null) fail(`filter field '${field}' cannot be null`)
  if (typeof value === 'string') {
    if (value.trim().length === 0) fail(`filter field '${field}' cannot be blank`)
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`filter field '${field}' must be finite`)
    return
  }
  if (typeof value === 'boolean') return
  fail(`filter field '${field}' must have a scalar value`)
}

const validateOperatorValue = (field: string, operator: string, value: JsonValue): void => {
  if (operator === 'contains' || operator === 'like') {
    if (typeof value !== 'string') fail(`${field}.${operator} must be a string`)
    if (value.trim().length === 0) fail(`${field}.${operator} cannot be blank`)
    return
  }
  if (operator === 'in') {
    if (!Array.isArray(value)) fail(`${field}.in must be a string array`)
    if (value.length === 0) fail(`${field}.in cannot be empty`)
    if (value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
      fail(`${field}.in entries must be non-blank strings`)
    }
    return
  }
  if (RANGE_OPERATORS.has(operator)) {
    if (typeof value !== 'string') fail(`${field}.${operator} must be a date string`)
    validateDateTime(value, field, operator)
  }
}

const validateOperatorObject = (field: string, value: JsonObject): void => {
  const entries = Object.entries(value)
  if (entries.length === 0) fail(`operator object for '${field}' cannot be empty`)
  for (const [operator, operand] of entries) {
    if (!SUPPORTED_OPERATORS.has(operator)) fail(`unsupported operator '${operator}' for '${field}'`)
    validateOperatorValue(field, operator, operand)
  }
}

const validateCondition = (value: unknown): void => {
  if (!isPlainObject(value)) fail('logical filter conditions must be objects')
  const entries = Object.entries(value)
  if (entries.length !== 1) fail('logical filter condition must contain exactly one field')
  const entry = entries[0]
  if (entry === undefined) fail('logical filter condition must contain one field')
  const [field, operand] = entry
  validateFieldName(field)
  if (isPlainObject(operand)) {
    validateOperatorObject(field, operand)
    return
  }
  validateSimpleValue(field, operand)
}

const validateRegularFilter = (filter: JsonObject): void => {
  const entries = Object.entries(filter)
  if (entries.length === 0) fail('filter object cannot be empty')
  const hasAnd = Object.hasOwn(filter, 'and')
  const hasOr = Object.hasOwn(filter, 'or')
  if (hasAnd || hasOr) {
    if (entries.length !== 1) fail("logical filter cannot contain any other key")
    const conditions = filter[hasAnd ? 'and' : 'or']
    if (!Array.isArray(conditions)) fail('logical filter value must be an array')
    if (conditions.length === 0) fail('logical filter array cannot be empty')
    conditions.forEach(validateCondition)
    return
  }
  for (const [field, value] of entries) {
    validateFieldName(field)
    if (isPlainObject(value)) fail(`simple filter field '${field}' cannot use an operator object`)
    validateSimpleValue(field, value)
  }
}

export const isPerSourceFilter = (value: JsonObject): boolean => {
  const keys = Object.keys(value)
  return keys.length > 0 && keys.every((key) => SOURCE_KEYS.has(key))
}

export function validateFilter(
  value: unknown,
  knowledgebaseIds?: readonly string[],
): asserts value is JsonObject | undefined {
  validateKnowledgebaseIds(knowledgebaseIds)
  if (value === undefined) return
  if (!isPlainObject(value)) fail('filter must be a plain object')
  const keys = Object.keys(value)
  if (keys.length === 0) fail('filter object cannot be empty')
  const sourceCount = keys.filter((key) => SOURCE_KEYS.has(key)).length
  if (sourceCount > 0 && sourceCount !== keys.length) fail('filter cannot mix source and regular keys')
  if (!isPerSourceFilter(value)) {
    validateRegularFilter(value)
    return
  }
  for (const [source, branch] of Object.entries(value)) {
    if (!isPlainObject(branch)) fail(`filter.${source} must be a plain object`)
    validateRegularFilter(branch)
  }
  if (Object.hasOwn(value, 'knowledgebase') && (knowledgebaseIds?.length ?? 0) === 0) {
    fail('knowledgebaseIds is required when filter.knowledgebase is configured')
  }
}

export const buildEffectiveFilter = (
  filter: JsonObject | undefined,
  agentId: string | undefined,
): JsonObject | undefined => {
  const cloned = filter === undefined ? undefined : structuredClone(filter)
  const agent = agentId?.trim()
  if (cloned === undefined) return agent === undefined ? undefined : { user: { agent_id: agent } }
  if (!isPerSourceFilter(cloned)) return {
    user: agent === undefined ? cloned : mergeAgentIntoBranch(cloned, agent, 'filter'),
  }
  if (agent === undefined) return cloned
  const currentUser = cloned.user
  cloned.user = currentUser === undefined
    ? { agent_id: agent }
    : mergeAgentIntoBranch(currentUser as JsonObject, agent, 'filter.user')
  return cloned
}

const mergeAgentIntoBranch = (
  branch: JsonObject,
  agent: string,
  path: 'filter' | 'filter.user',
): JsonObject => {
  if (Object.hasOwn(branch, 'or')) {
    fail(path === 'filter'
      ? 'agentId cannot be combined with an or filter'
      : 'agentId cannot be combined with filter.user.or')
  }
  if (Object.hasOwn(branch, 'and')) {
    const conditions = branch.and
    if (!Array.isArray(conditions)) fail(`${path}.and must be an array`)
    const explicitAgent = conditions.find((condition) => (
      isPlainObject(condition) && Object.hasOwn(condition, 'agent_id')
    )) as JsonObject | undefined
    if (explicitAgent !== undefined) {
      if (explicitAgent.agent_id !== agent) {
        fail(`${path}.agent_id conflicts with configured agentId`)
      }
      return { and: [...conditions] }
    }
    return { and: [...conditions, { agent_id: agent }] }
  }
  const existing = branch.agent_id
  if (existing !== undefined && existing !== agent) {
    fail(`${path}.agent_id conflicts with configured agentId`)
  }
  return { ...branch, agent_id: agent }
}
