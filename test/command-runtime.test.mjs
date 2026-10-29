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

test('executes a native package-manager binary directly', () => {
  const pnpmBinary = '/opt/pnpm/pnpm'
  assert.deepEqual(
    pnpmInvocation(['install', '--frozen-lockfile'], { npm_execpath: pnpmBinary }, 'linux'),
    {
      command: pnpmBinary,
      args: ['install', '--frozen-lockfile'],
    },
  )
})

test('executes a Windows package-manager executable directly', () => {
  const pnpmBinary = 'C:\\tools\\pnpm.exe'
  assert.deepEqual(
    pnpmInvocation(['--version'], { npm_execpath: pnpmBinary }, 'win32'),
    {
      command: pnpmBinary,
      args: ['--version'],
    },
  )
})

test('runs a Windows batch package-manager entry through cmd.exe', () => {
  assert.deepEqual(
    pnpmInvocation(['--version'], {
      npm_execpath: 'C:\\tools\\pnpm.cmd',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    }, 'win32'),
    {
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'C:\\tools\\pnpm.cmd', '--version'],
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
