#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = new URL('../', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')
const pnpmEntry = process.env.npm_execpath
if (!pnpmEntry) throw new Error('Run this verifier through pnpm so npm_execpath is available')

const run = (command, args, cwd = root) => execFileSync(command, args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})
const runPnpm = (args, cwd = root) => run(process.execPath, [pnpmEntry, ...args], cwd)

const artifactRoot = mkdtempSync(join(tmpdir(), 'memos-cloud-packages-'))

const packageDefinitions = [
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
    installAndImport(definition, tarball)
    process.stdout.write(`Verified ${definition.name}: ${inventory.length} packed files, isolated install and import passed.\n`)
  }
} finally {
  if (existsSync(artifactRoot)) rmSync(artifactRoot, { recursive: true, force: true })
}
