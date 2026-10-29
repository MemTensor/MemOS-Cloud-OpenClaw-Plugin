import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include, { applyEntryPatches, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import * as memosPlugin from '../src/index.ts'

let temporaryRoot: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true })
  temporaryRoot = undefined
})

const readPatches = async (): Promise<PatchOptions[]> => {
  const text = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  return yaml.load(text) as PatchOptions[]
}

describe('MemOS bundle metadata', () => {
  it('inserts exactly one independent plugin row', async () => {
    expect(await readPatches()).toEqual([
      {
        insert: [{ id: 'memos-cloud', name: '@memtensor/memos-cloud-dsh-plugin' }],
      },
    ])
  })

  it('preserves the base, supports a later full config replacement and clean removal', async () => {
    const base = [
      { id: 'agent', name: '@fixture/agent', config: { model: 'fixture' } },
      { id: 'session', name: '@fixture/session', config: { storage: 'memory' } },
    ]
    const before = structuredClone(base)
    const warnings: string[] = []
    const bundled = applyEntryPatches(base, await readPatches(), (message) => warnings.push(message))

    expect(warnings).toEqual([])
    expect(base).toEqual(before)
    expect(bundled).toEqual([
      ...before,
      { id: 'memos-cloud', name: '@memtensor/memos-cloud-dsh-plugin' },
    ])
    expect(bundled.filter((entry) => entry.id === 'memos-cloud')).toHaveLength(1)

    const profiled = applyEntryPatches(bundled, [{
      id: 'memos-cloud',
      config: { recallEnabled: false, filter: { app_id: 'profile' } },
    }], (message) => warnings.push(message))
    expect(profiled.at(-1)?.config).toEqual({
      recallEnabled: false,
      filter: { app_id: 'profile' },
    })

    const withoutBundle = applyEntryPatches(base, undefined, (message) => warnings.push(message))
    expect(withoutBundle).toEqual(before)
    expect(withoutBundle.some((entry) => entry.id === 'memos-cloud')).toBe(false)
  })
})

describe('MemOS plugin through a real Loader composition', () => {
  it('loads the inserted row beside unchanged base entries', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-memos-loader-'))
    const configPath = join(temporaryRoot, 'cordis.yml')
    await writeFile(configPath, [
      "- id: base-fixture",
      "  name: '@fixture/base'",
      "- id: memos-cloud",
      "  name: '@memtensor/memos-cloud-dsh-plugin'",
      '  config:',
      '    recallEnabled: false',
      '    addEnabled: false',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = `${pathToFileURL(temporaryRoot).href}/`
    context.provide('agents', {})
    context.provide('sessions', {})
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@fixture/base', { name: 'base-fixture', apply: () => {} }],
      ['@memtensor/memos-cloud-dsh-plugin', memosPlugin],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>

    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    const entries = [...context.loader.entries()]
      .filter((entry) => entry.options.id === 'base-fixture' || entry.options.id === 'memos-cloud')
    expect(entries.map((entry) => entry.options.id)).toEqual(['base-fixture', 'memos-cloud'])
    expect(entries.every((entry) => entry.fiber !== undefined && !entry.disabled)).toBe(true)
  })
})
