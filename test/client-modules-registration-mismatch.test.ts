import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { projectRoot } from './patch-path'

interface Registration {
  id: string
  factory: () => unknown
}

interface Target {
  mode: string
  pendingQueue: Registration[]
  load?: (registration: Registration) => void
}

interface ModuleSystem {
  manifest: unknown
  import(id: string): Promise<unknown>
}

interface ClientApi {
  createClientModuleSystem(
    target: Target,
    bootstrap: { id: string; exports: unknown },
    options: {
      boot: unknown
      staticModules: Record<string, unknown>
      loadBundle?: (url: string) => Promise<void>
    }
  ): ModuleSystem
}

async function loadClientModules(): Promise<ClientApi> {
  const source = await readFile(
    join(projectRoot, 'node_modules/@deepseek-ai/dsh-client-modules/lib/client.js'),
    'utf8'
  )
  let api: ClientApi | undefined
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load({ factory }: { factory: () => ClientApi }) {
          api = factory()
        }
      }
    }
  })
  if (!api) throw new Error('client modules bundle did not register')
  return api
}

const PACKAGE = '@acceptance/wrong-id-plugin'

function boot(packageName: string): {
  rev: string
  entries: Array<{ id: string; url: string; rev: string; inject: string[] }>
  batches: Array<{ phase: string; url: string; rev: string; entries: string[] }>
} {
  return {
    rev: 'boot-1',
    entries: [{
      id: packageName,
      url: `/plugins/${packageName}/client.js?rev=1`,
      rev: '1',
      inject: []
    }],
    batches: [{
      phase: 'application',
      url: `/??${packageName}/client.js&rev=1`,
      rev: '1',
      entries: [packageName]
    }]
  }
}

/**
 * Drive the real module system with a transport that executes a classic script, the
 * way the Host serves one combined bundle and the browser evaluates it.
 */
async function importWithBundle(
  register: (load: (registration: Registration) => void) => void
): Promise<{ urls: string[]; error?: string; resolved?: boolean }> {
  const api = await loadClientModules()
  const target: Target = { mode: 'queue', pendingQueue: [] }
  const urls: string[] = []
  const modules = api.createClientModuleSystem(
    target,
    { id: '@deepseek-ai/dsh-client-modules', exports: api },
    {
      boot: boot(PACKAGE),
      staticModules: {},
      loadBundle: async (url) => {
        urls.push(url)
        if (!target.load) throw new Error('registration facade is not live')
        register(target.load)
      }
    }
  )
  try {
    await modules.import(PACKAGE)
    return { urls, resolved: true }
  } catch (error) {
    return { urls, error: error instanceof Error ? error.message : String(error) }
  }
}

describe('client module registration identity', () => {
  it('names the foreign module id instead of replaying the bundle for a duplicate', async () => {
    const result = await importWithBundle((load) => {
      load({ id: 'wrong-id-plugin', factory: () => ({}) })
    })

    expect(result.resolved).toBeFalsy()
    // The mismatched bundle is not fetched a second time, so no duplicate is reported.
    expect(result.urls).toHaveLength(1)
    expect(result.error).toContain('not a row in this boot graph')
    expect(result.error).toContain('"wrong-id-plugin"')
    expect(result.error).not.toContain('duplicate factory registration')
  })

  it('still resolves a bundle that registers the row its package names', async () => {
    const result = await importWithBundle((load) => {
      load({ id: PACKAGE, factory: () => ({ marker: true }) })
    })

    expect(result.resolved).toBe(true)
    expect(result.urls).toHaveLength(1)
  })

  it('keeps the single-resource fallback when a bundle registers nothing at all', async () => {
    const result = await importWithBundle(() => {})

    expect(result.resolved).toBeFalsy()
    expect(result.urls).toHaveLength(2)
    expect(result.error).toContain('loaded without registering')
    expect(result.error).not.toContain('not a row in this boot graph')
  })
})
