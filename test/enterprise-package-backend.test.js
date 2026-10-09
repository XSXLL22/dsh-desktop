import { describe, expect, it, vi } from 'vitest'
import { restrictCommunityPackageBackend } from '../packages/dsh-desktop-market-installer/enterprise-policy.mjs'

describe('enterprise admission on the official package backend', () => {
  it.each(['registry', 'path', 'git', 'tarball'])('rejects %s installs before touching the backend', async kind => {
    const install = vi.fn()
    const backend = restrictCommunityPackageBackend({ install })
    await expect(backend.install({ kind, spec: 'demo-plugin@1.0.0' })).rejects.toThrow('POLICY_DISABLED')
    expect(install).not.toHaveBeenCalled()
  })

  it('blocks community re-enable while allowing disable, host switches and removal', async () => {
    const switched = vi.fn()
    const remove = vi.fn()
    const removed = vi.fn()
    const backend = restrictCommunityPackageBackend({ switched, remove, removed })
    await expect(backend.switched({ name: 'demo-plugin', enabled: true })).rejects.toThrow('POLICY_DISABLED')
    expect(switched).not.toHaveBeenCalled()
    await backend.switched({ name: 'demo-plugin', enabled: false })
    await backend.switched({ name: 'dsh-desktop-workbenches', enabled: true })
    await backend.remove({ name: 'demo-plugin' })
    await backend.removed({ name: 'demo-plugin' })
    expect(switched).toHaveBeenCalledTimes(2)
    expect(remove).toHaveBeenCalledWith({ name: 'demo-plugin' })
    expect(removed).toHaveBeenCalledWith({ name: 'demo-plugin' })
  })
})
