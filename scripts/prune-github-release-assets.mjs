import { execFileSync } from 'node:child_process'

const INSTALLERS = [
  'bisheng-mac-arm64.dmg',
  'bisheng-mac-x64.dmg',
  'bisheng-windows-x64-setup.exe'
]

const [tag] = process.argv.slice(2)
const repository = process.env.GITHUB_REPOSITORY
if (!tag || process.argv.length !== 3 || !repository) {
  throw new Error('Usage: GITHUB_REPOSITORY=owner/repo node scripts/prune-github-release-assets.mjs <tag>')
}

function gh(args) {
  // Tests pass a Node stand-in. On Windows, execFileSync('gh') resolves gh.exe
  // and ignores a PATH directory that only contains gh or gh.cmd.
  const standIn = process.env.PRUNE_GITHUB_GH
  if (standIn) return execFileSync(process.execPath, [standIn, ...args], { encoding: 'utf8' })
  return execFileSync('gh', args, { encoding: 'utf8' })
}

function getDraftAssets() {
  const release = JSON.parse(gh([
    'release', 'view', tag, '--repo', repository, '--json', 'assets,isDraft'
  ]))
  if (release.isDraft !== true || !Array.isArray(release.assets)) {
    throw new Error(`Refusing to prune non-draft or malformed release ${tag}`)
  }
  const names = release.assets.map(asset => asset.name)
  if (names.some(name => typeof name !== 'string' || name.length === 0)) {
    throw new Error(`Refusing to prune release ${tag} with malformed asset names`)
  }
  return names
}

const before = getDraftAssets()
for (const installer of INSTALLERS) {
  if (!before.includes(installer)) {
    throw new Error(`Refusing to prune ${tag}: missing installer ${installer}`)
  }
}

for (const asset of before) {
  if (INSTALLERS.includes(asset)) continue
  gh(['release', 'delete-asset', tag, asset, '--yes', '--repo', repository])
  console.log(`Removed draft-only GitHub release asset: ${asset}`)
}

const remaining = getDraftAssets()
if (
  remaining.length !== INSTALLERS.length ||
  INSTALLERS.some(installer => !remaining.includes(installer))
) {
  throw new Error(`GitHub release ${tag} does not contain exactly the three installers`)
}
console.log(`GitHub release ${tag} contains only the three installers`)
