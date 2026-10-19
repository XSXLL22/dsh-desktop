import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import { bundlePatchPaths, composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { randomUUID } from 'node:crypto'
import { packageEntry } from './community-package.js'

/** A transient Loader subtree keeps client modules and host lifecycle in the same registry. */
class MarketTree extends EntryTree {
  write() {}
}

function contained(root, path) {
  const nested = relative(root, path)
  if (isAbsolute(nested) || nested.startsWith('..')) throw new Error('Plugin entry leaves its package.')
}

export function createMarketRuntime(ctx) {
  let tree
  return async record => {
    tree ??= new MarketTree(ctx)
    const root = join(record.directory, 'node_modules', record.name)
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const entry = resolve(root, packageEntry(pkg))
    contained(root, entry)
    const id = randomUUID()
    let name = pathToFileURL(entry).href
    let config = record.config ?? {}
    if (pkg.dsh?.bundle) {
      const patches = bundlePatchPaths(root, pkg.dsh.bundle).flatMap(path => {
        contained(root, path)
        return loadOverlayPatches('enterprise-market', path)
      })
      const packageRequire = createRequire(join(root, 'package.json'))
      const entries = composeEntries([patches])
      const anchor = rows => rows.forEach(row => {
        row.id = `${id}-${row.id || randomUUID()}`
        if (row.name && !row.name.startsWith('cordis:') && !row.name.startsWith('file:')) row.name = pathToFileURL(packageRequire.resolve(row.name)).href
        if (row.group && Array.isArray(row.config)) anchor(row.config)
      })
      anchor(entries)
      name = pathToFileURL(createRequire(import.meta.url).resolve('@deepseek-ai/cordis-plugin-group')).href
      config = entries
    }
    let timer
    try {
      const options = { id, name, config }
      await tree.root.create(options)
      tree.root.data.push(options)
      const fiber = tree.store[id].fiber
      if (!fiber) throw new Error('Plugin did not create a runtime instance.')
      await Promise.race([fiber.await(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Plugin dependencies or configuration are not ready.')), 15000)
      })])
      if (fiber.state !== 2) throw new Error('Plugin dependencies or configuration are not ready.')
      await tree.await({ timeout: 15000 })
      await new Promise(resolve => setImmediate(resolve))
      const failed = Object.values(tree.store).find(entry => String(entry.options?.id ?? '').startsWith(`${id}-`) && entry.fiber?.state !== 2)
      if (fiber.state !== 2 || failed) throw new Error(failed?.lastImportError?.message || 'Plugin bundle entry did not activate.')
      return { dispose: () => tree.root.remove(id), get state() { return fiber.state } }
    } catch (error) {
      await tree.root.remove(id)
      throw error
    } finally { clearTimeout(timer) }
  }
}
