import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createEnterpriseCapabilityPolicy,
  writePersistedThirdPartyPolicy
} from '../packages/dsh-desktop-market-installer/enterprise-policy.mjs'
import { consumeLocalWorkbenchCapability } from '../packages/dsh-desktop-workbenches/local-install.mjs'

describe('enterprise capability policy service', () => {
  it('rejects when no resolver is registered and after it is removed', async () => {
    const policy = createEnterpriseCapabilityPolicy()
    await expect(policy.authorizePluginMutation()).rejects.toThrow('POLICY_DISABLED')
    let calls = 0
    const dispose = policy.registerResolver(async () => {
      calls += 1
      return {
        connected: true,
        connectionKey: 'tenant-a',
        authoritative: true,
        allowThirdPartyPlugins: true,
        allowThirdPartyWorkbenches: false
      }
    })
    await policy.refresh('tenant-a')
    expect(calls).toBe(1)
    await policy.refresh('tenant-a')
    expect(calls).toBe(1)
    dispose()
    await expect(policy.authorizePluginMutation()).rejects.toThrow('POLICY_DISABLED')
  })

  it('drops a response from the previous tenant and closes when the read fails', async () => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const policy = createEnterpriseCapabilityPolicy()
    policy.registerResolver(async () => {
      await gate
      return { connected: true, connectionKey: 'old', allowThirdPartyPlugins: true, allowThirdPartyWorkbenches: true }
    })
    const first = policy.refresh('old')
    policy.reset()
    release()
    await first
    expect(policy.snapshot().allowThirdPartyPlugins).toBe(false)
    policy.registerResolver(async () => { throw new Error('offline') })
    await policy.refresh('new')
    expect(policy.snapshot()).toMatchObject({ allowThirdPartyPlugins: false, allowThirdPartyWorkbenches: false, authoritative: true })
  })

  it('keeps an authorization that overlaps a forced refresh for the same tenant', async () => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    let calls = 0
    const policy = createEnterpriseCapabilityPolicy()
    policy.registerResolver(async () => {
      calls += 1
      if (calls > 1) await gate
      return {
        connected: true,
        connectionKey: 'tenant-a',
        allowThirdPartyPlugins: true,
        allowThirdPartyWorkbenches: false
      }
    })
    await policy.refresh('tenant-a')
    const refresh = policy.refresh('tenant-a', { force: true })
    const authorize = policy.authorizePluginMutation()
    release()
    await authorize
    await refresh
    expect(calls).toBe(2)
    expect(policy.snapshot().allowThirdPartyPlugins).toBe(true)
  })

  it('shares one live read across concurrent authorizations', async () => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    let calls = 0
    const policy = createEnterpriseCapabilityPolicy()
    policy.registerResolver(async () => {
      calls += 1
      await gate
      return {
        connected: true,
        connectionKey: 'tenant-a',
        allowThirdPartyPlugins: true,
        allowThirdPartyWorkbenches: true
      }
    })
    const first = policy.authorizePluginMutation()
    const second = policy.authorizeWorkbenchMarketInstall()
    release()
    await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(policy.snapshot()).toMatchObject({ allowThirdPartyPlugins: true, allowThirdPartyWorkbenches: true })
  })

  it('drops an authorization when the tenant is reset and stays closed when the read fails', async () => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const policy = createEnterpriseCapabilityPolicy()
    policy.registerResolver(async () => {
      await gate
      return { connected: true, connectionKey: 'tenant-a', allowThirdPartyPlugins: true, allowThirdPartyWorkbenches: true }
    })
    const pending = policy.authorizePluginMutation()
    policy.reset()
    release()
    await expect(pending).rejects.toThrow('POLICY_DISABLED')
    expect(policy.snapshot().allowThirdPartyPlugins).toBe(false)
    policy.registerResolver(async () => { throw new Error('offline') })
    await expect(policy.authorizePluginMutation()).rejects.toThrow('POLICY_DISABLED')
    expect(policy.snapshot()).toMatchObject({ allowThirdPartyPlugins: false, allowThirdPartyWorkbenches: false, authoritative: true })
  })

  it('writes one third-party policy file when persistence overlaps', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-third-party-policy-'))
    try {
      const writes = []
      for (let index = 0; index < 16; index += 1) {
        writes.push(writePersistedThirdPartyPolicy(home, {
          allowThirdPartyPlugins: index % 2 === 0,
          allowThirdPartyWorkbenches: index % 3 === 0
        }))
      }
      await Promise.all(writes)
      const directory = join(home, 'profiles', 'web', '.dsh-desktop')
      const saved = JSON.parse(await readFile(join(directory, 'third-party-policy.json'), 'utf8'))
      expect(saved).toEqual({
        allowThirdPartyPlugins: false,
        allowThirdPartyWorkbenches: true
      })
      expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('coalesces overlapping composition writes and keeps a persistence failure inside the process', async () => {
    const policy = createEnterpriseCapabilityPolicy()
    const rejections = []
    const onRejection = (error) => { rejections.push(error) }
    process.on('unhandledRejection', onRejection)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      let active = 0
      let maxActive = 0
      let release
      const calls = []
      policy.setCompositionHandler(async (snapshot) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        calls.push(snapshot.connectionKey)
        if (calls.length === 1) {
          await new Promise((resolve) => { release = resolve })
          active -= 1
          throw Object.assign(new Error('ENOENT: rename failed'), { code: 'ENOENT' })
        }
        active -= 1
      })
      policy.reset()
      policy.reset()
      policy.reset()
      expect(calls).toEqual([undefined])
      expect(maxActive).toBe(1)
      release()
      await vi.waitFor(() => {
        expect(calls).toEqual([undefined, undefined])
      })
      expect(maxActive).toBe(1)
      expect(rejections).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('third-party policy composition failed (ENOENT)'))
    } finally {
      process.off('unhandledRejection', onRejection)
      warn.mockRestore()
    }
  })

  it('removes the local install secret before a child process starts', () => {
    const env = { ...process.env, DSH_DESKTOP_LOCAL_WORKBENCH_CAPABILITY: 'a'.repeat(48) }
    expect(consumeLocalWorkbenchCapability(env)).toHaveLength(48)
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.DSH_DESKTOP_LOCAL_WORKBENCH_CAPABILITY || "")'], { env })
    expect(child.stdout.toString()).toBe('')
  })
})
