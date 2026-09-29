import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { communityPluginInstallAllowed } from './enterprise-policy.mjs'

const MARKET_STATE = join('.dsh-market', 'state.json')

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Package names Desktop keeps out of the next projection. Missing state is an
 * empty set. Unreadable state fails closed so a damaged file cannot load the
 * plugins it was meant to isolate.
 */
export async function readQuarantinedPluginNames(dshHome, profile = 'web') {
  if (communityPluginInstallAllowed()) return []
  const path = join(dshHome, 'profiles', profile, MARKET_STATE)
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
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
  const list = state.disabled !== undefined ? state.disabled : state.disabledSkins
  if (list === undefined) return []
  if (!Array.isArray(list) || list.some((name) => typeof name !== 'string' || name.length === 0)) {
    throw new Error(`market state disabled list is invalid at ${path}`)
  }
  return [...new Set(list)]
}
