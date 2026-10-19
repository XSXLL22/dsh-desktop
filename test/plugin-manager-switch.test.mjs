import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginManager } from '@deepseek-ai/dsh-plugin-manager'
import { createGenerationPackageBackend } from '../packages/dsh-desktop-market-installer/generations/package-backend.mjs'
import { readDisabledPlugins } from '../packages/dsh-desktop-market-installer/plugin-state.mjs'

const roots = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

/** A web Profile with one installed community bundle, as launch projection leaves it. */
async function profileWithBundle() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-manager-switch-'))
  roots.push(home)
  const dir = join(home, 'profiles', 'web')
  const plugin = join(dir, 'node_modules', 'demo-plugin')
  await mkdir(plugin, { recursive: true })
  await writeFile(join(plugin, 'package.json'), JSON.stringify({
    name: 'demo-plugin', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } }
  }))
  await writeFile(join(plugin, 'cordis.patch.yml'), '- insert:\n  - id: demo-row\n    name: demo-plugin\n')
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    dependencies: { 'demo-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['demo-plugin'] } }
  }))
  return { home, dir }
}

/** Only the manager state the exercised methods read; the rest of Harness is not needed. */
function managerFor(home, dir) {
  const backend = createGenerationPackageBackend({
    dshHome: home,
    nodeExecutablePath: process.execPath,
    pnpmEntryPath: 'unused'
  })
  const services = new Map([['profileBundlePackageBackend', backend]])
  return {
    profile: { dir, name: 'web', installAnchor: resolve('node_modules/@deepseek-ai/dsh/package.json') },
    ownerContext: { get: name => services.get(name) },
    managementBundles: new Set(),
    protectsManager: () => false,
    declaredRows: () => ({ rows: [], overrides: [] }),
    bundleRows: () => [{ id: 'demo-row', name: 'demo-plugin' }]
  }
}

describe('Plugin Manager package switch', () => {
  it('lists a bundle the market switched off as disabled although it stays composable', async () => {
    const { home, dir } = await profileWithBundle()
    const manager = managerFor(home, dir)
    const listed = async () => (await PluginManager.prototype.listBundles.call(manager))
      .find(bundle => bundle.name === 'demo-plugin')

    expect(await listed()).toMatchObject({ enabled: true, installed: true })
    await mkdir(join(dir, '.dsh-market'), { recursive: true })
    await writeFile(join(dir, '.dsh-market', 'state.json'), JSON.stringify({ disabled: ['demo-plugin'], groups: [] }))
    expect(await listed()).toMatchObject({ enabled: false, installed: true })
  })

  it('persists its own toggle where launch reconciliation cannot revert it', async () => {
    const { home, dir } = await profileWithBundle()
    await writeFile(join(dir, 'cordis.patch.yml'), '- id: demo-row\n  disabled: false\n')
    const manager = managerFor(home, dir)

    await PluginManager.prototype.recordBundleSwitch.call(manager, 'demo-plugin', false)
    expect(await readDisabledPlugins(dir)).toEqual(['demo-plugin'])
    // The user's force-enable for the package's own row would contradict the switch.
    expect(await readFile(join(dir, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')

    await PluginManager.prototype.recordBundleSwitch.call(manager, 'demo-plugin', true)
    expect(await readDisabledPlugins(dir)).toEqual([])
    const state = JSON.parse(await readFile(join(dir, '.dsh-market', 'state.json'), 'utf8'))
    expect(state).toEqual({ disabled: [] })
  })

  it('keeps market-owned fields when recording a switch', async () => {
    const { home, dir } = await profileWithBundle()
    await mkdir(join(dir, '.dsh-market'), { recursive: true })
    await writeFile(join(dir, '.dsh-market', 'state.json'), JSON.stringify({ disabled: [], groups: [{ id: 'g' }] }))
    await PluginManager.prototype.recordBundleSwitch.call(managerFor(home, dir), 'demo-plugin', false)
    expect(JSON.parse(await readFile(join(dir, '.dsh-market', 'state.json'), 'utf8')))
      .toEqual({ disabled: ['demo-plugin'], groups: [{ id: 'g' }] })
  })

  it('refuses a network enable before the profile manifest or switch record changes', async () => {
    const { home, dir } = await profileWithBundle()
    const before = await readFile(join(dir, 'package.json'), 'utf8')
    const selectBundle = vi.fn()
    const recordBundleSwitch = vi.fn()
    const manager = {
      ...managerFor(home, dir),
      change: async (operation) => operation({}),
      configure: async (operation) => operation(),
      selectBundle,
      recordBundleSwitch,
      ownerContext: {
        get: () => ({
          authorizeSwitch: async () => {
            throw new Error('POLICY_DISABLED: current enterprise has not opened network plugin installation.')
          }
        })
      }
    }

    await expect(PluginManager.prototype.setBundleEnabled.call(manager, 'demo-plugin', true))
      .rejects.toThrow('POLICY_DISABLED')
    expect(selectBundle).not.toHaveBeenCalled()
    expect(recordBundleSwitch).not.toHaveBeenCalled()
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(before)
  })

  it('turns on the official schedule bundle when activation is waiting only for that service', async () => {
    const { home, dir } = await profileWithBundle()
    const scheduleWarning = new Error('dsh: warning: 1 entry did not activate\ndemo-plugin (demo-plugin): pending (waiting for service: schedule)\n')
    const reload = vi.fn().mockRejectedValueOnce(scheduleWarning).mockResolvedValueOnce([])
    const selectBundle = vi.fn(async () => undefined)
    const recordBundleSwitch = vi.fn(async () => undefined)
    const authorizeSwitch = vi.fn(async () => undefined)
    const manager = {
      ...managerFor(home, dir),
      change: async (operation) => operation({}),
      configure: async (operation) => operation(),
      reload,
      selectBundle,
      recordBundleSwitch,
      bundleRows: (name) => [{ id: `${name}-row` }],
      ownerContext: { get: () => ({ authorizeSwitch }) }
    }

    await PluginManager.prototype.setBundleEnabled.call(manager, 'demo-plugin', true)
    expect(authorizeSwitch).toHaveBeenCalledWith({ name: '@deepseek-ai/dsh-experimental-schedule-bundle', enabled: true })
    expect(selectBundle).toHaveBeenNthCalledWith(1, 'demo-plugin', true)
    expect(selectBundle).toHaveBeenNthCalledWith(2, '@deepseek-ai/dsh-experimental-schedule-bundle', true)
    expect(recordBundleSwitch).toHaveBeenNthCalledWith(2, '@deepseek-ai/dsh-experimental-schedule-bundle', true)
    expect(reload).toHaveBeenNthCalledWith(2, ['demo-plugin-row', '@deepseek-ai/dsh-experimental-schedule-bundle-row'])
  })

  it('keeps a disable that only leaves another plugin waiting for schedule', async () => {
    const { home, dir } = await profileWithBundle()
    const scheduleWarning = new Error('dsh: warning: 1 entry did not activate\ndeepseek-harness-daily (deepseek-harness-daily): pending (waiting for service: schedule)\n')
    const selectBundle = vi.fn(async () => undefined)
    const recordBundleSwitch = vi.fn(async () => undefined)
    const manager = {
      ...managerFor(home, dir),
      change: async (operation) => operation({}),
      configure: async (operation) => operation(),
      reload: vi.fn().mockRejectedValue(scheduleWarning),
      selectBundle,
      recordBundleSwitch,
      ownerContext: { get: () => ({ authorizeSwitch: async () => undefined }) }
    }

    await PluginManager.prototype.setBundleEnabled.call(manager, '@deepseek-ai/dsh-experimental-schedule-bundle', false)
    expect(selectBundle).toHaveBeenCalledTimes(1)
    expect(selectBundle).toHaveBeenCalledWith('@deepseek-ai/dsh-experimental-schedule-bundle', false)
    expect(recordBundleSwitch).toHaveBeenCalledWith('@deepseek-ai/dsh-experimental-schedule-bundle', false)
  })

  it('keeps the schedule bundle enabled when other plugins are only waiting for it', async () => {
    const { home, dir } = await profileWithBundle()
    const schedule = '@deepseek-ai/dsh-experimental-schedule-bundle'
    const scheduleWarning = new Error('dsh: warning: 1 entry did not activate\ndeepseek-harness-daily (deepseek-harness-daily): pending (waiting for service: schedule)\n')
    const selectBundle = vi.fn(async () => undefined)
    const recordBundleSwitch = vi.fn(async () => undefined)
    const manager = {
      ...managerFor(home, dir),
      change: async (operation) => operation({}),
      configure: async (operation) => operation(),
      reload: vi.fn().mockRejectedValue(scheduleWarning),
      selectBundle,
      recordBundleSwitch,
      ownerContext: { get: () => ({ authorizeSwitch: async () => undefined }) }
    }

    await PluginManager.prototype.setBundleEnabled.call(manager, schedule, true)
    expect(selectBundle.mock.calls).toEqual([[schedule, true]])
    expect(recordBundleSwitch.mock.calls).toEqual([[schedule, true]])
  })

  it('keeps an activation failure that is not only the schedule service', async () => {
    const { home, dir } = await profileWithBundle()
    const warning = new Error('dsh: warning: 1 entry did not activate\ndemo-plugin (demo-plugin): pending (waiting for service: llm)\n')
    const selectBundle = vi.fn(async () => undefined)
    const recordBundleSwitch = vi.fn(async () => undefined)
    const manager = {
      ...managerFor(home, dir),
      change: async (operation) => operation({}),
      configure: async (operation) => operation(),
      reload: vi.fn().mockRejectedValue(warning),
      selectBundle,
      recordBundleSwitch,
      ownerContext: { get: () => ({ authorizeSwitch: async () => undefined }) }
    }

    await expect(PluginManager.prototype.setBundleEnabled.call(manager, 'demo-plugin', true)).rejects.toThrow('waiting for service: llm')
    expect(selectBundle).toHaveBeenNthCalledWith(1, 'demo-plugin', true)
    expect(selectBundle).toHaveBeenLastCalledWith('demo-plugin', true)
    expect(recordBundleSwitch).toHaveBeenLastCalledWith('demo-plugin', true)
  })

  it('enables a bundle after the preflight allows it', async () => {
    const { home, dir } = await profileWithBundle()
    const authorizeSwitch = vi.fn(async () => undefined)
    const manager = managerFor(home, dir)
    manager.change = async (operation) => operation({})
    manager.configure = async (operation) => operation()
    manager.reload = async () => []
    manager.selectBundle = PluginManager.prototype.selectBundle
    manager.recordBundleSwitch = PluginManager.prototype.recordBundleSwitch
    manager.ownerContext = { get: () => ({ authorizeSwitch, switched: async () => undefined }) }

    await PluginManager.prototype.setBundleEnabled.call(manager, 'demo-plugin', false)
    expect(authorizeSwitch).not.toHaveBeenCalled()
    await PluginManager.prototype.setBundleEnabled.call(manager, 'demo-plugin', true)
    expect(authorizeSwitch).toHaveBeenCalledWith({ name: 'demo-plugin', enabled: true })
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    expect(manifest.dsh.profile.bundles).toContain('demo-plugin')
  })

  it('refuses a network spec before asking a registry and still inspects a local path', async () => {
    const { home, dir } = await profileWithBundle()
    const local = join(home, 'local-only')
    await mkdir(local)
    await writeFile(join(local, 'package.json'), JSON.stringify({
      name: 'local-only', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } }
    }))
    const registries = vi.fn(async () => ({
      registry: 'https://registry.npmjs.org/',
      fallbackRegistries: [],
      resolved: 'https://registry.npmjs.org/'
    }))
    const closed = {
      ownerContext: {
        get: () => ({
          authorizeSpec: async () => ({
            status: 'refused',
            problem: 'unknown',
            reason: 'POLICY_DISABLED: current enterprise has not opened network plugin installation.',
            registries: []
          })
        })
      },
      registries,
      profile: { dir, installAnchor: resolve('node_modules/@deepseek-ai/dsh/package.json') }
    }
    await expect(PluginManager.prototype.inspect.call(closed, 'demo-plugin')).resolves.toMatchObject({
      status: 'refused',
      problem: 'unknown'
    })
    expect(registries).not.toHaveBeenCalled()

    const open = {
      ...closed,
      ownerContext: { get: () => ({ authorizeSpec: async () => undefined }) }
    }
    await expect(PluginManager.prototype.inspect.call(open, local)).resolves.toMatchObject({
      status: 'accepted',
      kind: 'path',
      name: 'local-only'
    })
    expect(registries).toHaveBeenCalledTimes(1)
  })

  it('rolls the target switch back when opening the schedule bundle is refused', async () => {
    const { home, dir } = await profileWithBundle()
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      dependencies: { 'demo-plugin': '1.0.0' },
      dsh: { profile: { bundles: [] } }
    }))
    await mkdir(join(dir, '.dsh-market'), { recursive: true })
    await writeFile(join(dir, '.dsh-market', 'state.json'), JSON.stringify({ disabled: ['demo-plugin'] }))
    const scheduleWarning = new Error('dsh: warning: 1 entry did not activate\ndemo-plugin (demo-plugin): pending (waiting for service: schedule)\n')
    const selectBundle = vi.fn(async () => undefined)
    const recordBundleSwitch = vi.fn(async () => undefined)
    const manager = {
      ...managerFor(home, dir),
      change: async (operation) => operation({}),
      configure: async (operation) => operation(),
      reload: vi.fn().mockRejectedValue(scheduleWarning),
      selectBundle,
      recordBundleSwitch,
      bundleRows: () => [{ id: 'demo-row' }],
      ownerContext: {
        get: () => ({
          authorizeSwitch: async ({ name }) => {
            if (name === '@deepseek-ai/dsh-experimental-schedule-bundle') throw new Error('POLICY_DISABLED')
          }
        })
      }
    }

    await expect(PluginManager.prototype.setBundleEnabled.call(manager, 'demo-plugin', true)).rejects.toThrow('waiting for service: schedule')
    expect(selectBundle.mock.calls).toEqual([['demo-plugin', true], ['demo-plugin', false]])
    expect(recordBundleSwitch.mock.calls).toEqual([['demo-plugin', true], ['demo-plugin', false]])
  })

  it('returns the real failed change and restores both switches when the second reload fails', async () => {
    const { home, dir } = await profileWithBundle()
    const schedule = '@deepseek-ai/dsh-experimental-schedule-bundle'
    const scheduleDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh-experimental-schedule-bundle')
    await mkdir(scheduleDir, { recursive: true })
    await writeFile(join(scheduleDir, 'package.json'), JSON.stringify({
      name: schedule, version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } }
    }))
    await writeFile(join(scheduleDir, 'cordis.patch.yml'), '- insert:\n  - id: schedule-row\n    name: schedule\n')
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      dependencies: { 'demo-plugin': '1.0.0', [schedule]: '1.0.0' },
      dsh: { profile: { bundles: [] } }
    }))
    await mkdir(join(dir, '.dsh-market'), { recursive: true })
    await writeFile(join(dir, '.dsh-market', 'state.json'), JSON.stringify({ disabled: ['demo-plugin'], groups: [{ id: 'g' }] }))
    const scheduleWarning = new Error('dsh: warning: 1 entry did not activate\ndemo-plugin (demo-plugin): pending (waiting for service: schedule)\n')
    const later = new Error('dsh: warning: 1 entry did not activate\ndemo-plugin (demo-plugin): failed (import failed)\n')
    const backend = managerFor(home, dir).ownerContext.get('profileBundlePackageBackend')
    const manager = {
      ...managerFor(home, dir),
      abort: new AbortController(),
      lockWaitMs: 1000,
      change: PluginManager.prototype.change,
      configure: PluginManager.prototype.configure,
      diskState: PluginManager.prototype.diskState,
      selectBundle: PluginManager.prototype.selectBundle,
      recordBundleSwitch: PluginManager.prototype.recordBundleSwitch,
      reload: vi.fn().mockRejectedValueOnce(scheduleWarning).mockRejectedValueOnce(later),
      bundleRows: () => [{ id: 'demo-row' }],
      ownerContext: {
        emit: () => undefined,
        get: (name) => name === 'profileBundlePackageBackend'
          ? { ...backend, authorizeSwitch: async () => undefined }
          : undefined
      }
    }

    const result = await PluginManager.prototype.setBundleEnabled.call(manager, 'demo-plugin', true)
    expect(result).toMatchObject({ application: 'failed', error: { code: 'operation-error' } })
    expect(result.error.diagnostic).toContain('import failed')
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    expect(manifest.dsh.profile.bundles).toEqual([])
    expect(JSON.parse(await readFile(join(dir, '.dsh-market', 'state.json'), 'utf8')))
      .toEqual({ disabled: ['demo-plugin'], groups: [{ id: 'g' }] })
  })
})
