import { pathToFileURL } from 'node:url'
import { isAbortedNavigationError } from './window-navigation'

const navigationOwners = new WeakMap<NavigationTarget, (url: string, cancelled: () => boolean) => Promise<boolean>>()

export function registerNavigationOwner(target: NavigationTarget, navigate: (url: string, cancelled: () => boolean) => Promise<boolean>): () => void {
  navigationOwners.set(target, navigate)
  return () => { navigationOwners.delete(target) }
}

export interface NavigationTarget {
  isDestroyed(): boolean
  loadURL(url: string): Promise<void>
}

export interface ShellNavigationTarget extends NavigationTarget {
  webContents: { navigationHistory: { clear(): void } }
}

export function isCancelledNavigation(error: unknown): boolean {
  return isAbortedNavigationError(error) ||
    (error instanceof Error && 'code' in error && error.code === -3)
}

/** Preserve ordinary Back/Forward history; lifecycle replacements opt in separately. */
export async function navigateDesktopWindow(
  target: NavigationTarget,
  url: string,
  cancelled: () => boolean
): Promise<boolean> {
  if (cancelled() || target.isDestroyed()) return false
  try {
    const owner = navigationOwners.get(target)
    if (owner) {
      if (!await owner(url, cancelled)) return false
    } else await target.loadURL(url)
  } catch (error) {
    if (cancelled() || target.isDestroyed() || isCancelledNavigation(error)) return false
    throw error
  }
  return !cancelled() && !target.isDestroyed()
}

/**
 * Discard obsolete startup/import/recovery history after a shell replacement.
 * Native Back must not restore a static page that cannot restart main (#612).
 * Ordinary routes use navigateDesktopWindow and retain their history.
 */
export async function replaceDesktopWindowPage(
  target: ShellNavigationTarget,
  url: string,
  cancelled: () => boolean
): Promise<boolean> {
  if (!await navigateDesktopWindow(target, url, cancelled)) return false
  // A newer navigation or shutdown can take ownership between continuations.
  if (cancelled() || target.isDestroyed()) return false
  target.webContents.navigationHistory.clear()
  return true
}

export function desktopFileUrl(filePath: string, query: Record<string, string> = {}): string {
  const url = pathToFileURL(filePath)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return url.href
}
