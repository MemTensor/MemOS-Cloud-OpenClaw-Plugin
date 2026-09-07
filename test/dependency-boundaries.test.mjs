import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const sourceExtensions = new Set(['.js', '.mjs', '.ts'])

const sourceFiles = (directory) => {
  const absolute = fileURLToPath(new URL(`${directory}/`, root))
  const files = []
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (['dist', 'lib', 'node_modules'].includes(entry.name)) continue
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (sourceExtensions.has(extname(entry.name))) files.push(child)
    }
  }
  visit(absolute)
  return files
}

const assertNoMatch = (directory, patterns) => {
  const violations = []
  for (const file of sourceFiles(directory)) {
    const content = readFileSync(file, 'utf8')
    for (const pattern of patterns) {
      if (pattern.test(content)) violations.push(`${relative(fileURLToPath(root), file)} matches ${pattern}`)
    }
  }
  assert.deepEqual(violations, [])
}

test('the shared core has no host dependency', () => {
  assertNoMatch('packages/core', [/@deepseek-ai\//, /(?:packages\/|\.\.\/)openclaw/, /cordis/i])
})

test('OpenClaw cannot acquire DSH or Cordis dependencies', () => {
  assertNoMatch('packages/openclaw', [/@deepseek-ai\//, /(?:packages\/|\.\.\/)dsh/, /cordis/i])
})

test('DSH cannot acquire OpenClaw dependencies', () => {
  assertNoMatch('packages/dsh', [/@memtensor\/memos-cloud-openclaw-plugin/, /(?:packages\/|\.\.\/)openclaw/])
})

test('both adapters consume core through their package-specific delivery strategy', () => {
  const openclaw = readFileSync(new URL('../packages/openclaw/lib/memos-cloud-api.js', import.meta.url), 'utf8')
  const dsh = readFileSync(new URL('../packages/dsh/src/lifecycle.ts', import.meta.url), 'utf8')
  assert.match(openclaw, /from "\.\/memos-core\/index\.js"/)
  assert.match(dsh, /from '@memtensor\/memos-cloud-plugin-core'/)
})
