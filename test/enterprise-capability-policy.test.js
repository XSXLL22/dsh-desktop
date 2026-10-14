import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { createEnterpriseCapabilityPolicy } from '../packages/dsh-desktop-market-installer/enterprise-policy.mjs'
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

  it('removes the local install secret before a child process starts', () => {
    const env = { ...process.env, DSH_DESKTOP_LOCAL_WORKBENCH_CAPABILITY: 'a'.repeat(48) }
    expect(consumeLocalWorkbenchCapability(env)).toHaveLength(48)
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.DSH_DESKTOP_LOCAL_WORKBENCH_CAPABILITY || "")'], { env })
    expect(child.stdout.toString()).toBe('')
  })
})
