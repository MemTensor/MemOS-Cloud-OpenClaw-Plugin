import { vi } from 'vitest'

// Native require follows Node resolution rather than Vite's SDK aliases.
vi.mock('../src/sdk-runtime.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/sdk-runtime.ts')>()
  const { createRequire } = await import('node:module')
  const { resolve } = await import('node:path')
  return {
    ...original,
    hostSdk: original.createHostSdk(createRequire(resolve(process.env.DSH_TEST_RUNTIME!, 'package.json'))),
  }
})
