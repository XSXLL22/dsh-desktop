import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readQuarantinedPluginNames } from 'dsh-desktop-market-installer/community-quarantine'
import { communityPluginInstallAllowed, isProtectedProfileBundle } from 'dsh-desktop-market-installer/enterprise-policy'
import { listGenerations, readDesired } from 'dsh-desktop-market-installer/generations/registry'

const MARKET_PACKAGE = 'dshmarket'
const MARKET_STATE = join('.dsh-market', 'state.json')

/**
 * Bundles Desktop or Harness already compose. They are not community plugins.
 * `dshmarket` is intentionally absent: the enterprise edition removes it from
 * the active profile even though the package stays on disk.
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

function profileDirectory(dshHome: string): string {
  return join(dshHome, 'profiles', 'web')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readJsonObject(path: string, label: string): Promise<Record<string, unknown> | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`${label} could not be read at ${path}: ${errorText(error)}`, { cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${label} is invalid JSON at ${path}: ${errorText(error)}`, { cause: error })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} is not a JSON object at ${path}`)
  }
  return parsed as Record<string, unknown>
}

function stringList(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, text, 'utf8')
  await rename(temporary, path)
}

function union(current: readonly string[], extra: readonly string[]): string[] {
  const next = [...current]
  for (const name of extra) {
    if (!next.includes(name)) next.push(name)
  }
  return next
}

/**
 * Keep community plugins out of the active profile without deleting them.
 * Generations stay referenced by desired.json. Legacy bundles leave
 * `dsh.profile.bundles` but keep their dependency, directory, and user data.
 */
export async function enforceCommunityPluginPolicy(dshHome: string, note: Note): Promise<void> {
  if (communityPluginInstallAllowed()) return
  const directory = profileDirectory(dshHome)
  const manifestPath = join(directory, 'package.json')
  const manifest = await readJsonObject(manifestPath, 'profile manifest')
  if (manifest === undefined) return

  const dependencies = manifest.dependencies
  if (
    dependencies !== undefined &&
    (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies))
  ) {
    throw new Error(`profile manifest dependencies are invalid at ${manifestPath}`)
  }
  const dependencyNames = dependencies === undefined ? [] : Object.keys(dependencies)
  const rawBundles = (manifest.dsh as { profile?: { bundles?: unknown } } | undefined)?.profile?.bundles
  const bundleNames = stringList(rawBundles, `profile manifest bundles at ${manifestPath}`)

  const [desired, generations] = await Promise.all([
    readDesired(dshHome),
    listGenerations(dshHome)
  ])
  const desiredIds = new Set(desired)
  const generationNames = generations
    .filter((generation) => desiredIds.has(generation.id))
    .filter((generation) => !generation.sourceSpec?.startsWith('bisheng:'))
    .map((generation) => generation.pluginName)
    .filter((name) => !isProtectedProfileBundle(name))

  const legacyBundles = bundleNames.filter((name) => name !== MARKET_PACKAGE && !isProtectedProfileBundle(name))
  const communityNames = [
    ...(dependencyNames.includes(MARKET_PACKAGE) || bundleNames.includes(MARKET_PACKAGE) ? [MARKET_PACKAGE] : []),
    ...legacyBundles,
    ...generationNames
  ]

  const statePath = join(directory, MARKET_STATE)
  const state = await readJsonObject(statePath, 'market state') ?? {}
  if (
    state.desktop !== undefined &&
    (typeof state.desktop !== 'object' || state.desktop === null || Array.isArray(state.desktop))
  ) {
    throw new Error(`market state desktop field is invalid at ${statePath}`)
  }
  const desktop = (state.desktop ?? {}) as Record<string, unknown>
  const disabled = stringList(
    state.disabled !== undefined ? state.disabled : state.disabledSkins,
    `market state disabled list at ${statePath}`
  )
  const recorded = stringList(desktop.quarantinedLegacyBundles, `quarantined legacy bundles at ${statePath}`)
  const nextDisabled = union(disabled, communityNames)
  const removedBundles = bundleNames.filter((name) => communityNames.includes(name))
  const nextLegacy = union(recorded, removedBundles)
  const nextBundles = bundleNames.filter((name) => !removedBundles.includes(name))

  if (nextDisabled.length !== disabled.length || nextLegacy.length !== recorded.length) {
    await writeAtomically(statePath, `${JSON.stringify({
      ...state,
      disabled: nextDisabled,
      desktop: { ...desktop, quarantinedLegacyBundles: nextLegacy }
    }, null, 2)}\n`)
    note(`[desktop] community plugins quarantined: ${nextDisabled.join(', ')}`)
  }
  if (nextBundles.length !== bundleNames.length) {
    const dsh = (manifest.dsh ?? {}) as Record<string, unknown>
    const profile = (dsh.profile ?? {}) as Record<string, unknown>
    await writeAtomically(manifestPath, `${JSON.stringify({
      ...manifest,
      dsh: { ...dsh, profile: { ...profile, bundles: nextBundles } }
    }, null, 2)}\n`)
    note(`[desktop] removed community bundles from the active profile: ${removedBundles.join(', ')}`)
  }
}

export { readQuarantinedPluginNames }
