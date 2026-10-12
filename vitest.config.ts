import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.{test,spec}.{ts,js,mjs}'],
    // ARM64 and Rosetta x64 CI workers share the same Mac. Serialize files in
    // both jobs so ARM64 tests leave CPU and disk headroom for the Intel worker.
    // Windows integration suites also need serialization to avoid EBUSY locks.
    fileParallelism: !(
      process.env.CI &&
      (process.platform === 'darwin' || process.platform === 'win32')
    ),
    testTimeout: 60_000
  }
})
