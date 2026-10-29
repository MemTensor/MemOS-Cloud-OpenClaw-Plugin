#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { pnpmInvocation, repositoryRoot } from './command-runtime.mjs'

const root = repositoryRoot

const run = (command, args, cwd = root, options = {}) => execFileSync(command, args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  ...options,
})
const runPnpm = (args, cwd = root) => {
  const invocation = pnpmInvocation(args)
  return run(invocation.command, invocation.args, cwd)
}

const definitions = [
  {
    directory: 'packages/openclaw',
    name: '@memtensor/memos-cloud-openclaw-plugin',
    required: ['package/index.js', 'package/openclaw.plugin.json', 'package/lib/memos-core/index.js'],
    forbidden: [/cordis\.patch\.yml$/, /packages\/dsh/],
  },
  {
    directory: 'packages/dsh',
    name: '@memtensor/memos-cloud-dsh-plugin',
    required: ['package/lib/index.js', 'package/lib/index.d.ts', 'package/cordis.patch.yml'],
    forbidden: [/openclaw\.plugin\.json$/, /packages\/openclaw/],
  },
]

const args = process.argv.slice(2)
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--plugin' || !['openclaw', 'dsh'].includes(args[1]))) {
  throw new Error('Usage: pnpm exec node scripts/verify-package-artifacts.mjs [--plugin openclaw|dsh]')
}
const packageDefinitions = args.length === 0 ? definitions : definitions.filter(definition => definition.directory === `packages/${args[1]}`)
if (packageDefinitions.some(definition => definition.directory === 'packages/dsh')) {
  if (!process.env.DSH_TEST_RUNTIME || !existsSync(join(process.env.DSH_TEST_RUNTIME, 'node_modules/@deepseek-ai/dsh/package.json'))) {
    throw new Error('Set DSH_TEST_RUNTIME to a full supported DSH installation; the DSH artifact is verified through its host CLI')
  }
}
const artifactRoot = mkdtempSync(join(tmpdir(), 'memos-cloud-packages-'))

const tarballFor = (definition) => {
  const before = new Set(readdirSync(artifactRoot))
  runPnpm(['--dir', definition.directory, 'pack', '--pack-destination', artifactRoot])
  const created = readdirSync(artifactRoot).filter((name) => !before.has(name) && name.endsWith('.tgz'))
  if (created.length !== 1) throw new Error(`Expected one tarball for ${definition.name}; found ${created.length}`)
  return join(artifactRoot, created[0])
}

const inventoryFor = (tarball) => run('tar', ['-tf', tarball])
  .split(/\r?\n/)
  .map((line) => line.replace(/^\.\//, '').trim())
  .filter(Boolean)

const installAndImport = (definition, tarball) => {
  const installRoot = join(artifactRoot, definition.name.includes('openclaw') ? 'install-openclaw' : 'install-dsh')
  mkdirSync(installRoot, { recursive: true })
  writeFileSync(join(installRoot, 'package.json'), JSON.stringify({ private: true, type: 'module' }), {
    encoding: 'utf8',
    flag: 'wx',
  })
  runPnpm(['add', '--ignore-workspace', tarball], installRoot)
  const installedManifest = join(installRoot, 'node_modules', ...definition.name.split('/'), 'package.json')
  const manifest = JSON.parse(readFileSync(installedManifest, 'utf8'))
  if (manifest.dependencies?.['@memtensor/memos-cloud-plugin-core']) {
    throw new Error(`${definition.name} exposes the private core as a runtime dependency`)
  }
  run(process.execPath, ['--input-type=module', '--eval', `await import('${definition.name}')`], installRoot)
}

try {
  for (const definition of packageDefinitions) {
    const tarball = tarballFor(definition)
    const inventory = inventoryFor(tarball)
    for (const required of definition.required) {
      if (!inventory.includes(required)) throw new Error(`${definition.name} tarball is missing ${required}`)
    }
    for (const forbidden of definition.forbidden) {
      if (inventory.some((file) => forbidden.test(file))) {
        throw new Error(`${definition.name} tarball contains forbidden content matching ${forbidden}`)
      }
    }
    const manifest = JSON.parse(run('tar', ['-xOf', tarball, 'package/package.json']))
    if (manifest.dependencies?.['@memtensor/memos-cloud-plugin-core']) {
      throw new Error(`${definition.name} exposes the private core as a runtime dependency`)
    }
    if (definition.directory === 'packages/dsh') {
      run(process.execPath, [join(root, 'packages/dsh/scripts/standalone-smoke.mjs')], root, {
        env: { ...process.env, DSH_TEST_PACKAGE: tarball }, stdio: 'inherit',
      })
      run(process.execPath, [join(root, 'packages/dsh/scripts/host-smoke.mjs')], root, {
        env: { ...process.env, DSH_TEST_PACKAGE: tarball }, stdio: 'inherit',
      })
      process.stdout.write(`Verified ${definition.name}: ${inventory.length} packed files, standalone installation and real DSH host smoke passed.\n`)
    } else {
      installAndImport(definition, tarball)
      process.stdout.write(`Verified ${definition.name}: ${inventory.length} packed files, isolated install and import passed.\n`)
    }
  }
} finally {
  if (existsSync(artifactRoot)) rmSync(artifactRoot, { recursive: true, force: true })
}
