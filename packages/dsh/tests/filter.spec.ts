import { describe, expect, it } from 'vitest'
import {
  buildEffectiveFilter,
  isPerSourceFilter,
  validateFilter,
} from '@memtensor/memos-cloud-plugin-core'
import type { JsonObject } from '@memtensor/memos-cloud-plugin-core'

describe('validateFilter', () => {
  it.each([
    [{ app_id: 'dsh' }, undefined],
    [{ and: [{ tags: { contains: 'project-a' } }] }, undefined],
    [{ or: [{ create_time: { gte: '2026-08-01' } }] }, undefined],
    [{ and: [{ update_time: { lt: '2026-08-14 23:59:59' } }] }, undefined],
    [{ user: { tags: 'project-a' }, public: { locale: 'zh' } }, undefined],
    [{ knowledgebase: { doc_type: 'api' } }, ['kb_1']],
    [{ knowledgebase: { doc_type: 'api' } }, ['all']],
    [{ score: true, version: 3 }, undefined],
    [{ and: [{ tags: { in: ['a', 'b'] } }, { title: { like: 'memo%' } }] }, undefined],
  ] as const)('accepts filter %j', (filter, ids) => {
    expect(() => validateFilter(filter, ids)).not.toThrow()
  })

  it.each([
    [null, undefined, 'object'],
    [[], undefined, 'object'],
    [{}, undefined, 'empty'],
    [{ user: { tags: 'a' }, app_id: 'dsh' }, undefined, 'mix'],
    [{ and: [], or: [] }, undefined, 'other key'],
    [{ and: [], app_id: 'dsh' }, undefined, 'other key'],
    [{ and: [] }, undefined, 'empty'],
    [{ and: [{}] }, undefined, 'one field'],
    [{ and: [{ a: 1, b: 2 }] }, undefined, 'one field'],
    [{ 'bad-field': 'x' }, undefined, 'field'],
    [{ ' ': 'x' }, undefined, 'field'],
    [{ app_id: null }, undefined, 'null'],
    [{ app_id: ['dsh'] }, undefined, 'scalar'],
    [{ app_id: { eq: 'dsh' } }, undefined, 'operator object'],
    [{ and: [{ score: { eq: 1 } }] }, undefined, 'unsupported'],
    [{ and: [{ tags: { contains: ' ' } }] }, undefined, 'blank'],
    [{ and: [{ title: { like: 3 } }] }, undefined, 'string'],
    [{ and: [{ tags: { in: [] } }] }, undefined, 'empty'],
    [{ and: [{ tags: { in: ['a', 2] } }] }, undefined, 'string'],
    [{ and: [{ create_time: { gte: '2026-02-30' } }] }, undefined, 'date'],
    [{ and: [{ create_time: { gte: '2026/02/01' } }] }, undefined, 'date'],
    [{ and: [{ event_time: { gte: '2026-08-01' } }] }, undefined, 'time field'],
    [{ knowledgebase: { doc_type: 'api' } }, undefined, 'knowledgebaseIds'],
    [{ knowledgebase: { doc_type: 'api' } }, [], 'knowledgebaseIds'],
    [{ knowledgebase: { doc_type: 'api' } }, [' '], 'blank'],
    [{ knowledgebase: { doc_type: 'api' } }, ['all', 'kb_1'], 'all'],
  ] as const)('rejects invalid filter %j', (filter, ids, message) => {
    expect(() => validateFilter(filter, ids)).toThrow(message)
  })
})

describe('isPerSourceFilter', () => {
  it('requires a non-empty object containing only source keys', () => {
    expect(isPerSourceFilter({ user: { tags: 'a' } })).toBe(true)
    expect(isPerSourceFilter({ user: { tags: 'a' }, knowledgebase: { type: 'doc' } })).toBe(true)
    expect(isPerSourceFilter({})).toBe(false)
    expect(isPerSourceFilter({ app_id: 'dsh' })).toBe(false)
  })
})

describe('buildEffectiveFilter', () => {
  it('builds an agent-only user filter', () => {
    expect(buildEffectiveFilter(undefined, 'agent-1')).toEqual({
      user: { agent_id: 'agent-1' },
    })
  })

  it('wraps an ordinary filter under user even without agentId', () => {
    expect(buildEffectiveFilter({ app_id: 'dsh' }, undefined)).toEqual({
      user: { app_id: 'dsh' },
    })
  })

  it('ANDs agentId only into the user branch', () => {
    expect(buildEffectiveFilter({
      user: { tags: 'a' },
      public: { locale: 'zh' },
      knowledgebase: { doc_type: 'api' },
    }, 'agent-1')).toEqual({
      user: { tags: 'a', agent_id: 'agent-1' },
      public: { locale: 'zh' },
      knowledgebase: { doc_type: 'api' },
    })
  })

  it('flattens agentId into ordinary simple and logical-and filters', () => {
    expect(buildEffectiveFilter({ app_id: 'dsh' }, 'agent-1')).toEqual({
      user: { app_id: 'dsh', agent_id: 'agent-1' },
    })
    expect(buildEffectiveFilter({ and: [{ tags: 'a' }] }, 'agent-1')).toEqual({
      user: { and: [{ tags: 'a' }, { agent_id: 'agent-1' }] },
    })
    expect(buildEffectiveFilter({ user: { and: [{ tags: 'a' }] } }, 'agent-1')).toEqual({
      user: { and: [{ tags: 'a' }, { agent_id: 'agent-1' }] },
    })
  })

  it('rejects agent merges that the flat Playground grammar cannot express', () => {
    expect(() => buildEffectiveFilter({ or: [{ tags: 'a' }] }, 'agent-1'))
      .toThrow('agentId cannot be combined with an or filter')
    expect(() => buildEffectiveFilter({ user: { or: [{ tags: 'a' }] } }, 'agent-1'))
      .toThrow('agentId cannot be combined with filter.user.or')
    expect(() => buildEffectiveFilter({ user: { agent_id: 'agent-2' } }, 'agent-1'))
      .toThrow('conflicts')
    expect(() => buildEffectiveFilter({ and: [{ agent_id: 'agent-2' }] }, 'agent-1'))
      .toThrow('conflicts')
    expect(buildEffectiveFilter({ and: [{ agent_id: 'agent-1' }] }, 'agent-1')).toEqual({
      user: { and: [{ agent_id: 'agent-1' }] },
    })
  })

  it('returns a detached clone and never mutates its input', () => {
    const filter: JsonObject = {
      user: { and: [{ tags: { contains: 'a' } }] },
      knowledgebase: { doc_type: 'api' },
    }
    const before = JSON.stringify(filter)
    const result = buildEffectiveFilter(filter, 'agent-1')

    expect(JSON.stringify(filter)).toBe(before)
    expect(result).not.toBe(filter)
    ;((result?.user as JsonObject).and as JsonObject[]).push({ mutated: true })
    expect(JSON.stringify(filter)).toBe(before)
  })

  it('returns undefined when neither filter nor agentId exists', () => {
    expect(buildEffectiveFilter(undefined, undefined)).toBeUndefined()
  })
})
