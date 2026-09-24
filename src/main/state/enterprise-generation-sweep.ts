import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { removeTree } from './remove-tree'

/**
 * Enterprise plugins are published as immutable directories under
 * `profiles/.enterprise-generations`. Uninstall and update only rewrite the
 * account document and stop the running instance; the directory stays until
 * this sweep, which runs once per launch while Harness is stopped.
 *
 * Every account file under `enterprise-market` is authoritative. A generation
 * still named by any account — including a disabled plugin or another signed-in
 * enterprise — is kept. Tombstones and the operations log are not directory
 * references and are left untouched.
 */

const GENERATION_ID_PATTERN = /^[a-z0-9+_.-]+$/iu

export interface EnterpriseGenerationSweepResult {
  removed: string[]
  failed: string[]
  skipped: boolean
}

export function enterpriseGenerationLayout(dshHome: string): {
  market: string
  generations: string
  staging: string
  trash: string
} {
  return {
    market: join(dshHome, 'enterprise-market'),
    generations: join(dshHome, 'profiles', '.enterprise-generations'),
    staging: join(dshHome, 'profiles', '.enterprise-staging'),
    trash: join(dshHome, 'profiles', '.enterprise-trash')
  }
}

function isSafeGenerationId(value: string): boolean {
  return GENERATION_ID_PATTERN.test(value) && value !== '.' && value !== '..'
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot !== '' && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)
}

async function readReferencedGenerationIds(marketDirectory: string): Promise<Set<string> | undefined> {
  let entries
  try {
    entries = await readdir(marketDirectory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    return undefined
  }

  const referenced = new Set<string>()
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue
    // Dirent.isFile() is false for a symlink, so treating only regular files
    // as accounts would ignore a linked document and delete generations that
    // account still lists. Any .json name that is not a regular file is unread.
    let metadata
    try {
      metadata = await lstat(join(marketDirectory, entry.name))
    } catch {
      return undefined
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(join(marketDirectory, entry.name), 'utf8'))
    } catch {
      return undefined
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const installed = (parsed as { installed?: unknown }).installed
    if (!Array.isArray(installed)) return undefined
    for (const record of installed) {
      if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined
      const generationId = (record as { generation_id?: unknown }).generation_id
      if (typeof generationId !== 'string' || !isSafeGenerationId(generationId)) return undefined
      referenced.add(generationId)
    }
  }
  return referenced
}

async function clearDirectory(directory: string, label: string, removed: string[], failed: string[]): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    failed.push(label)
    return
  }
  for (const name of entries) {
    try {
      await removeTree(join(directory, name))
      removed.push(`${label}/${name}`)
    } catch {
      failed.push(`${label}/${name}`)
    }
  }
}

/**
 * Delete enterprise staging leftovers and generation directories no account
 * still lists. Returns `skipped` without deleting when an account document
 * cannot be trusted. Individual removals that fail stay for the next launch.
 */
export async function sweepEnterpriseGenerations(dshHome: string): Promise<EnterpriseGenerationSweepResult> {
  const layout = enterpriseGenerationLayout(dshHome)
  const referenced = await readReferencedGenerationIds(layout.market)
  if (referenced === undefined) return { removed: [], failed: [], skipped: true }

  const removed: string[] = []
  const failed: string[] = []
  await clearDirectory(layout.staging, 'staging', removed, failed)
  await clearDirectory(layout.trash, 'trash', removed, failed)

  let generationEntries
  try {
    generationEntries = await readdir(layout.generations, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { removed, failed, skipped: false }
    }
    failed.push('generations')
    return { removed, failed, skipped: false }
  }

  let generationsRoot: string
  try {
    generationsRoot = await realpath(layout.generations)
  } catch {
    failed.push('generations')
    return { removed, failed, skipped: false }
  }

  await mkdir(layout.trash, { recursive: true })
  for (const entry of generationEntries) {
    if (!isSafeGenerationId(entry.name) || referenced.has(entry.name)) continue
    const directory = join(layout.generations, entry.name)
    let metadata
    try {
      metadata = await lstat(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      failed.push(entry.name)
      continue
    }
    if (metadata.isSymbolicLink()) {
      try {
        await unlink(directory)
        removed.push(entry.name)
      } catch {
        failed.push(entry.name)
      }
      continue
    }
    if (!metadata.isDirectory()) continue
    try {
      const resolved = await realpath(directory)
      if (!isInside(generationsRoot, resolved)) {
        failed.push(entry.name)
        continue
      }
      const trashed = join(layout.trash, `${entry.name}.${randomUUID()}`)
      await rename(directory, trashed)
      await removeTree(trashed)
      removed.push(entry.name)
    } catch {
      failed.push(entry.name)
    }
  }

  return { removed, failed, skipped: false }
}
