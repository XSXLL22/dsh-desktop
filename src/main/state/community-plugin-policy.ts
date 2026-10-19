import { readQuarantinedPluginNames } from 'dsh-desktop-market-installer/community-quarantine'
import { isProtectedProfileBundle, readPersistedThirdPartyPolicy, syncMarketBundle } from 'dsh-desktop-market-installer/enterprise-policy'

/**
 * Bundles Desktop or Harness already compose. They are not community plugins.
 * `dshmarket` stays on disk and is composed only when the tenant allows the
 * plugin market. Other installed plugins are no longer quarantined at startup.
 */
export { isProtectedProfileBundle } from 'dsh-desktop-market-installer/enterprise-policy'

/**
 * Re-enable only a protected bundle that this Safe Mode page listed and that
 * is actually disabled. Renderer-supplied names are not trusted on their own.
 */
export function canReenableProfilePlugin(
  pluginName: string,
  listedPlugins: readonly string[],
  disabledPlugins: readonly string[]
): boolean {
  return isProtectedProfileBundle(pluginName)
    && listedPlugins.includes(pluginName)
    && disabledPlugins.includes(pluginName)
}

type Note = (line: string) => void

/**
 * Align only the dshmarket bundle with the last known tenant policy.
 * Already installed community plugins stay loadable. A missing or unreadable
 * policy keeps the market out of the active profile.
 */
export async function enforceCommunityPluginPolicy(dshHome: string, note: Note): Promise<void> {
  const allowed = (await readPersistedThirdPartyPolicy(dshHome)).allowThirdPartyPlugins === true
  if (!await syncMarketBundle(dshHome, allowed)) return
  note(allowed
    ? '[desktop] restored dshmarket to the active profile'
    : '[desktop] removed dshmarket from the active profile until third-party plugins are allowed')
}

export { readQuarantinedPluginNames }
