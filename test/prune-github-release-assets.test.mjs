import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'

const script = path.resolve(import.meta.dirname, '../scripts/prune-github-release-assets.mjs')
const installers = [
  'bisheng-work-mac-arm64.dmg',
  'bisheng-work-mac-x64.dmg',
  'bisheng-work-windows-x64-setup.exe'
]
const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fakeGitHubRelease({ isDraft = true, names = installers } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bisheng-release-prune-'))
  temporaryDirectories.push(directory)
  const statePath = path.join(directory, 'state.json')
  await writeFile(statePath, JSON.stringify({ isDraft, assets: names.map(name => ({ name })), deleted: [] }))
  const fakeGh = path.join(directory, 'gh')
  await writeFile(fakeGh, `#!/usr/bin/env node
const fs = require('node:fs')
const statePath = process.env.FAKE_GH_STATE
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
const args = process.argv.slice(2)
if (args[0] !== 'release' || !args.includes('--repo') || args[args.indexOf('--repo') + 1] !== 'dataelement/bisheng-work') {
  process.exit(2)
}
if (args[1] === 'view' && args.includes('--json')) {
  process.stdout.write(JSON.stringify({ isDraft: state.isDraft, assets: state.assets }))
} else if (args[1] === 'delete-asset' && args.includes('--yes')) {
  const name = args[3]
  if (!state.assets.some(asset => asset.name === name)) process.exit(3)
  state.assets = state.assets.filter(asset => asset.name !== name)
  state.deleted.push(name)
  fs.writeFileSync(statePath, JSON.stringify(state))
} else {
  process.exit(2)
}
`)
  await chmod(fakeGh, 0o755)
  const env = {
    ...process.env,
    PATH: `${directory}${path.delimiter}${process.env.PATH ?? ''}`,
    FAKE_GH_STATE: statePath,
    GITHUB_REPOSITORY: 'dataelement/bisheng-work'
  }
  return {
    run: () => spawnSync(process.execPath, [script, 'v1.0.1'], { env, encoding: 'utf8' }),
    state: async () => JSON.parse(await readFile(statePath, 'utf8'))
  }
}

it('keeps only the three installers in a verified draft release', async () => {
  const extra = ['latest.yml', 'latest-mac.yml', 'bisheng-work-mac-arm64.zip', 'win-unpacked.tar.gz']
  const release = await fakeGitHubRelease({ names: [...installers, ...extra] })

  const result = release.run()

  expect(result.status).toBe(0)
  expect((await release.state()).assets.map(asset => asset.name)).toEqual(installers)
  expect((await release.state()).deleted).toEqual(extra)
})

it('refuses to prune a published release', async () => {
  const release = await fakeGitHubRelease({ isDraft: false, names: [...installers, 'latest.yml'] })

  const result = release.run()

  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('Refusing to prune non-draft')
  expect((await release.state()).deleted).toEqual([])
})

it('refuses to prune when an installer is missing', async () => {
  const release = await fakeGitHubRelease({ names: [installers[0], installers[1], 'latest.yml'] })

  const result = release.run()

  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('missing installer bisheng-work-windows-x64-setup.exe')
  expect((await release.state()).deleted).toEqual([])
})
