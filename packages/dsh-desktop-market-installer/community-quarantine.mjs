import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const MARKET_STATE = join('.dsh-market', 'state.json')

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Package names currently switched off. Missing state is an empty set.
 * Unreadable state fails closed so a damaged file cannot be treated as an
 * empty switch list. This does not uninstall a generation.
 */
async function readState(dshHome, profile) {
  const path = join(dshHome, 'profiles', profile, MARKET_STATE)
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw new Error(`market state could not be read at ${path}: ${errorText(error)}`, { cause: error })
  }
  let state
  try {
    state = JSON.parse(text)
  } catch (error) {
    throw new Error(`market state is invalid JSON at ${path}: ${errorText(error)}`, { cause: error })
  }
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error(`market state is not a JSON object at ${path}`)
  }
  return { path, state }
}

function disabledNames(state, path) {
  const list = state.disabled !== undefined ? state.disabled : state.disabledSkins
  if (list === undefined) return []
  if (!Array.isArray(list) || list.some((name) => typeof name !== 'string' || name.length === 0)) {
    throw new Error(`market state disabled list is invalid at ${path}`)
  }
  return [...new Set(list)]
}

export async function readQuarantinedPluginNames(dshHome, profile = 'web') {
  const loaded = await readState(dshHome, profile)
  if (loaded === undefined) return []
  return disabledNames(loaded.state, loaded.path)
}

export async function releaseQuarantinedPlugin(dshHome, name, profile = 'web') {
  const loaded = await readState(dshHome, profile)
  if (loaded === undefined || typeof name !== 'string' || name.length === 0) return
  const disabled = disabledNames(loaded.state, loaded.path).filter((entry) => entry !== name)
  const desktop = loaded.state.desktop !== null && typeof loaded.state.desktop === 'object' && !Array.isArray(loaded.state.desktop)
    ? loaded.state.desktop
    : {}
  const recorded = Array.isArray(desktop.quarantinedLegacyBundles)
    ? desktop.quarantinedLegacyBundles.filter((entry) => entry !== name)
    : []
  const temporary = `${loaded.path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify({
    ...loaded.state,
    disabled,
    desktop: { ...desktop, quarantinedLegacyBundles: recorded }
  }, null, 2)}\n`, 'utf8')
  await rename(temporary, loaded.path)
}
