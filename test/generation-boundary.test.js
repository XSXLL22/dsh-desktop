import { readFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'

function readInstalledVersion(_profile, name, explicitDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(explicitDir, 'node_modules', name, 'package.json'), 'utf8'))
    return manifest.version ?? null
  } catch {
    return null
  }
}
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDesktopPnpmService } from '../packages/dsh-desktop-market-installer/index.js'
import { installGeneration } from '../packages/dsh-desktop-market-installer/generations/installer.mjs'
import { projectGenerations, publishInstalledGeneration } from '../packages/dsh-desktop-market-installer/generations/projection.mjs'
import {
  listGenerations,
  readDesired,
  writeDesired
} from '../packages/dsh-desktop-market-installer/generations/registry.mjs'

const renameFault = vi.hoisted(() => ({ phase: '' }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal()
  return { ...fs, unlink: async path => {
    if (renameFault.phase === 'old-link' && process.platform === 'win32') {
      renameFault.phase = ''
      throw Object.assign(new Error('EPERM: simulated occupied junction'), { code: 'EPERM' })
    }
    return fs.unlink(path)
  }, rename: async (from, to) => {
    const matches = renameFault.phase === 'old-link' ? String(to).includes('.dsh-previous-')
      : renameFault.phase === 'new-link' ? String(from).includes('.dsh-next-')
      : renameFault.phase === 'manifest' ? String(to).replaceAll('\\', '/').endsWith('/profiles/web/package.json') : false
    if (matches) {
      renameFault.phase = ''
      throw Object.assign(new Error('EPERM: simulated occupied path'), { code: 'EPERM' })
    }
    return fs.rename(from, to)
  } }
})

/**
 * The enterprise edition rejects community install and update at this boundary.
 * Generation publication and removal stay covered through the installer and
 * `runPlugin`, which are still reachable.
 */
describe('the market install boundary', () => {
  const homes = []

  async function freshHome() {
    const home = await mkdtemp(join(tmpdir(), 'dsh-boundary-'))
    homes.push(home)
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(
      join(home, 'profiles', 'web', 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: { dshmarket: '^1.35.0' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket'] } }
      })
    )
    return home
  }

  afterEach(async () => {
    renameFault.phase = ''
    await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })))
    homes.length = 0
  })

  function drainHandle(handle) {
    let stdout = ''
    let stderr = ''
    handle.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    handle.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    return handle.done.then(({ exitCode }) => ({ exitCode, stdout, stderr }))
  }

  /** A stub that populates a staging node_modules the way pnpm would. */
  function stubGenerationInstall(pluginName, version) {
    return async (stagingDir) => {
      const pkg = join(stagingDir, 'node_modules', pluginName)
      await mkdir(pkg, { recursive: true })
      await writeFile(
        join(pkg, 'package.json'),
        JSON.stringify({ name: pluginName, version, dsh: { bundle: { patch: 'cordis.patch.yml' } } })
      )
      await writeFile(join(pkg, 'cordis.patch.yml'), '[]\n')
      await writeFile(join(stagingDir, 'pnpm-lock.yaml'), `lock-${pluginName}-${version}\n`)
      return { code: 0, output: 'Done in 3.1s' }
    }
  }

  function service(home, runGenerationInstall) {
    return createDesktopPnpmService({
      binDirectory: join(home, '.desktop-bin'),
      dshEntryPath: join(home, 'bin.js'),
      executablePath: process.execPath,
      home,
      runGenerationInstall
    })
  }

  async function seedProjectedPlugin(home, pluginName, version) {
    const installed = await installGeneration({
      dshHome: home,
      pluginSpec: `${pluginName}@${version}`,
      nodeExecutablePath: process.execPath,
      pnpmEntryPath: 'unused',
      runInstall: stubGenerationInstall(pluginName, version)
    })
    expect(installed.ok).toBe(true)
    await writeDesired(home, [installed.generation.id])
    await projectGenerations(home)
    return installed.generation
  }

  it('exposes the boundary method dsh-market feature-detects', () => {
    const svc = createDesktopPnpmService({
      binDirectory: '/tmp/bin',
      dshEntryPath: '/tmp/bin.js',
      home: '/tmp/home'
    })
    expect(typeof svc.runExternalMarketPluginInstall).toBe('function')
  })

  it('rejects community install and update before a package operation starts', async () => {
    const home = await freshHome()
    const profile = join(home, 'profiles', 'web')
    const before = await readFile(join(profile, 'package.json'), 'utf8')
    const calls = []
    const svc = createDesktopPnpmService({
      binDirectory: join(home, '.desktop-bin'),
      dshEntryPath: join(home, 'bin.js'),
      executablePath: process.execPath,
      home,
      spawnProcess: () => {
        calls.push('spawn')
        throw new Error('spawned')
      },
      runGenerationInstall: async () => {
        calls.push('install')
        return { code: 0, output: '' }
      }
    })

    expect(() => svc.runExternalMarketPluginInstall(['add', 'demo-plugin@1.2.4'], profile)).toThrow('POLICY_DISABLED')
    expect(() => svc.runExternalMarketPluginInstall(['add', 'dshmarket@1.45.1'], profile)).toThrow('POLICY_DISABLED')
    expect(() => svc.runPlugin(['add', 'demo-plugin@1.2.4'], profile)).toThrow('POLICY_DISABLED')
    expect(() => svc.runPlugin(['update', 'demo-plugin'], profile)).toThrow('POLICY_DISABLED')
    expect(() => svc.runPlugin(['upgrade', 'demo-plugin'], profile)).toThrow('POLICY_DISABLED')
    expect(calls).toEqual([])
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(before)
    expect(await readDesired(home)).toEqual([])
  })

  it('routes a market removal through desired.json instead of the shared profile CLI', async () => {
    const home = await freshHome()
    await seedProjectedPlugin(home, 'demo-plugin', '9.9.9')
    const link = join(home, 'profiles', 'web', 'node_modules', 'demo-plugin')
    const activeTarget = await readlink(link)
    const svc = service(home, async () => {
      throw new Error('community removal must not spawn a package install')
    })

    const result = await drainHandle(
      svc.runPlugin(['remove', '--workspace-root', 'demo-plugin'], join(home, 'profiles', 'web'))
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Disabling demo-plugin generation for the next restart')
    expect(await readDesired(home)).toEqual([])
    const manifest = JSON.parse(await readFile(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
    expect(manifest.dependencies['demo-plugin']).toBeUndefined()
    expect(manifest.pnpm?.overrides?.['demo-plugin']).toBeUndefined()
    expect(manifest.dsh.profile.bundles).not.toContain('demo-plugin')
    expect(await readlink(link)).toBe(activeTarget)

    await projectGenerations(home)
    await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' })
    const inactiveManifest = JSON.parse(
      await readFile(join(home, 'profiles', 'web', 'package.json'), 'utf8')
    )
    expect(inactiveManifest.dsh.profile.bundles).not.toContain('demo-plugin')
  })

  it('rolls back a cold-start directory replacement if manifest publication fails', async () => {
    const home = await freshHome()
    const profile = join(home, 'profiles/web')
    // A legacy plugin installed as a real directory, being moved onto a
    // generation for the first time. (Never dshmarket: that one is pinned to
    // the shared tree and is filtered out of generation resolution.)
    const legacy = join(profile, 'node_modules/widget')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'package.json'), JSON.stringify({ name: 'widget', version: '1.39.0' }))
    const before = await readFile(join(profile, 'package.json'), 'utf8')
    const installed = await installGeneration({
      dshHome: home, pluginSpec: 'widget@1.45.1', nodeExecutablePath: process.execPath,
      pnpmEntryPath: 'unused', runInstall: stubGenerationInstall('widget', '1.45.1')
    })
    await writeDesired(home, [installed.generation.id])
    renameFault.phase = 'manifest'
    await expect(publishInstalledGeneration(home, 'widget', 'web', { allowRealDirectory: true, syncBundles: true })).rejects.toThrow('EPERM')
    expect((await lstat(legacy)).isSymbolicLink()).toBe(false)
    expect(readInstalledVersion('web', 'widget', profile)).toBe('1.39.0')
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(before)
    await publishInstalledGeneration(home, 'widget', 'web', { allowRealDirectory: true, syncBundles: true })
    expect(readInstalledVersion('web', 'widget', profile)).toBe('1.45.1')
  })

  it('stages an exact copy of an installed external source and records its provenance', async () => {
    const home = await freshHome()
    const source = join(home, 'legacy-source-plugin')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'source-plugin', version: '1.2.3' }))
    await writeFile(join(source, 'installed-marker.txt'), 'exact installed tree\n')

    const result = await installGeneration({
      dshHome: home,
      pluginSpec: 'github:example/source-plugin#main',
      expectedPluginName: 'source-plugin',
      sourceSpec: 'github:example/source-plugin#main',
      sourceDirectory: source,
      nodeExecutablePath: process.execPath,
      pnpmEntryPath: 'unused',
      runInstall: async (stagingDir) => {
        expect(await readFile(join(stagingDir, 'source', 'source-plugin', 'installed-marker.txt'), 'utf8'))
          .toBe('exact installed tree\n')
        return stubGenerationInstall('source-plugin', '1.2.3')(stagingDir)
      }
    })

    expect(result.ok).toBe(true)
    expect(await listGenerations(home)).toEqual([
      expect.objectContaining({
        pluginName: 'source-plugin',
        version: '1.2.3',
        sourceSpec: 'github:example/source-plugin#main'
      })
    ])
  })
})
