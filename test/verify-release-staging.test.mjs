import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { verifyReleaseStaging } from '../scripts/verify-release-staging.mjs'

let directory
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

it('verifies every downloaded draft asset against its release digest', async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'release-staging-'))
  const content = Buffer.from('signed installer')
  await writeFile(path.join(directory, 'setup.exe'), content)
  const digest = createHash('sha256').update(content).digest('hex')
  const release = {
    isDraft: true,
    assets: [{ name: 'setup.exe', size: content.length, digest: `sha256:${digest}` }]
  }
  await expect(verifyReleaseStaging(release, directory, ['setup.exe'], 'v1.0.1')).resolves.toBeUndefined()

  await writeFile(path.join(directory, 'setup.exe'), 'tampered payload')
  await expect(verifyReleaseStaging(release, directory, ['setup.exe'], 'v1.0.1')).rejects.toThrow()
})

it('rejects missing, extra, and non-draft assets before publication', async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'release-staging-'))
  const release = { isDraft: true, assets: [] }
  await expect(verifyReleaseStaging(release, directory, ['setup.exe'], 'v1.0.1')).rejects.toThrow()
  await writeFile(path.join(directory, 'unexpected.exe'), 'x')
  await expect(verifyReleaseStaging(release, directory, ['setup.exe'], 'v1.0.1')).rejects.toThrow()
  await expect(verifyReleaseStaging({ ...release, isDraft: false }, directory, ['setup.exe'], 'v1.0.1')).rejects.toThrow()
})
