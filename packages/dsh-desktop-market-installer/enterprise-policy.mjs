/**
 * This repository ships the enterprise edition only. Community plugin
 * install and update stay closed even when the user is offline or signed out.
 */
export const ENTERPRISE_CAPABILITY_POLICY = Object.freeze({
  communityPluginInstall: false
})

export function communityPluginInstallAllowed() {
  return ENTERPRISE_CAPABILITY_POLICY.communityPluginInstall === true
}

const PROTECTED_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  'dsh-desktop-log-bridge',
  'dsh-desktop-client-ui',
  'dsh-desktop-enterprise',
  'dsh-desktop-market-installer',
  'dsh-image-generation',
  'dsh-ppt',
  'dsh-ppt-composer',
  'dsh-desktop-hmr-fallback',
  'dsh-desktop-preset-transfer',
  'dsh-desktop-workbenches',
  'dsh-desktop-onboarding',
  'dsh-desktop-office'
])

export function isProtectedProfileBundle(name) {
  return PROTECTED_BUNDLES.has(name)
}

/** Preserve enterprise admission at the official Plugin Manager's new backend seam. */
export function restrictCommunityPackageBackend(backend) {
  return {
    ...backend,
    async install(request) {
      if (!communityPluginInstallAllowed()) {
        throw new Error('POLICY_DISABLED: use the enterprise plugin market to install and update plugins.')
      }
      return backend.install(request)
    },
    async switched(request) {
      if (request.enabled && !communityPluginInstallAllowed() && !isProtectedProfileBundle(request.name)) {
        throw new Error('POLICY_DISABLED: community plugins cannot be re-enabled in the enterprise edition.')
      }
      return backend.switched(request)
    }
  }
}
