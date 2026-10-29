import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/memos-cloud.contract.spec.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 30_000,
  },
})
