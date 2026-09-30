import type { UpdateLocale } from './update-view'

/**
 * Enterprise plugins such as dsh-better-sidebar pin their own diagnostic bar
 * to document.body and never remove it. The plugin package cannot be changed
 * or republished, so the host recognizes that exact diagnostic shape, removes
 * the bar, and re-renders its text in a host-owned toast.
 */
const PLUGIN_ERROR_PATTERN = /^\[[a-z0-9._-]+\]\s.+\serror:/i
const TOAST_LIFETIME_MS = 10_000

export interface PluginErrorToastController {
  relocate(document: Document): void
  dispose(): void
}

export function mountPluginErrorToast(
  document: Document,
  locale: UpdateLocale
): PluginErrorToastController {
  let host: HTMLDivElement | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  const hide = (): void => {
    clearTimer()
    host?.remove()
    host = undefined
  }

  const show = (message: string): void => {
    hide()
    host = document.createElement('div')
    host.dataset.dshErrorToast = ''
    host.setAttribute('role', 'status')
    host.setAttribute('aria-live', 'polite')
    host.style.cssText = [
      'position:fixed',
      'left:8px',
      'bottom:8px',
      'z-index:2147483646',
      'display:flex',
      'align-items:flex-start',
      'gap:12px',
      'box-sizing:border-box',
      'max-width:min(70vw,560px)',
      'padding:8px 8px 8px 12px',
      'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
      'color:var(--dsw-alias-state-error-primary,#f2a1a1)',
      'background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-base,#1b1b22))',
      'border:1px solid var(--dsw-alias-state-error-primary,#f2a1a1)',
      'border-radius:8px'
    ].join(';')

    const text = document.createElement('div')
    text.dataset.dshErrorToastMessage = ''
    text.style.cssText = 'min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text'
    text.textContent = message

    const close = document.createElement('button')
    close.type = 'button'
    close.dataset.dshErrorToastClose = ''
    close.setAttribute('aria-label', locale === 'zh' ? '关闭' : 'Close')
    close.style.cssText = [
      'flex:none',
      'width:24px',
      'height:24px',
      'padding:0',
      'border:0',
      'border-radius:6px',
      'background:transparent',
      'color:inherit',
      'font:16px/24px sans-serif',
      'cursor:pointer'
    ].join(';')
    close.textContent = '×'
    close.addEventListener('click', hide)

    host.append(text, close)
    document.body.appendChild(host)
    timer = setTimeout(hide, TOAST_LIFETIME_MS)
  }

  return {
    relocate(currentDocument: Document): void {
      const bars = [...currentDocument.body.children].filter(isPluginErrorBar)
      const latest = bars.at(-1)
      for (const bar of bars) bar.remove()
      const message = latest?.textContent?.trim()
      if (message) show(message)
    },
    dispose: hide
  }
}

function isPluginErrorBar(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false
  if (element.dataset.dshErrorToast !== undefined) return false
  const position = element.style.position.toLowerCase()
  const message = element.textContent?.trim() ?? ''
  return position === 'fixed' && PLUGIN_ERROR_PATTERN.test(message)
}
