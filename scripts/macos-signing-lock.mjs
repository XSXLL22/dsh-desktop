import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

// Runner workspaces are isolated, but the macOS user's keychain search list
// is shared. Hold this lease from keychain preparation through cleanup.
export async function acquireSigningLock(directory, { timeoutMs = 1_800_000, pollMs = 5_000 } = {}) {
  await mkdir(path.dirname(directory), { recursive: true })
  const started = Date.now()
  const lease = randomUUID()
  while (true) {
    try {
      await mkdir(directory)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timed out waiting for macOS signing lock: ${directory}. Check the owning job before removing a stale lock.`)
      }
      await delay(pollMs)
      continue
    }
    try {
      await writeFile(path.join(directory, 'lease'), lease, { mode: 0o600 })
      return lease
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }
}

export async function releaseSigningLock(directory, lease) {
  let owner
  try {
    owner = await readFile(path.join(directory, 'lease'), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (owner !== lease) throw new Error('Refusing to release another job’s macOS signing lock')
  await rm(directory, { recursive: true })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const operation = process.argv[2]
  const directory = path.join(homedir(), '.cache', 'bisheng-macos-signing.lock')
  if (operation === 'acquire') {
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required')
    const lease = await acquireSigningLock(directory)
    try {
      await appendFile(process.env.GITHUB_OUTPUT, `lease=${lease}\n`)
    } catch (error) {
      await releaseSigningLock(directory, lease)
      throw error
    }
    console.log('Acquired macOS signing lock.')
  } else if (operation === 'release') {
    if (process.env.SIGNING_LOCK_LEASE) {
      await releaseSigningLock(directory, process.env.SIGNING_LOCK_LEASE)
      console.log('Released macOS signing lock.')
    }
  } else {
    throw new Error('Expected acquire or release')
  }
}
