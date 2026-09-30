import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireSigningLock, releaseSigningLock } from '../scripts/macos-signing-lock.mjs'

describe('shared macOS signing lock', () => {
  it('waits for the previous job and never releases another job’s keychain lease', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bisheng-signing-lock-'))
    const directory = path.join(root, 'lock')
    try {
      const first = await acquireSigningLock(directory)
      await expect(releaseSigningLock(directory, 'wrong-owner')).rejects.toThrow('another job')
      expect(await readFile(path.join(directory, 'lease'), 'utf8')).toBe(first)
      await expect(acquireSigningLock(directory, { timeoutMs: 5, pollMs: 1 })).rejects.toThrow('Timed out')
      let acquired = false
      const second = acquireSigningLock(directory, { timeoutMs: 1000, pollMs: 1 }).then((lease) => {
        acquired = true
        return lease
      })
      expect(acquired).toBe(false)
      await releaseSigningLock(directory, first)
      const nextLease = await second
      expect(nextLease).not.toBe(first)
      await releaseSigningLock(directory, nextLease)
      await releaseSigningLock(directory, nextLease)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
