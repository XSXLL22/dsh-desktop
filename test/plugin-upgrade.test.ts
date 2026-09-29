import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const installMock = vi.hoisted(() => vi.fn())
vi.mock('../src/main/runtime/profile-plugin-command', () => ({
  installProfileDependenciesWithDsh: installMock
}))

const { upgradeMarketInSharedTree } = await import('../src/main/state/plugin-upgrade')

const homes: string[] = []
afterEach(async () => {
  installMock.mockReset()
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-plugin-upgrade-'))
  homes.push(home)
  const profile = join(home, 'profiles', 'web')
  const market = join(profile, 'node_modules', 'dshmarket')
  await mkdir(market, { recursive: true })
  await writeFile(join(market, 'package.json'), JSON.stringify({ name: 'dshmarket', version: '1.39.0' }))
  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify({
      dependencies: { dshmarket: '1.39.0' },
      dsh: { profile: { bundles: ['dshmarket'] } }
    })
  )
  const options = {
    dshHome: home,
    dshEntryPath: '/unused/dsh',
    targetVersion: '1.45.1',
    nodeExecutablePath: process.execPath,
    pnpmEntryPath: '/unused/pnpm',
    pnpmRunnerPath: '/unused/pnpm-runner.mjs'
  }
  return { home, profile, market, options }
}

describe('upgradeMarketInSharedTree', () => {
  it('rejects community market upgrades before touching the profile', async () => {
    const { profile, options } = await fixture()
    const before = await readFile(join(profile, 'package.json'), 'utf8')
    const result = await upgradeMarketInSharedTree(options)
    expect(result).toEqual({ ok: false, detail: 'POLICY_DISABLED' })
    expect(installMock).not.toHaveBeenCalled()
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(before)
  })

  it.each(['missing', 'unchanged'])('rejects a zero-exit install with an %s active package', async state => {
    const { profile, market, options } = await fixture()
    const before = await readFile(join(profile, 'package.json'), 'utf8')
    if (state === 'missing') await rm(market, { recursive: true })
    installMock.mockResolvedValue({ ok: true })
    expect((await upgradeMarketInSharedTree(options)).ok).toBe(false)
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(before)
  })
  it('does not let a community baseline resume a partial market install', async () => {
    const { ensureMarketBaseline } = await import('../src/main/state/market-baseline')
    const { profile, options } = await fixture()
    const before = await readFile(join(profile, 'package.json'), 'utf8')
    await expect(ensureMarketBaseline({
      ...options,
      dshEntryPath: resolve('node_modules/@deepseek-ai/dsh/lib/bin.js')
    })).rejects.toThrow('POLICY_DISABLED')
    expect(installMock).not.toHaveBeenCalled()
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(before)
  })
})
