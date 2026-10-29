// Keep package-manager selection independent of the workspace build version.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pnpmInvocation } from '../../../scripts/command-runtime.mjs'

const runtime = resolve(process.env.DSH_TEST_RUNTIME)
const { runCli } = await import(pathToFileURL(resolve(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')))
const env = process.env.DSH_TEST_PNPM
  ? { ...process.env, npm_execpath: resolve(process.env.DSH_TEST_PNPM) }
  : process.env
await runCli({ packageManager: pnpmInvocation([], env) })
