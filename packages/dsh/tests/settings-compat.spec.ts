import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { Config, RuntimeConfig, configSnapshot, normalizeConfig } from '../src/config.ts'
import { prepareLegacyMigration } from '../src/settings-compat.ts'

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const setup = (override: Record<string, unknown> = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'memos-settings-'))
  directories.push(home)
  const dir = join(home, 'profile')
  mkdirSync(dir)
  const ctx = new Context()
  const inherited = { recallEnabled: true }
  let config = { ...inherited, ...override }
  const row = { entry: { fiber: ctx.fiber, options: { id: 'memos-cloud' } }, override }
  const edit = vi.fn(async (_entry, change) => { config = change(config, inherited) })
  ctx.provide('profileContext', { home, dir })
  ctx.provide('loader', { await: async () => {} })
  ctx.provide('configEditor', { configuration: () => [row], edit })
  return { ctx, home, dir, edit, config: () => config }
}

describe('Settings compatibility', () => {
  it('reads a fresh atomic config snapshot from a modern reference', () => {
    let value = { userId: 'before', tags: ['original'] }
    const ref = { get: () => value }
    const first = normalizeConfig(configSnapshot(ref))
    value = { userId: 'after', tags: ['edited'] }
    expect(normalizeConfig(configSnapshot(ref)).userId).toBe('after')
    expect(first.userId).toBe('before')
    expect(first.tags).toEqual(['original'])
    expect(RuntimeConfig.meta.volatile).toBe(true)
    // SettingsProvider uses the plain schema even when the host supports refs.
    expect(Config.meta.volatile).not.toBe(true)
  })

  it('claims only its old section, preserves other YAML and explicit profile choices', async () => {
    const fixture = setup({ userId: 'profile-user' })
    writeFileSync(join(fixture.home, 'settings.yaml'), '# keep this comment\nother:\n  enabled: true\nmemos-cloud:\n  userId: old-user\n  tags: [old-tag]\n')
    const migrate = prepareLegacyMigration(fixture.ctx)
    const source = readFileSync(join(fixture.home, 'settings.yaml'), 'utf8')
    expect(source).toContain('# keep this comment')
    expect(parse(source)).toEqual({ other: { enabled: true } })
    await migrate()
    expect(fixture.config()).toMatchObject({ userId: 'profile-user', tags: ['old-tag'], recallEnabled: true })
    expect(statSync(join(fixture.dir, 'memos-cloud.legacy.json')).mode & 0o777).toBe(0o600)
    await prepareLegacyMigration(fixture.ctx)()
    expect(fixture.edit).toHaveBeenCalledOnce()
  })

  it('recovers a section rejected by an earlier host import and does not resurrect reset settings', async () => {
    const fixture = setup()
    writeFileSync(join(fixture.home, 'settings.yaml.imported'), 'memos-cloud:\n  userId: recovered-user\n  includeToolMemory: true\n')
    await prepareLegacyMigration(fixture.ctx)()
    expect(fixture.config()).toMatchObject({ userId: 'recovered-user', includeToolMemory: true })
    await prepareLegacyMigration(fixture.ctx)()
    expect(fixture.edit).toHaveBeenCalledOnce()
  })

  it('keeps a durable backup and retries after a failed profile write', async () => {
    const fixture = setup()
    writeFileSync(join(fixture.home, 'settings.yaml'), 'memos-cloud:\n  userId: retry-user\n')
    fixture.edit.mockRejectedValueOnce(new Error('read-only profile'))
    await expect(prepareLegacyMigration(fixture.ctx)()).rejects.toThrow('read-only profile')
    expect(JSON.parse(readFileSync(join(fixture.dir, 'memos-cloud.legacy.json'), 'utf8'))).toEqual({ userId: 'retry-user' })
    await prepareLegacyMigration(fixture.ctx)()
    expect(fixture.config()).toMatchObject({ userId: 'retry-user' })
  })

  it('migrates a legacy long timeout while preserving explicit operation timeouts', async () => {
    const fixture = setup({ searchTimeoutMs: 3000, syncAddTimeoutMs: 90000 })
    writeFileSync(join(fixture.home, 'settings.yaml'), 'memos-cloud:\n  timeoutMs: 60000\n  asyncMode: false\n')
    await prepareLegacyMigration(fixture.ctx)()
    const migrated = Config(fixture.config())
    expect(normalizeConfig(migrated)).toMatchObject({ timeoutMs: 60000, searchTimeoutMs: 3000, addTimeoutMs: 90000 })
    expect(normalizeConfig({ ...migrated, asyncMode: true }).addTimeoutMs).toBe(5000)
    expect(JSON.parse(readFileSync(join(fixture.dir, 'memos-cloud.legacy.json'), 'utf8'))).toEqual({ timeoutMs: 60000, asyncMode: false })
  })

  it('rejects an invalid legacy section before removing the source', () => {
    const fixture = setup()
    const path = join(fixture.home, 'settings.yaml')
    writeFileSync(path, 'memos-cloud: not-an-object\n')
    expect(() => prepareLegacyMigration(fixture.ctx)).toThrow('must be an object')
    expect(readFileSync(path, 'utf8')).toBe('memos-cloud: not-an-object\n')
    expect(fixture.edit).not.toHaveBeenCalled()
  })
})
