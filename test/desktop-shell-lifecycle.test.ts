import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import * as navigation from '../src/main/desktop-navigation'
import { rememberRepairReturnNavigation, restoreRepairReturnNavigation, REPAIR_NAVIGATION_KEYS } from '../src/main/repair-navigation'
import { HARNESS_SHELL_URL, isHarnessShellUrl } from '../src/shared/harness-boot'
import { desktopHarnessUrl } from '../src/main/window-navigation'

function fixture() {
  const source = ts.createSourceFile('index.ts', readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const names = ['loadDesktopResource', 'prepareHarnessPage', 'openHarness']
  const functions = source.statements.filter(ts.isFunctionDeclaration).filter(node => names.includes(node.name?.text ?? ''))
  if (functions.length !== names.length) throw new Error('Desktop lifecycle entry points not found')
  // Execute the real main-process glue using the recovery tests' existing VM seam.
  const code = ts.transpileModule(functions.map(node => node.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  let currentUrl = 'file:///splash.html'
  const clear = vi.fn()
  const window = {
    isDestroyed: () => false,
    loadURL: vi.fn(async (url: string) => { currentUrl = url }),
    webContents: { stop: vi.fn(), getURL: () => currentUrl, navigationHistory: { clear } }
  }
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) }
  }
  const backend = 'http://127.0.0.1:43129/'
  const connect = vi.fn(async () => {})
  const context = {
    ...navigation, join, restoreRepairReturnNavigation,
    RepairSessionStore: class { async load() { return { sessionId: 'repair' } } },
    desktopStorageManager: storage, takePendingRepairPrompt: () => undefined,
    harnessShell: { reset: vi.fn(), connect },
    rendererPluginFailureLogs: [], mainWindow: window, createWindow: () => window,
    mainWindowNavigationVersion: 0, harnessPagePreparation: undefined as Promise<boolean> | undefined,
    HARNESS_SHELL_URL, isHarnessShellUrl, desktopHarnessUrl, process: { platform: 'win32' },
    processRecovery: { blocked: false }, quitting: false, gpuFallbackRelaunching: false,
    applicationRollbackVisible: false, safeModeVisible: false, returnToNormalAfterRepair: false,
    runtime: { launchAttemptId: 'fixture-launch', snapshot: () => ({ url: backend, authToken: 'fixture-token', phase: 'ready' }), note: vi.fn() },
    markHarnessRendered: vi.fn(), syncNativeTheme: vi.fn(async () => {}),
    raiseWindowWithoutStealingFocus: vi.fn(), app: { isActive: () => true, getPath: () => '/profile' }
  }
  const lifecycle: {
    prepare: () => void
    open: (url: string) => Promise<void>
    resource: (target: typeof window, path: string) => Promise<boolean>
  } = runInNewContext(code + ';({ prepare: prepareHarnessPage, open: openHarness, resource: loadDesktopResource })', context)
  return { ...lifecycle, context, window, clear, connect, backend, storage }
}

describe('Desktop shell lifecycle history', () => {
  it('replaces startup history when preloading through the registered recovery owner', async () => {
    const f = fixture()
    const owner = vi.fn(async (url: string) => { await f.window.loadURL(url); return true })
    const unregister = navigation.registerNavigationOwner(f.window, owner)
    try {
      f.prepare()
      expect(await f.context.harnessPagePreparation).toBe(true)
      expect(owner).toHaveBeenCalledOnce()
      expect(f.window.webContents.getURL()).toBe(desktopHarnessUrl(HARNESS_SHELL_URL, 'win32'))
      expect(f.clear).toHaveBeenCalledOnce()
    } finally { unregister() }
  })

  it('clears obsolete history on the fallback handoff without a prepared page', async () => {
    const f = fixture()
    await f.open(f.backend)
    expect(f.clear).toHaveBeenCalledOnce()
    expect(f.connect).toHaveBeenCalledWith(f.backend, 'fixture-token')
  })

  it('reuses the prepared document without clearing later application history again', async () => {
    const f = fixture()
    f.prepare()
    await f.context.harnessPagePreparation
    await f.open(f.backend)
    expect(f.window.loadURL).toHaveBeenCalledOnce()
    expect(f.clear).toHaveBeenCalledOnce()
  })

  it.each(['web-import', 'plugin-recovery', 'safe-mode', 'application-rollback'])('replaces the obsolete history of %s', async name => {
    const f = fixture()
    expect(await f.resource(f.window, `/fixture/${name}.html`)).toBe(true)
    expect(f.clear).toHaveBeenCalledOnce()
  })

  it('does not clear history when a newer navigation supersedes the preload', async () => {
    const f = fixture()
    let finish: () => void = () => { throw new Error('Preload did not start') }
    f.window.loadURL.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    f.prepare()
    f.context.mainWindowNavigationVersion++
    finish()
    expect(await f.context.harnessPagePreparation).toBe(false)
    expect(f.clear).not.toHaveBeenCalled()
  })

  it.each([false, true])('preserves repair drafts and respects the normal/safe return boundary (safe=%s)', async safe => {
    const f = fixture()
    for (const key of REPAIR_NAVIGATION_KEYS) f.storage.setItem(key, JSON.stringify({ sessionId: 'ordinary' }))
    rememberRepairReturnNavigation(f.storage, 'repair')
    for (const key of REPAIR_NAVIGATION_KEYS) f.storage.setItem(key, JSON.stringify({ sessionId: 'repair' }))
    f.storage.setItem('dsh.conversation.repair', 'unsent draft')
    f.context.safeModeVisible = safe
    f.context.returnToNormalAfterRepair = true
    f.prepare()
    await f.context.harnessPagePreparation
    await f.open(f.backend)
    for (const key of REPAIR_NAVIGATION_KEYS) expect(JSON.parse(f.storage.getItem(key) ?? 'null').sessionId).toBe(safe ? 'repair' : 'ordinary')
    expect(f.storage.getItem('dsh.conversation.repair')).toBe('unsent draft')
    expect(f.clear).toHaveBeenCalledOnce()
  })

  it.each(['quitting', 'gpuFallbackRelaunching', 'applicationRollbackVisible', 'processRecovery'] as const)('keeps the %s gate in control of the handoff', async gate => {
    const f = fixture()
    if (gate === 'processRecovery') f.context.processRecovery.blocked = true
    else f.context[gate] = true
    await f.open(f.backend)
    expect(f.window.loadURL).not.toHaveBeenCalled()
    expect(f.clear).not.toHaveBeenCalled()
    expect(f.connect).not.toHaveBeenCalled()
  })
})
