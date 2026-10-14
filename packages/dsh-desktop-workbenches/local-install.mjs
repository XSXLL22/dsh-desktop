import { timingSafeEqual } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, posix, resolve, win32 } from 'node:path'

export const LOCAL_WORKBENCH_CAPABILITY_ENV = 'DSH_DESKTOP_LOCAL_WORKBENCH_CAPABILITY'
export const LOCAL_WORKBENCH_CAPABILITY_HEADER = 'x-dsh-local-workbench-capability'

const NAME_PATTERN = /^(?:@[A-Za-z0-9-~][A-Za-z0-9._~-]*\/)?[A-Za-z0-9-~][A-Za-z0-9._~-]*$/u
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u

export function consumeLocalWorkbenchCapability(env = process.env) {
  const value = env[LOCAL_WORKBENCH_CAPABILITY_ENV]
  delete env[LOCAL_WORKBENCH_CAPABILITY_ENV]
  return typeof value === 'string' && value.length >= 32 ? value : undefined
}

export function localCapabilityMatches(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false
  const left = Buffer.from(expected)
  const right = Buffer.from(provided)
  return left.length === right.length && timingSafeEqual(left, right)
}

function isWindowsDrivePath(input) {
  return /^[A-Za-z]:[\\/]/u.test(input)
}

function hasUriScheme(input) {
  return !isWindowsDrivePath(input) && /^[a-z][a-z0-9+.-]*:/iu.test(input)
}

/** A drive-letter path is absolute on Windows even when this process is not. */
export function isAcceptedLocalWorkbenchPath(input) {
  if (typeof input !== 'string' || !input || input.includes('\0') || hasUriScheme(input)) return false
  return isWindowsDrivePath(input) || isAbsolute(input)
}

/** True when realpath(client) is the package directory or a file inside it. */
export function clientStaysInsideDirectory(directory, clientFile) {
  const api = isWindowsDrivePath(directory) || isWindowsDrivePath(clientFile) ? win32 : posix
  const relativePath = api.relative(api.normalize(directory), api.normalize(clientFile))
  if (relativePath === '') return true
  return relativePath !== '..' && !relativePath.startsWith(`..${api.sep}`) && !api.isAbsolute(relativePath)
}

export async function readLocalWorkbenchPackage(input) {
  if (!isAcceptedLocalWorkbenchPath(input)) throw new Error('A local workbench directory is required.')
  const directory = await realpath(input)
  const info = await lstat(directory)
  if (!info.isDirectory()) throw new Error('A local workbench directory is required.')
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (!NAME_PATTERN.test(manifest?.name ?? '') || !VERSION_PATTERN.test(manifest?.version ?? '')) {
    throw new Error('The local workbench package needs a valid name and version.')
  }
  const inject = manifest?.dsh?.client?.inject
  if (!Array.isArray(inject) || !inject.includes('dsh-desktop-workbenches')) {
    throw new Error('The local package is not a desktop workbench.')
  }
  const clientExport = manifest?.exports?.['./client']
  const clientPath = typeof clientExport === 'string'
    ? clientExport
    : clientExport?.default ?? clientExport?.import
  if (typeof clientPath !== 'string' || !clientPath || clientPath.includes('\0')) {
    throw new Error('The local workbench has no client export.')
  }
  const clientFile = await realpath(resolve(directory, clientPath))
  if (!clientStaysInsideDirectory(directory, clientFile)) {
    throw new Error('The local workbench client escapes its directory.')
  }
  const clientInfo = await lstat(clientFile)
  if (!clientInfo.isFile()) throw new Error('The local workbench client is not a file.')
  return {
    directory,
    name: manifest.name,
    version: manifest.version
  }
}
