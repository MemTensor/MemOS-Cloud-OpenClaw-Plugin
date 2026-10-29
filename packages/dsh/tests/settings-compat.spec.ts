import { Context } from '@deepseek-ai/cordis'
import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { Config, RuntimeConfig, configSnapshot, normalizeConfig } from '../src/config.ts'
import { prepareLegacyMigration } from '../src/settings-compat.ts'

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const setup = (override: Record<string, unknown> = {}, sharedHome?: string, name = 'profile') => {
  const home = sharedHome ?? mkdtempSync(join(tmpdir(), 'memos-settings-'))
  if (sharedHome === undefined) directories.push(home)
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
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
  it('migrates every profile after the host renames the stripped global document', async () => {
    const web = setup()
    const headless = setup({}, web.home, 'headless')
    const legacy = { userId: 'shared-user', agentId: 'shared-agent', tags: ['shared-tag'] }
    writeFileSync(join(web.home, 'settings.yaml'), 'other:\n  enabled: true\nmemos-cloud:\n  userId: shared-user\n  agentId: shared-agent\n  tags: [shared-tag]\n')
    await prepareLegacyMigration(web.ctx)()
    renameSync(join(web.home, 'settings.yaml'), join(web.home, 'settings.yaml.imported'))
    await prepareLegacyMigration(headless.ctx)()
    expect(web.config()).toMatchObject(legacy)
    expect(headless.config()).toMatchObject(legacy)
    expect(JSON.parse(readFileSync(join(web.home, 'memos-cloud.legacy.json'), 'utf8'))).toEqual(legacy)
    expect(statSync(join(web.home, 'memos-cloud.legacy.json')).mode & 0o777).toBe(0o600)
    for (const fixture of [web, headless]) {
      expect(statSync(join(fixture.dir, 'memos-cloud.legacy.json')).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(join(fixture.dir, 'memos-cloud.migration.json'), 'utf8'))).toHaveProperty('digest')
      await prepareLegacyMigration(fixture.ctx)()
      expect(fixture.edit).toHaveBeenCalledOnce()
    }
  })

  it('preserves a shared migration source while another profile retries a failed write', async () => {
    const web = setup()
    const headless = setup({ userId: 'headless-user' }, web.home, 'headless')
    writeFileSync(join(web.home, 'settings.yaml'), 'memos-cloud:\n  userId: shared-user\n  agentId: shared-agent\n')
    web.edit.mockRejectedValueOnce(new Error('read-only web profile'))
    await expect(prepareLegacyMigration(web.ctx)()).rejects.toThrow('read-only web profile')
    await prepareLegacyMigration(headless.ctx)()
    expect(headless.config()).toMatchObject({ userId: 'headless-user', agentId: 'shared-agent' })
    await prepareLegacyMigration(web.ctx)()
    expect(web.config()).toMatchObject({ userId: 'shared-user', agentId: 'shared-agent' })
  })

  it('publishes an existing profile backup for profiles that have not migrated yet', async () => {
    const web = setup()
    const legacy = { userId: 'preserved-user', agentId: 'preserved-agent' }
    writeFileSync(join(web.dir, 'memos-cloud.legacy.json'), JSON.stringify(legacy))
    writeFileSync(join(web.dir, 'memos-cloud.migration.json'), JSON.stringify({
      digest: createHash('sha256').update(JSON.stringify(legacy)).digest('hex'),
    }))
    await prepareLegacyMigration(web.ctx)()
    expect(web.edit).not.toHaveBeenCalled()
    const headless = setup({}, web.home, 'headless')
    await prepareLegacyMigration(headless.ctx)()
    expect(headless.config()).toMatchObject(legacy)
  })

  it('recovers an already-consumed global section without restarting the earlier profile', async () => {
    const web = setup()
    const legacy = { userId: 'preserved-user', agentId: 'preserved-agent' }
    writeFileSync(join(web.dir, 'memos-cloud.legacy.json'), JSON.stringify(legacy))
    writeFileSync(join(web.home, 'settings.yaml.imported'), 'other:\n  enabled: true\n')
    const headless = setup({}, web.home, 'headless')
    await prepareLegacyMigration(headless.ctx)()
    expect(headless.config()).toMatchObject(legacy)
    expect(web.edit).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(web.home, 'memos-cloud.legacy.json'), 'utf8'))).toEqual(legacy)
  })

  it('does not guess the memory partition when earlier profiles preserved conflicting sources', () => {
    const web = setup()
    const other = setup({}, web.home, 'other')
    writeFileSync(join(web.dir, 'memos-cloud.legacy.json'), JSON.stringify({ userId: 'first-user' }))
    writeFileSync(join(other.dir, 'memos-cloud.legacy.json'), JSON.stringify({ userId: 'second-user' }))
    const headless = setup({}, web.home, 'headless')
    expect(() => prepareLegacyMigration(headless.ctx)).toThrow('Conflicting legacy MemOS backups')
    expect(headless.edit).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(web.dir, 'memos-cloud.legacy.json'), 'utf8'))).toEqual({ userId: 'first-user' })
    expect(JSON.parse(readFileSync(join(other.dir, 'memos-cloud.legacy.json'), 'utf8'))).toEqual({ userId: 'second-user' })
  })

  it('does not replace a newer shared archive with an older profile retry backup', async () => {
    const web = setup()
    const latest = { userId: 'new-user', agentId: 'new-agent' }
    writeFileSync(join(web.home, 'memos-cloud.legacy.json'), JSON.stringify(latest))
    writeFileSync(join(web.dir, 'memos-cloud.legacy.json'), JSON.stringify({ userId: 'old-user' }))
    await prepareLegacyMigration(web.ctx)()
    const headless = setup({}, web.home, 'headless')
    await prepareLegacyMigration(headless.ctx)()
    expect(web.config()).toMatchObject({ userId: 'old-user' })
    expect(headless.config()).toMatchObject(latest)
    expect(JSON.parse(readFileSync(join(web.home, 'memos-cloud.legacy.json'), 'utf8'))).toEqual(latest)
  })

  it('retains a fresh global section for profiles starting after it was claimed', async () => {
    const web = setup()
    writeFileSync(join(web.home, 'memos-cloud.legacy.json'), JSON.stringify({ userId: 'old-user' }))
    writeFileSync(join(web.home, 'settings.yaml'), 'memos-cloud:\n  userId: new-user\n  agentId: new-agent\n')
    await prepareLegacyMigration(web.ctx)()
    const headless = setup({}, web.home, 'headless')
    await prepareLegacyMigration(headless.ctx)()
    for (const fixture of [web, headless]) expect(fixture.config()).toMatchObject({ userId: 'new-user', agentId: 'new-agent' })
  })

  it('does not restore reset values in a completed profile when another profile migrates', async () => {
    const web = setup()
    writeFileSync(join(web.home, 'settings.yaml'), 'memos-cloud:\n  userId: legacy-user\n  agentId: legacy-agent\n')
    await prepareLegacyMigration(web.ctx)()
    const restarted = setup({}, web.home)
    const headless = setup({}, web.home, 'headless')
    await prepareLegacyMigration(headless.ctx)()
    await prepareLegacyMigration(restarted.ctx)()
    expect(headless.config()).toMatchObject({ userId: 'legacy-user', agentId: 'legacy-agent' })
    expect(restarted.config()).toEqual({ recallEnabled: true })
    expect(restarted.edit).not.toHaveBeenCalled()
  })

  it('migrates concurrent host processes sharing a home without losing either profile settings', async () => {
    const fixture = setup()
    writeFileSync(join(fixture.home, 'settings.yaml'), 'memos-cloud:\n  userId: shared-user\n  agentId: shared-agent\n')
    const workers = ['web', 'headless'].map(name => {
      const child = fork(fileURLToPath(new URL('./fixtures/migration-worker.mjs', import.meta.url)), [fixture.home, name], {
        execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      let stderr = ''
      child.stderr?.on('data', chunk => { stderr += chunk })
      const ready = new Promise<void>((resolve, reject) => {
        child.on('message', message => { if ((message as { ready?: boolean }).ready) resolve() })
        child.on('error', reject)
        child.on('exit', code => { if (code !== 0) reject(new Error(stderr || `Migration worker exited with ${code}`)) })
      })
      const done = new Promise<void>((resolve, reject) => {
        child.on('error', reject)
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr || `Migration worker exited with ${code}`)))
      })
      // Observe failures even if the other worker has not reached its barrier yet.
      void done.catch(() => {})
      return { child, ready, done, name }
    })
    try {
      await Promise.all(workers.map(worker => worker.ready))
      for (const worker of workers) worker.child.send('migrate')
      await Promise.all(workers.map(worker => worker.done))
      for (const { name } of workers) {
        expect(JSON.parse(readFileSync(join(fixture.home, 'profiles', name, 'observed.json'), 'utf8'))).toMatchObject({
          userId: `${name}-user`, agentId: 'shared-agent',
        })
      }
      expect(JSON.parse(readFileSync(join(fixture.home, 'memos-cloud.legacy.json'), 'utf8'))).toMatchObject({
        userId: 'shared-user', agentId: 'shared-agent',
      })
    } finally { for (const { child } of workers) child.kill() }
  })

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
    rmSync(join(fixture.home, 'settings.yaml.imported'))
    const headless = setup({}, fixture.home, 'headless')
    await prepareLegacyMigration(headless.ctx)()
    expect(headless.config()).toMatchObject({ userId: 'recovered-user', includeToolMemory: true })
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
