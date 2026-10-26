// @vitest-environment jsdom
// @vitest-environment-options {"url":"file:///desktop/plugin-recovery.html"}
import { expect, it, vi } from 'vitest'
import { mountWindowsTitlebarLayout } from '../src/preload/windows-titlebar'

it('reserves the caption row on standalone recovery pages before mounting menus', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn() }))
  document.body.innerHTML = '<div class="shell"><header>DSH Desktop</header></div>'
  mountWindowsTitlebarLayout({ document, ipcRenderer: { invoke: vi.fn(async () => undefined) } })
  expect(document.body.hasAttribute('data-dsh-standalone-titlebar')).toBe(true)
  expect(getComputedStyle(document.body).paddingTop).toBe('40px')
  expect(document.querySelector('[data-dsh-windows-menu]')).not.toBeNull()
  const shell = document.querySelector<HTMLElement>('.shell')
  if (!shell) throw new Error('standalone shell missing')
  expect(getComputedStyle(shell).height).toBe('100%')
  vi.unstubAllGlobals()
})
