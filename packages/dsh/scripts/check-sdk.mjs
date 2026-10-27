import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const paths = {}
if (process.env.DSH_TEST_RUNTIME) {
  const packages = resolve(process.env.DSH_TEST_RUNTIME, 'node_modules/@deepseek-ai')
  for (const name of readdirSync(packages)) {
    const manifest = JSON.parse(readFileSync(join(packages, name, 'package.json')))
    if (manifest.types) paths[`@deepseek-ai/${name}`] = [join(packages, name, manifest.types)]
  }
}
const temporary = mkdtempSync(join(tmpdir(), 'memos-sdk-check-'))
try {
  const config = join(temporary, 'tsconfig.json')
  writeFileSync(config, JSON.stringify({ extends: join(root, 'tsconfig.json'),
    compilerOptions: { paths, noEmit: true, incremental: false,
      typeRoots: [join(root, 'node_modules/@types'), join(root, '../../node_modules/@types')],
    }, include: [join(root, 'src')],
  }))
  const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', config], { stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally { rmSync(temporary, { recursive: true, force: true }) }
