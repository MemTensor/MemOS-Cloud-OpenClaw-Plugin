// Install the packed plugin in empty projects, without a DSH host or peer overrides.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pnpmInvocation, runChecked } from '../../../scripts/command-runtime.mjs'

if (!process.env.DSH_TEST_PACKAGE) throw new Error('Set DSH_TEST_PACKAGE to the packed plugin tarball')
const tarball = resolve(process.env.DSH_TEST_PACKAGE)
const root = mkdtempSync(join(tmpdir(), 'memos-standalone-smoke-'))
const pnpmEnv = process.env.DSH_TEST_PNPM
  ? { ...process.env, npm_execpath: resolve(process.env.DSH_TEST_PNPM) }
  : process.env
const pnpm = pnpmInvocation([], pnpmEnv)
const npm = pnpmInvocation([], { ...process.env, npm_execpath: process.platform === 'win32' ? 'npm.cmd' : 'npm' })
const summaries = []
for (const [manager, invocation, args] of [
  ['npm', npm, ['install', tarball, '--no-audit', '--no-fund']],
  ['pnpm', pnpm, ['add', '--ignore-workspace', tarball]],
]) {
  const directory = join(root, manager)
  mkdirSync(directory)
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  const run = (args) => runChecked(invocation.command, [...invocation.args, ...args], { cwd: directory, stdio: 'pipe' })
  const version = run(['--version'])
  if (manager === 'pnpm' && process.env.DSH_TEST_PNPM_VERSION) assert.equal(version, process.env.DSH_TEST_PNPM_VERSION)
  writeFileSync(join(directory, 'install.log'), run(args))
  const manifest = JSON.parse(readFileSync(join(directory, 'node_modules/@memtensor/memos-cloud-dsh-plugin/package.json')))
  const probe = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { readdirSync, existsSync } from 'node:fs';
    const plugin = await import('@memtensor/memos-cloud-dsh-plugin');
    assert.equal(plugin.name, 'memos-cloud');
    assert.equal(typeof plugin.apply, 'function');
    assert.equal(typeof plugin.installMemosLifecycle, 'function');
    assert.equal(typeof plugin.Config, 'function');
    assert.equal(plugin.MEMOS_SETTINGS_NAMESPACE, 'memos-cloud');
    assert.ok(plugin.inject.includes('agents') && plugin.inject.includes('sessions'));
    const require = createRequire(import.meta.url);
    const pluginRequire = createRequire(require.resolve('@memtensor/memos-cloud-dsh-plugin'));
    for (const name of ${JSON.stringify(Object.keys(manifest.peerDependencies))}) {
      assert.throws(() => require.resolve(name), { code: 'MODULE_NOT_FOUND' }, name);
      assert.throws(() => pluginRequire.resolve(name), { code: 'MODULE_NOT_FOUND' }, name);
    }
    if (existsSync('node_modules/.pnpm')) {
      assert.deepEqual(readdirSync('node_modules/.pnpm').filter(name => /^@deepseek-ai\\+(?:dsh-|cordis(?:@|-))/.test(name)), []);
    }
  `
  runChecked(process.execPath, ['--input-type=module', '--eval', probe], { cwd: directory, stdio: 'pipe' })
  assert.ok(existsSync(join(directory, manager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml')))
  summaries.push({ manager, version, plugin: manifest.version, installed: true, imported: true, hostSdksInstalled: false })
  console.log(JSON.stringify(summaries.at(-1)))
}
writeFileSync(join(root, 'results.json'), JSON.stringify(summaries, null, 2))
console.log(`Standalone installation passed; evidence: ${root}`)
