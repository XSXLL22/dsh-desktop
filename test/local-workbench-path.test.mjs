import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clientStaysInsideDirectory, isAcceptedLocalWorkbenchPath, readLocalWorkbenchPackage } from '../packages/dsh-desktop-workbenches/local-install.mjs'

const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function packageAt(clientExport) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-workbench-'))
  roots.push(root)
  const directory = join(root, 'pkg')
  await mkdir(directory)
  await writeFile(join(directory, 'client.js'), 'export {}\n')
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: 'local-workbench',
    version: '1.0.0',
    exports: { './client': clientExport },
    dsh: { client: { inject: ['dsh-desktop-workbenches'] } }
  }))
  return { root, directory }
}

describe('local workbench directory containment', () => {
  it('accepts a posix package whose client stays inside the directory', async () => {
    const { directory } = await packageAt('./client.js')
    await expect(readLocalWorkbenchPackage(directory)).resolves.toMatchObject({
      name: 'local-workbench',
      version: '1.0.0'
    })
  })

  it('rejects a client path that resolves outside the package', async () => {
    const { root, directory } = await packageAt('../outside.js')
    await writeFile(join(root, 'outside.js'), 'export {}\n')
    await expect(readLocalWorkbenchPackage(directory)).rejects.toThrow('escapes its directory')
  })

  it('rejects a symlink that leaves the package', async () => {
    const { root, directory } = await packageAt('./linked.js')
    await writeFile(join(root, 'outside.js'), 'export {}\n')
    await symlink(join(root, 'outside.js'), join(directory, 'linked.js'))
    await expect(readLocalWorkbenchPackage(directory)).rejects.toThrow('escapes its directory')
  })

  it('treats a Windows drive path as a local directory and still rejects URI schemes', () => {
    expect(isAcceptedLocalWorkbenchPath('C:\\Users\\dev\\workbench')).toBe(true)
    expect(isAcceptedLocalWorkbenchPath('D:/workbench')).toBe(true)
    expect(isAcceptedLocalWorkbenchPath('file:///C:/Users/dev/workbench')).toBe(false)
    expect(isAcceptedLocalWorkbenchPath('https://example.com/workbench.tgz')).toBe(false)
    expect(isAcceptedLocalWorkbenchPath('workbench')).toBe(false)
    expect(clientStaysInsideDirectory('C:\\pkg', 'C:\\pkg\\client.js')).toBe(true)
    expect(clientStaysInsideDirectory('C:\\pkg', 'C:\\pkg\\nested\\client.js')).toBe(true)
    expect(clientStaysInsideDirectory('C:\\pkg', 'C:\\other\\client.js')).toBe(false)
    expect(clientStaysInsideDirectory('D:\\pkg', 'C:\\pkg\\client.js')).toBe(false)
  })

  // A Windows junction is another realpath escape. This case runs only on Windows;
  // other hosts cover the same containment with the symlink test above.
  it.skipIf(process.platform !== 'win32')('rejects a directory junction that points outside the package', async () => {
    const { root, directory } = await packageAt('./nested/client.js')
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'client.js'), 'export {}\n')
    await symlink(outside, join(directory, 'nested'), 'junction')
    await expect(readLocalWorkbenchPackage(directory)).rejects.toThrow('escapes its directory')
  })
})