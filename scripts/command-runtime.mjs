import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const isMainModule = (moduleUrl, argv = process.argv) => {
  if (argv[1] === undefined) return false
  return pathToFileURL(resolve(argv[1])).href === moduleUrl
}

export const runChecked = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: 'utf8',
    env: options.env ?? process.env,
    stdio: options.stdio ?? 'inherit',
  })

  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    const detail = result.stderr?.trim()
    throw new Error(detail || `Command failed (${result.status}): ${command} ${args.join(' ')}`)
  }
  return result.stdout?.trim() ?? ''
}

export const pnpmInvocation = (args, env = process.env, platform = process.platform) => {
  const pnpmEntry = env.npm_execpath
  if (pnpmEntry !== undefined && pnpmEntry.length > 0) {
    return { command: process.execPath, args: [pnpmEntry, ...args] }
  }

  if (platform === 'win32') {
    return {
      command: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm.cmd', ...args],
    }
  }
  return { command: 'pnpm', args }
}

export const runPnpm = (args, options = {}) => {
  const invocation = pnpmInvocation(args, options.env)
  return runChecked(invocation.command, invocation.args, options)
}
