/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountPluginErrorToast } from '../src/preload/plugin-error-toast'

function createDocument(): Document {
  document.body.replaceChildren()
  return document
}

function appendPluginError(document: Document, message: string): HTMLDivElement {
  const bar = document.createElement('div')
  bar.style.cssText = 'position:fixed;left:8px;bottom:8px'
  bar.textContent = message
  document.body.appendChild(bar)
  return bar
}

describe('desktop plugin error toast', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('moves a plugin diagnostic bar into a dismissible desktop toast', () => {
    const document = createDocument()
    const message = '[dsh-better-sidebar] interception error: list slot requires options.id'
    const bar = appendPluginError(document, message)
    const toast = mountPluginErrorToast(document, 'zh')

    toast.relocate(document)

    expect(bar.isConnected).toBe(false)
    const host = document.querySelector<HTMLElement>('[data-dsh-error-toast]')
    expect(host?.getAttribute('role')).toBe('status')
    expect(host?.getAttribute('aria-live')).toBe('polite')
    expect(document.querySelector('[data-dsh-error-toast-message]')?.textContent).toBe(message)
    expect(document.querySelector('[data-dsh-error-toast-close]')?.getAttribute('aria-label')).toBe('关闭')
  })

  it('removes the toast immediately when its close button is clicked', () => {
    vi.useFakeTimers()
    const document = createDocument()
    appendPluginError(document, '[example.plugin] activation error: failed')
    const toast = mountPluginErrorToast(document, 'en')
    toast.relocate(document)

    document.querySelector<HTMLButtonElement>('[data-dsh-error-toast-close]')?.click()

    expect(document.querySelector('[data-dsh-error-toast]')).toBeNull()
    vi.advanceTimersByTime(10_000)
    expect(document.querySelector('[data-dsh-error-toast]')).toBeNull()
  })

  it('removes the toast automatically after ten seconds', () => {
    vi.useFakeTimers()
    const document = createDocument()
    appendPluginError(document, '[example.plugin] activation error: failed')
    const toast = mountPluginErrorToast(document, 'en')
    toast.relocate(document)

    vi.advanceTimersByTime(9_999)
    expect(document.querySelector('[data-dsh-error-toast]')).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(document.querySelector('[data-dsh-error-toast]')).toBeNull()
  })

  it('replaces an older toast and restarts its lifetime', () => {
    vi.useFakeTimers()
    const document = createDocument()
    appendPluginError(document, '[example.plugin] first error: one')
    const toast = mountPluginErrorToast(document, 'en')
    toast.relocate(document)
    vi.advanceTimersByTime(9_000)

    appendPluginError(document, '[example.plugin] second error: two')
    toast.relocate(document)

    expect(document.querySelectorAll('[data-dsh-error-toast]')).toHaveLength(1)
    expect(document.querySelector('[data-dsh-error-toast-message]')?.textContent).toContain('second error')
    vi.advanceTimersByTime(9_999)
    expect(document.querySelector('[data-dsh-error-toast]')).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(document.querySelector('[data-dsh-error-toast]')).toBeNull()
  })

  it('ignores unrelated fixed elements and clears its timer on dispose', () => {
    vi.useFakeTimers()
    const document = createDocument()
    const unrelated = document.createElement('div')
    unrelated.style.position = 'fixed'
    unrelated.textContent = 'Ordinary fixed content'
    document.body.appendChild(unrelated)
    appendPluginError(document, '[example.plugin] activation error: failed')
    const toast = mountPluginErrorToast(document, 'en')
    toast.relocate(document)

    toast.dispose()
    vi.advanceTimersByTime(10_000)

    expect(unrelated.isConnected).toBe(true)
    expect(document.querySelector('[data-dsh-error-toast]')).toBeNull()
  })
})
