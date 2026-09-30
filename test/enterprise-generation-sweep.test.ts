import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareGenerationsForLaunch } from '../src/main/state/generation-launch'
import {
  enterpriseGenerationLayout,
  sweepEnterpriseGenerations
} from '../src/main/state/enterprise-generation-sweep'
import * as removeTreeModule from '../src/main/state/remove-tree'

const keptId = 'company-demo+1.0.0+kept'
const disabledId = 'company-demo+1.0.0+disabled'
const droppedId = 'company-demo+1.0.0+dropped'
const previousId = 'company-demo+1.0.0+previous'
const nextId = 'company-demo+1.1.0+next'
const otherAccountId = 'company-demo+1.0.0+other'

describe('enterprise generation cleanup', () => {
  const homes: string[] = []

  async function freshHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'dsh-enterprise-sweep-'))
    homes.push(home)
    return home
  }

  async function generation(home: string, id: string): Promise<string> {
    const directory = join(enterpriseGenerationLayout(home).generations, id)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'index.js'), 'export {}\n')
    return directory
  }

  async function account(home: string, name: string, installed: readonly { generation_id: string; enabled?: boolean }[]): Promise<void> {
    const directory = enterpriseGenerationLayout(home).market
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, name), JSON.stringify({
      installed,
      tombstones: [{ plugin_id: 'a'.repeat(32), version_id: 'b'.repeat(32), status: 'uninstalled', revision: 1 }]
    }))
  }

  afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
  })

  it('removes an uninstalled generation and keeps installed and disabled ones', async () => {
    const home = await freshHome()
    await generation(home, keptId)
    await generation(home, disabledId)
    await generation(home, droppedId)
    await account(home, 'account-a.json', [
      { generation_id: keptId, enabled: true },
      { generation_id: disabledId, enabled: false }
    ])
    await writeFile(join(enterpriseGenerationLayout(home).market, 'operations.jsonl'), '{"action":"uninstall"}\n')

    const result = await sweepEnterpriseGenerations(home)
    const layout = enterpriseGenerationLayout(home)

    expect(result.skipped).toBe(false)
    expect(result.failed).toEqual([])
    expect(result.removed).toContain(droppedId)
    expect(existsSync(join(layout.generations, keptId))).toBe(true)
    expect(existsSync(join(layout.generations, disabledId))).toBe(true)
    expect(existsSync(join(layout.generations, droppedId))).toBe(false)
    expect(await readFile(join(layout.market, 'operations.jsonl'), 'utf8')).toContain('uninstall')
    expect(JSON.parse(await readFile(join(layout.market, 'account-a.json'), 'utf8')).tombstones).toHaveLength(1)
  })

  it('keeps a generation still installed by another enterprise account', async () => {
    const home = await freshHome()
    await generation(home, otherAccountId)
    await account(home, 'account-a.json', [])
    await account(home, 'account-b.json', [{ generation_id: otherAccountId }])

    const result = await sweepEnterpriseGenerations(home)

    expect(result.removed).not.toContain(otherAccountId)
    expect(existsSync(join(enterpriseGenerationLayout(home).generations, otherAccountId))).toBe(true)
  })

  it('removes the previous generation after an update publishes a new id', async () => {
    const home = await freshHome()
    await generation(home, previousId)
    await generation(home, nextId)
    await account(home, 'account-a.json', [{ generation_id: nextId }])

    const result = await sweepEnterpriseGenerations(home)
    const layout = enterpriseGenerationLayout(home)

    expect(result.removed).toContain(previousId)
    expect(existsSync(join(layout.generations, previousId))).toBe(false)
    expect(existsSync(join(layout.generations, nextId))).toBe(true)
  })

  it('clears enterprise staging leftovers on a cold start', async () => {
    const home = await freshHome()
    const staging = join(enterpriseGenerationLayout(home).staging, 'company-demo+1.0.0+abandoned')
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'partial.js'), 'export {}\n')

    const result = await sweepEnterpriseGenerations(home)

    expect(result.removed).toContain('staging/company-demo+1.0.0+abandoned')
    expect(existsSync(staging)).toBe(false)
  })

  it('deletes nothing when an account document cannot be read', async () => {
    const home = await freshHome()
    await generation(home, droppedId)
    const market = enterpriseGenerationLayout(home).market
    await mkdir(market, { recursive: true })
    await writeFile(join(market, 'account-a.json'), '{not-json\n')

    const result = await sweepEnterpriseGenerations(home)

    expect(result).toEqual({ removed: [], failed: [], skipped: true })
    expect(existsSync(join(enterpriseGenerationLayout(home).generations, droppedId))).toBe(true)
  })

  it('deletes nothing when an account document is a symlink', async () => {
    const home = await freshHome()
    await generation(home, droppedId)
    const layout = enterpriseGenerationLayout(home)
    const target = join(home, 'linked-account.json')
    await mkdir(layout.market, { recursive: true })
    await writeFile(target, JSON.stringify({ installed: [{ generation_id: droppedId }] }))
    await symlink(target, join(layout.market, 'account-a.json'))

    const result = await sweepEnterpriseGenerations(home)

    expect(result).toEqual({ removed: [], failed: [], skipped: true })
    expect(existsSync(join(layout.generations, droppedId))).toBe(true)
    expect(await readFile(target, 'utf8')).toContain(droppedId)
  })

  it('unlinks a generation symlink without deleting its target', async () => {
    const home = await freshHome()
    const outside = join(home, 'outside-plugin')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'keep.txt'), 'still here\n')
    const link = join(enterpriseGenerationLayout(home).generations, droppedId)
    await mkdir(enterpriseGenerationLayout(home).generations, { recursive: true })
    await symlink(outside, link)

    const result = await sweepEnterpriseGenerations(home)

    expect(result.removed).toContain(droppedId)
    expect(existsSync(link)).toBe(false)
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('still here\n')
  })

  it('leaves an unreferenced directory in trash when deletion is blocked, then removes it next launch', async () => {
    const home = await freshHome()
    await generation(home, droppedId)
    const layout = enterpriseGenerationLayout(home)
    const actualRemoveTree = removeTreeModule.removeTree
    const blocked = vi.spyOn(removeTreeModule, 'removeTree').mockImplementation(async (path) => {
      if (String(path).includes('.enterprise-trash')) {
        throw Object.assign(new Error('simulated locked generation'), { code: 'EPERM' })
      }
      return actualRemoveTree(path)
    })
    try {
      const first = await sweepEnterpriseGenerations(home)

      expect(first.removed).not.toContain(droppedId)
      expect(first.failed).toContain(droppedId)
      expect(existsSync(join(layout.generations, droppedId))).toBe(false)
      const trashNames = await readdir(layout.trash)
      expect(trashNames).toHaveLength(1)
      const trashedName = trashNames[0]
      expect(trashedName?.startsWith(`${droppedId}.`)).toBe(true)
      blocked.mockRestore()
      if (trashedName === undefined) throw new Error('expected a trashed generation')

      const second = await sweepEnterpriseGenerations(home)

      expect(second.failed).toEqual([])
      expect(second.removed).toContain(`trash/${trashedName}`)
      expect(await readdir(layout.trash)).toEqual([])
    } finally {
      blocked.mockRestore()
    }
  })

  it('sweeps an uninstalled enterprise generation during launch preparation', async () => {
    const home = await freshHome()
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } }
    }))
    await generation(home, droppedId)
    await account(home, 'account-a.json', [])
    const notes: string[] = []

    await prepareGenerationsForLaunch(home, (line) => { notes.push(line) })

    expect(existsSync(join(enterpriseGenerationLayout(home).generations, droppedId))).toBe(false)
    expect(notes).toContain('[desktop] swept 1 unreferenced enterprise generation(s)')
  })
})
