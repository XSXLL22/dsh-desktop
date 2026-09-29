import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function verifyReleaseStaging(release, directory, expectedNames, tag) {
  assert.equal(new Set(expectedNames).size, expectedNames.length, 'Duplicate expected asset name')
  for (const name of expectedNames) {
    assert.equal(path.basename(name), name, `Invalid asset name: ${name}`)
  }

  assert.equal(release.isDraft, true, `Release ${tag} is not a draft`)
  const assets = new Map(release.assets.map(asset => [asset.name, asset]))
  assert.equal(assets.size, release.assets.length, 'Duplicate release asset name')

  const downloadedNames = await readdir(directory)
  assert.deepEqual(downloadedNames.sort(), [...expectedNames].sort(), 'Downloaded asset set differs from expected set')
  for (const name of expectedNames) {
    const asset = assets.get(name)
    assert(asset, `Missing release asset: ${name}`)
    assert.match(asset.digest ?? '', /^sha256:[a-f0-9]{64}$/, `Missing SHA-256 digest for ${name}`)
    const file = path.join(directory, name)
    const info = await lstat(file)
    assert(info.isFile(), `Not a regular file: ${name}`)
    assert.equal(info.size, asset.size, `Size mismatch: ${name}`)
    assert.equal(await sha256(file), asset.digest.slice('sha256:'.length), `SHA-256 mismatch: ${name}`)
  }
  console.log(`Verified ${expectedNames.length} draft release assets for ${tag}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [tag, directory, ...expectedNames] = process.argv.slice(2)
  assert(tag && directory && expectedNames.length > 0, 'Usage: verify-release-staging.mjs <tag> <directory> <asset...>')
  assert(process.env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY is required')
  const release = JSON.parse(execFileSync('gh', [
    'release', 'view', tag, '--repo', process.env.GITHUB_REPOSITORY,
    '--json', 'isDraft,assets'
  ], { encoding: 'utf8' }))
  verifyReleaseStaging(release, directory, expectedNames, tag).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
