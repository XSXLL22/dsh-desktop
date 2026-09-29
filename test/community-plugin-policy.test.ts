import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { projectGenerations } from 'dsh-desktop-market-installer/generations/projection'
import { readDesired, writeDesired, writeGenerationMeta, registryLayout } from 'dsh-desktop-market-installer/generations/registry'
import { enforceCommunityPluginPolicy } from '../src/main/state/community-plugin-policy'
import { rm } from 'node:fs/promises'

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

async function profileHome(): Promise<{ home: string; profile: string }> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-community-policy-'))
  homes.push(home)
  const profile = join(home, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  return { home, profile }
}

describe('community plugin policy', () => {
  it('removes community bundles and dshmarket from the active profile without deleting dependencies', async () => {
    const { home, profile } = await profileHome()
    const pluginDir = join(profile, 'node_modules', 'community-plugin')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
      name: 'community-plugin',
      version: '1.0.0',
      dsh: { bundle: { patch: 'cordis.patch.yml' } }
    }))
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      dependencies: {
        dshmarket: '1.65.1',
        'community-plugin': '1.0.0',
        'transitive-lib': '1.2.3',
        '@deepseek-ai/dsh-base': '0.1.0',
        'dsh-image-generation': '0.1.0'
      },
      dsh: {
        profile: {
          bundles: ['dshmarket', 'community-plugin', '@deepseek-ai/dsh-base', 'dsh-image-generation']
        }
      }
    }))

    const notes: string[] = []
    await enforceCommunityPluginPolicy(home, (line) => notes.push(line))
    await enforceCommunityPluginPolicy(home, (line) => notes.push(line))

    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    expect(manifest.dependencies['community-plugin']).toBe('1.0.0')
    expect(manifest.dependencies.dshmarket).toBe('1.65.1')
    expect(manifest.dependencies['transitive-lib']).toBe('1.2.3')
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'dsh-image-generation'])
    const state = JSON.parse(await readFile(join(profile, '.dsh-market', 'state.json'), 'utf8'))
    expect(state.disabled).toEqual(['dshmarket', 'community-plugin'])
    expect(state.desktop.quarantinedLegacyBundles).toEqual(['dshmarket', 'community-plugin'])
    expect(notes.filter((line) => line.includes('removed community bundles'))).toHaveLength(1)
  })

  it('keeps a quarantined generation in desired but out of the active projection', async () => {
    const { home, profile } = await profileHome()
    const generationDir = join(registryLayout(home).generations, 'community-plugin+1.0.0+abcd')
    const packageDir = join(generationDir, 'node_modules', 'community-plugin')
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      name: 'community-plugin',
      version: '1.0.0'
    }))
    await writeGenerationMeta(generationDir, { pluginName: 'community-plugin', version: '1.0.0' })
    await writeDesired(home, ['community-plugin+1.0.0+abcd'])
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      dependencies: { '@deepseek-ai/dsh-base': '0.1.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } }
    }))

    await enforceCommunityPluginPolicy(home, () => {})
    const projection = await projectGenerations(home)
    expect(projection.linked).not.toContain('community-plugin')
    expect(projection.bundles).not.toContain('community-plugin')
    expect(await readDesired(home)).toEqual(['community-plugin+1.0.0+abcd'])
  })
})
