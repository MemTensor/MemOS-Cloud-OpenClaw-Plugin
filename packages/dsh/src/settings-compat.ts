import type { Context } from '@deepseek-ai/cordis'
import { createHash, randomUUID } from 'node:crypto'
import { linkSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, type Dirent } from 'node:fs'
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

const atomicWrite = (path: string, value: string, exclusive = false): void => {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, value, { mode: 0o600, flag: 'wx', flush: true })
    // Publish a complete file without replacing another process's archive.
    if (exclusive) linkSync(temporary, path)
    else renameSync(temporary, path)
  } catch (error) {
    if (!exclusive || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  } finally {
    try { unlinkSync(temporary) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

const object = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
)

// Earlier plugin versions may already have removed the global section, leaving
// its only copy in another profile. Recover matching copies without booting it.
const priorProfileBackup = (home: string): Record<string, unknown> | undefined => {
  const profilesPath = join(home, 'profiles')
  let profiles: Dirent[]
  try { profiles = readdirSync(profilesPath, { withFileTypes: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let section: Record<string, unknown> | undefined
  for (const profile of profiles.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!profile.isDirectory()) continue
    const saved = read(join(profilesPath, profile.name, 'memos-cloud.legacy.json'))
    if (saved === undefined) continue
    const candidate: unknown = JSON.parse(saved)
    if (!object(candidate)) throw new Error('Legacy memos-cloud settings must be an object')
    if (section !== undefined && !isDeepStrictEqual(section, candidate)) {
      throw new Error('Conflicting legacy MemOS backups across profiles; migration has not completed')
    }
    section = candidate
  }
  return section
}

/** Claim only our legacy section before the host's rename-and-import job runs.
 * Archive the home-wide source before removing it, so every profile can migrate.
 * Each profile keeps its own retry backup and completion digest; completing one
 * profile must neither consume another's source nor undo a later Settings reset.
 */
export const prepareLegacyMigration = (ctx: Context): (() => Promise<void>) => {
  const profile = ctx.get('profileContext') as { home: string; dir: string } | undefined
  if (profile === undefined) return async () => {}
  const sharedBackup = join(profile.home, 'memos-cloud.legacy.json')
  const backup = join(profile.dir, 'memos-cloud.legacy.json')
  const marker = join(profile.dir, 'memos-cloud.migration.json')
  let section: unknown
  let saved = read(backup)
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
      saved = JSON.stringify(section) + '\n'
      // Other host processes may start before this profile write completes.
      // Retain the shared source before changing settings.yaml for the host.
      atomicWrite(sharedBackup, saved)
      atomicWrite(backup, saved)
      document.delete('memos-cloud')
      atomicWrite(legacyPath, String(document))
    }
  }
  if (section === undefined) {
    const shared = read(sharedBackup)
    if (shared !== undefined) section = JSON.parse(shared)
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
      }
    }
  }
  if (section === undefined) section = priorProfileBackup(profile.home)
  if (section === undefined) return async () => {}
  if (!object(section)) throw new Error('Legacy memos-cloud settings must be an object')
  const legacy = section
  const serialized = JSON.stringify(legacy) + '\n'
  // An earlier plugin may have preserved this source only inside one profile.
  // Publish that backup for later profiles, without replacing a newer archive.
  if (read(sharedBackup) === undefined) atomicWrite(sharedBackup, serialized, true)
  const digest = createHash('sha256').update(JSON.stringify(legacy)).digest('hex')
  const completed = read(marker)
  if (completed !== undefined && JSON.parse(completed).digest === digest) return async () => {}
  if (saved !== serialized) atomicWrite(backup, serialized)

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
