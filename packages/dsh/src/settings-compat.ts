import type { Context } from '@deepseek-ai/cordis'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isNode, parseDocument } from 'yaml'
import { Config, normalizeConfig, type Config as ConfigValues } from './config.ts'

export interface LegacySettings {
  register(ns: string, schema: typeof Config, options: {
    base: ConfigValues
    validate(value: ConfigValues): void
  }): { get(): ConfigValues }
}

interface ConfigRow {
  entry: { fiber?: unknown; options: { id: string } }
  override: Record<string, unknown>
}

interface ConfigEditor {
  configuration(): ConfigRow[]
  edit(entry: ConfigRow['entry'], change: (
    current: Record<string, unknown>, inherited: Record<string, unknown>,
  ) => Record<string, unknown>): Promise<void>
}

const read = (path: string): string | undefined => {
  try { return readFileSync(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

const atomicWrite = (path: string, value: string): void => {
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, value, { mode: 0o600, flag: 'wx', flush: true })
  try { renameSync(temporary, path) } catch (error) {
    unlinkSync(temporary)
    throw error
  }
}

const object = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
)

/** Claim only our legacy section before the host's rename-and-import job runs.
 * Keep a private, durable backup until the profile write succeeds. A digest
 * prevents old values reappearing after a later Settings reset or on restart.
 */
export const prepareLegacyMigration = (ctx: Context): (() => Promise<void>) => {
  const profile = ctx.get('profileContext') as { home: string; dir: string } | undefined
  if (profile === undefined) return async () => {}
  const backup = join(profile.dir, 'memos-cloud.legacy.json')
  const marker = join(profile.dir, 'memos-cloud.migration.json')
  let section: unknown
  const saved = read(backup)
  if (saved !== undefined) section = JSON.parse(saved)

  const legacyPath = join(profile.home, 'settings.yaml')
  const source = read(legacyPath)
  if (source !== undefined) {
    const document = parseDocument(source)
    if (document.errors.length) throw new Error('Cannot read legacy settings.yaml; migration has not completed')
    if (document.has('memos-cloud')) {
      const node = document.get('memos-cloud', true)
      section = isNode(node) ? node.toJSON() : node
      if (!object(section)) throw new Error('Legacy memos-cloud settings must be an object')
      atomicWrite(backup, JSON.stringify(section) + '\n')
      document.delete('memos-cloud')
      atomicWrite(legacyPath, String(document))
    }
  }
  if (section === undefined) {
    const imported = read(`${legacyPath}.imported`)
    if (imported !== undefined) {
      const document = parseDocument(imported)
      if (document.errors.length) throw new Error('Cannot read legacy settings.yaml.imported; migration has not completed')
      const node = document.get('memos-cloud', true)
      section = isNode(node) ? node.toJSON() : node
      if (section !== undefined) {
        if (!object(section)) throw new Error('Legacy memos-cloud settings must be an object')
        atomicWrite(backup, JSON.stringify(section) + '\n')
      }
    }
  }
  if (section === undefined) return async () => {}
  if (!object(section)) throw new Error('Legacy memos-cloud settings must be an object')
  const legacy = section
  const digest = createHash('sha256').update(JSON.stringify(legacy)).digest('hex')
  const completed = read(marker)
  if (completed !== undefined && JSON.parse(completed).digest === digest) return async () => {}

  return async () => {
    // The entry must be active before ConfigEditor can persist its config.
    const loader = ctx.get('loader') as { await(): Promise<unknown> } | undefined
    await loader?.await()
    const editor = ctx.get('configEditor') as ConfigEditor | undefined
    const row = editor?.configuration().find(({ entry }) => entry.fiber === ctx.fiber)
    if (editor === undefined || row === undefined) throw new Error('Legacy MemOS settings could not be migrated; profile editor unavailable')
    await editor.edit(row.entry, (current, inherited) => {
      // Current explicit values win. Bundle defaults are not explicit choices.
      const next = { ...inherited, ...legacy, ...row.override }
      // Preserve edits made while migration was waiting for the loader.
      for (const key of Object.keys(current)) {
        if (!Object.hasOwn(inherited, key) || !isDeepStrictEqual(current[key], inherited[key])) next[key] = current[key]
      }
      Config(next)
      normalizeConfig(next)
      return next
    })
    atomicWrite(marker, JSON.stringify({ digest }) + '\n')
  }
}
