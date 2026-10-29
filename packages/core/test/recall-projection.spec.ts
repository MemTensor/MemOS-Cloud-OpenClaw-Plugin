import { describe, expect, it } from 'vitest'
import { projectRecall } from '../src/recall-projection.ts'

describe('projectRecall', () => {
  it('projects facts and preferences using documented fallbacks', () => {
    expect(projectRecall({
      memory_detail_list: [
        { id: 'fact', memory_value: ' remembered ', create_time: 1, relativity: 0.8 },
        { memory_key: 'fallback key' },
      ],
      preference_detail_list: [
        { id: 'pref', preference: ' concise ', preference_type: 'explicit', update_time: 'now' },
      ],
    }, { maxItemChars: 100, maxTotalChars: 500 })).toEqual({
      facts: [
        { id: 'fact', text: 'remembered', createdAt: 1, relativity: 0.8 },
        { text: 'fallback key' },
      ],
      preferences: [
        { id: 'pref', text: 'concise', type: 'explicit', updatedAt: 'now' },
      ],
    })
  })

  it('enforces per-item and total Unicode budgets', () => {
    expect(projectRecall({
      memory_detail_list: [{ memory_value: '😀abcd' }, { memory_value: 'second' }],
      preference_detail_list: [{ preference: 'third' }],
    }, { maxItemChars: 3, maxTotalChars: 5 })).toEqual({
      facts: [{ text: '😀ab' }, { text: 'se' }],
      preferences: [],
    })
  })

  it('projects OpenClaw-compatible tool memories into a host-neutral shape', () => {
    expect(projectRecall({
      tool_memory_detail_list: [{ id: 'tool', tool_value: 'use rg first', tool_type: 'ToolTrajectoryMemory' }],
    }, { maxItemChars: 100, maxTotalChars: 500 })).toEqual({
      facts: [],
      preferences: [],
      tools: [{ id: 'tool', text: 'use rg first', type: 'ToolTrajectoryMemory' }],
    })
  })

  it('returns undefined when no supported text exists', () => {
    expect(projectRecall({ memory_detail_list: [{}], preference_detail_list: [{}] }, {
      maxItemChars: 100,
      maxTotalChars: 100,
    })).toBeUndefined()
  })
})
