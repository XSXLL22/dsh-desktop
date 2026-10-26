import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { navigateDesktopWindow, registerNavigationOwner, replaceDesktopWindowPage } from '../src/main/desktop-navigation'
import { HARNESS_SHELL_URL, isHarnessShellUrl } from '../src/shared/harness-boot'
import { desktopHarnessUrl } from '../src/main/window-navigation'

function fixture() {
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf('function prepareHarnessPage(): void')
  const end = source.indexOf('\nasync function maybeImportWebHome(', start)
  if (start < 0 || end < 0) throw new Error('Desktop shell lifecycle functions not found')
  // Exercise the actual private main-process glue, with the same VM seam used
  // by renderer recovery tests. Backend startup and native drawing are separate gates.
  const code = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  let currentUrl = 'file:///splash.html'
  const clear = vi.fn()
  const window = {
    isDestroyed: () => false,
    loadURL: vi.fn(async (url: string) => { currentUrl = url }),
    webContents: { stop: vi.fn(), getURL: () => currentUrl, navigationHistory: { clear } }
  }
  const backend = 'http://127.0.0.1:43129/'
  const connect = vi.fn(async () => {})
  const context = {
    harnessShell: { reset: vi.fn(), connect },
    rendererPluginFailureLogs: [], mainWindow: window, createWindow: () => window,
    mainWindowNavigationVersion: 0, harnessPagePreparation: undefined as Promise<boolean> | undefined,
    navigateDesktopWindow, registerNavigationOwner, replaceDesktopWindowPage, desktopHarnessUrl,
    HARNESS_SHELL_URL, isHarnessShellUrl, process: { platform: 'win32' },
    processRecovery: { blocked: false }, quitting: false, gpuFallbackRelaunching: false,
    applicationRollbackVisible: false, safeModeVisible: false, returnToNormalAfterRepair: false,
    runtime: { launchAttemptId: 'fixture-launch', snapshot: () => ({ url: backend, authToken: 'fixture-token', phase: 'ready' }), note: vi.fn() },
    markHarnessRendered: vi.fn(), syncNativeTheme: vi.fn(async () => {}),
    raiseWindowWithoutStealingFocus: vi.fn(), app: { isActive: () => true }
  }
  const lifecycle: { prepare: () => void; open: (url: string) => Promise<void> } = runInNewContext(
    code + ';({ prepare: prepareHarnessPage, open: openHarness })', context
  )
  return { ...lifecycle, context, window, clear, connect, backend }
}

describe('prepared Desktop shell lifecycle', () => {
  it('replaces startup history when preloading the local shell through its navigation owner', async () => {
    const f = fixture()
    const owner = vi.fn(async (url: string) => { await f.window.loadURL(url); return true })
    const unregister = registerNavigationOwner(f.window, owner)
    try {
      f.prepare()
      expect(await f.context.harnessPagePreparation).toBe(true)
      expect(owner).toHaveBeenCalledOnce()
      expect(f.window.webContents.getURL()).toBe(desktopHarnessUrl(HARNESS_SHELL_URL, 'win32'))
      expect(f.clear).toHaveBeenCalledOnce()
    } finally { unregister() }
  })

  it('clears history on the fallback handoff when no prepared shell exists', async () => {
    const f = fixture()
    await f.open(f.backend)
    expect(f.window.loadURL).toHaveBeenCalledOnce()
    expect(f.clear).toHaveBeenCalledOnce()
    expect(f.connect).toHaveBeenCalledWith(f.backend, 'fixture-token')
  })

  it('reuses the prepared document without erasing its later application history', async () => {
    const f = fixture()
    f.prepare()
    await f.context.harnessPagePreparation
    await f.open(f.backend)
    expect(f.window.loadURL).toHaveBeenCalledOnce()
    expect(f.clear).toHaveBeenCalledOnce()
    expect(f.connect).toHaveBeenCalledOnce()
  })

  it('does not clear history for a superseded preload', async () => {
    const f = fixture()
    let finish: () => void = () => { throw new Error('Preload did not start') }
    f.window.loadURL.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    f.prepare()
    f.context.mainWindowNavigationVersion++
    finish()
    expect(await f.context.harnessPagePreparation).toBe(false)
    expect(f.clear).not.toHaveBeenCalled()
  })
})
