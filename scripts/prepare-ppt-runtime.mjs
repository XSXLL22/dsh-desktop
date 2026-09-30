import { rm, mkdir, readFile, writeFile, readdir, stat, lstat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import crypto from 'node:crypto'
import { replaceInstalledPackages } from './ppt-package-projection.mjs'

const outputRoot = path.resolve('.build/ppt-runtime')
const templateRoot = path.join(outputRoot, 'templates')
const packagesRoot = path.join(outputRoot, 'packages')
const cacheManifestPath = path.join(outputRoot, '.cache-manifest.json')

const isForce = process.argv.includes('--force') ||
  process.env.PPT_FORCE_BUILD === '1' ||
  process.env.PPT_FORCE_BUILD === 'true'

// npm prepends node_modules/.bin to PATH, which can shadow the real `node` binary
// with the `node` npm package. Use npm_node_execpath (set by npm to the actual Node
// running npm itself) so child scripts resolve modules against the real installation.
const nodeExec = process.env.npm_node_execpath ?? process.execPath

async function fileExists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function isProjectedPackage(packageName) {
  try {
    const target = path.resolve('node_modules', packageName)
    const info = await lstat(target)
    if (info.isSymbolicLink()) return false
    await stat(path.join(target, 'lib/client.js'))
    return true
  } catch {
    return false
  }
}

async function collectFiles(dirPath, ignoreDirs = new Set(['node_modules', '.git'])) {
  const files = []
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        if (!ignoreDirs.has(entry.name)) {
          files.push(...(await collectFiles(fullPath, ignoreDirs)))
        }
      } else if (entry.isFile()) {
        files.push(fullPath)
      }
    }
  } catch {
    // Directory may not exist
  }
  return files
}

async function computeInputsHash() {
  const hash = crypto.createHash('sha256')
  const trackedFiles = [
    path.resolve('scripts/prepare-ppt-runtime.mjs'),
    path.resolve('scripts/generate-zara-ppt-templates.mjs'),
    path.resolve('scripts/localize-ppt-templates.mjs'),
    path.resolve('scripts/enrich-ppt-templates.mjs'),
    path.resolve('scripts/build-ppt-runtime.mjs'),
    path.resolve('scripts/ppt-package-projection.mjs'),
    ...(await collectFiles(path.resolve('scripts/ppt'))),
    ...(await collectFiles(path.resolve('packages/ppt-runtime')))
  ]

  trackedFiles.sort()
  for (const file of trackedFiles) {
    try {
      const content = await readFile(file)
      hash.update(path.relative(process.cwd(), file).split(path.sep).join('/'))
      hash.update(content)
    } catch {
      hash.update(`${file}:missing`)
    }
  }
  return hash.digest('hex')
}

function run(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExec, [path.resolve(script)], {
      stdio: 'inherit',
      env: { ...process.env, DSH_PPT_TEMPLATE_OUTPUT: templateRoot }
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(script + ' failed (' + (signal ?? ('exit ' + code)) + ')'))
    })
  })
}

if (!isForce) {
  const isStagedBuilt = (
    await fileExists(path.join(packagesRoot, 'dsh-ppt', 'package.json')) &&
    await fileExists(path.join(packagesRoot, 'dsh-ppt-composer', 'package.json')) &&
    await fileExists(path.join(packagesRoot, 'build.json')) &&
    await fileExists(cacheManifestPath)
  )

  if (isStagedBuilt) {
    try {
      const cached = JSON.parse(await readFile(cacheManifestPath, 'utf8'))
      const currentHash = await computeInputsHash()
      if (cached.hash === currentHash) {
        const isProjected = (
          await isProjectedPackage('dsh-ppt') &&
          await isProjectedPackage('dsh-ppt-composer')
        )
        if (!isProjected) {
          console.log('[ppt:build] PPT runtime up to date; re-projecting into node_modules...')
          await replaceInstalledPackages([
            { packageName: 'dsh-ppt', source: path.join(packagesRoot, 'dsh-ppt') },
            { packageName: 'dsh-ppt-composer', source: path.join(packagesRoot, 'dsh-ppt-composer') }
          ])
        }
        console.log('[ppt:build] PPT runtime is up to date, skipping rebuild. (Use --force to rebuild)')
        process.exit(0)
      }
    } catch {
      // Proceed to clean rebuild if cache verification fails
    }
  }
}

await rm(outputRoot, { recursive: true, force: true })
await mkdir(templateRoot, { recursive: true })
for (const script of [
  'scripts/generate-zara-ppt-templates.mjs',
  'scripts/localize-ppt-templates.mjs',
  'scripts/enrich-ppt-templates.mjs',
  'scripts/build-ppt-runtime.mjs'
]) {
  await run(script)
}

const currentHash = await computeInputsHash()
await writeFile(cacheManifestPath, JSON.stringify({
  hash: currentHash,
  updatedAt: new Date().toISOString()
}, null, 2) + '\n')
