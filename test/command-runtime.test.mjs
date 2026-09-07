import assert from 'node:assert/strict'
import test from 'node:test'

import { pnpmInvocation } from '../scripts/command-runtime.mjs'

test('uses the package-manager entry supplied by a pnpm script', () => {
  assert.deepEqual(
    pnpmInvocation(['install'], { npm_execpath: 'C:\\tools\\pnpm.cjs' }, 'win32'),
    {
      command: process.execPath,
      args: ['C:\\tools\\pnpm.cjs', 'install'],
    },
  )
})

test('falls back to pnpm.cmd for direct CLI use on Windows', () => {
  assert.deepEqual(
    pnpmInvocation(['--version'], { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, 'win32'),
    {
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm.cmd', '--version'],
    },
  )
})

test('falls back to pnpm for direct CLI use on POSIX', () => {
  assert.deepEqual(
    pnpmInvocation(['--version'], {}, 'linux'),
    {
      command: 'pnpm',
      args: ['--version'],
    },
  )
})
